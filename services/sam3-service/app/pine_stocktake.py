"""Pinned visual-only shared-canvas SAM3 inference for Pine Stocktake v1."""

from __future__ import annotations

import gc
import hashlib
import io
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import cv2
import numpy as np
from PIL import Image


MODEL_REPOSITORY = "facebook/sam3"
MODEL_REVISION = "3c879f39826c281e95690f02c7821c4de09afae7"
MODEL_WEIGHT_SHA256 = "6d06f0a5f84e435071fe6603e61d0b4cc7b40e0d39d487cfd4d67d8cc11cc14a"
METHOD = "pine-stocktake-v1"
CANVAS_SIZE = 1008
SUPPORT_HEIGHT = 252
QUERY_HEIGHT = CANVAS_SIZE - SUPPORT_HEIGHT
TILE_SIZE = 1024
STRIDE = 768
SCORE_THRESHOLD = 0.50
MASK_THRESHOLD = 0.50
AGREEMENT_IOU = 0.70


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_sha256(value: Any) -> str:
    import json

    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class NativeTile:
    tile_id: str
    x1: int
    y1: int
    x2: int
    y2: int

    @property
    def width(self) -> int:
        return self.x2 - self.x1

    @property
    def height(self) -> int:
        return self.y2 - self.y1


def axis_starts(length: int) -> list[int]:
    if length <= 0:
        raise ValueError("invalid native image dimension")
    if length <= TILE_SIZE:
        return [0]
    starts = list(range(0, length - TILE_SIZE + 1, STRIDE))
    final = length - TILE_SIZE
    if starts[-1] != final:
        starts.append(final)
    return starts


def native_tiles(width: int, height: int) -> list[NativeTile]:
    result = []
    for row, y1 in enumerate(axis_starts(height)):
        for column, x1 in enumerate(axis_starts(width)):
            result.append(NativeTile(f"T{row:02d}{column:02d}", x1, y1, min(width, x1 + TILE_SIZE), min(height, y1 + TILE_SIZE)))
    return result


def centre_crop_for_support(polygon: list[list[float]], image_size: tuple[int, int]) -> tuple[Rect, list[float]]:
    if len(polygon) < 3:
        raise ValueError("exemplar polygon is degenerate")
    width, height = image_size
    xs, ys = [float(point[0]) for point in polygon], [float(point[1]) for point in polygon]
    x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
    if not (0 <= x1 < x2 < width and 0 <= y1 < y2 < height):
        raise ValueError("exemplar polygon exceeds native source bounds")
    max_scale = min(CANVAS_SIZE / (x2 - x1), SUPPORT_HEIGHT / (y2 - y1), 1.0)
    crop_width = min(width, max(CANVAS_SIZE, int(np.ceil(CANVAS_SIZE / max_scale))))
    crop_height = min(height, max(SUPPORT_HEIGHT, int(np.ceil(SUPPORT_HEIGHT / max_scale))))
    left = min(max(round((x1 + x2 - crop_width) / 2), 0), width - crop_width)
    top = min(max(round((y1 + y2 - crop_height) / 2), 0), height - crop_height)
    crop = Rect(left, top, crop_width, crop_height)
    if not (left <= x1 and top <= y1 and left + crop_width >= x2 and top + crop_height >= y2):
        raise ValueError("support crop does not contain the full crown")
    prompt = [(x1 - left) * CANVAS_SIZE / crop_width, (y1 - top) * SUPPORT_HEIGHT / crop_height, (x2 - left) * CANVAS_SIZE / crop_width, (y2 - top) * SUPPORT_HEIGHT / crop_height]
    return crop, prompt


def canvas_for_tile(native: Image.Image, tile: NativeTile, support: Image.Image) -> Image.Image:
    query = native.crop((tile.x1, tile.y1, tile.x2, tile.y2))
    canvas = Image.new("RGB", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0))
    canvas.paste(support, (0, 0))
    canvas.paste(query.resize((CANVAS_SIZE, QUERY_HEIGHT), Image.Resampling.BILINEAR), (0, SUPPORT_HEIGHT))
    return canvas


def mask_polygon(mask: np.ndarray, tile: NativeTile) -> list[list[int]]:
    contours, _ = cv2.findContours(mask.astype(np.uint8) * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    contour = max(contours, key=cv2.contourArea)
    approx = cv2.approxPolyDP(contour, 2.0, True)
    return [[int(point[0][0]) + tile.x1, int(point[0][1]) + tile.y1] for point in approx]


def encode_mask_rle(mask: np.ndarray) -> dict[str, Any]:
    active = np.flatnonzero(mask.reshape(-1))
    runs: list[list[int]] = []
    for index in active:
        if runs and runs[-1][0] + runs[-1][1] == int(index):
            runs[-1][1] += 1
        else:
            runs.append([int(index), 1])
    return {"schema": "nd.agri.native-mask-rle.v1", "width": int(mask.shape[1]), "height": int(mask.shape[0]), "runs": runs}


def native_mask_iou(left: dict[str, Any], right: dict[str, Any]) -> float:
    lt, rt = left["_tile"], right["_tile"]
    lm, rm = left["_mask"], right["_mask"]
    ox1, oy1, ox2, oy2 = max(lt.x1, rt.x1), max(lt.y1, rt.y1), min(lt.x2, rt.x2), min(lt.y2, rt.y2)
    intersection = 0
    if ox1 < ox2 and oy1 < oy2:
        la = lm[oy1 - lt.y1 : oy2 - lt.y1, ox1 - lt.x1 : ox2 - lt.x1]
        ra = rm[oy1 - rt.y1 : oy2 - rt.y1, ox1 - rt.x1 : ox2 - rt.x1]
        intersection = int(np.logical_and(la, ra).sum())
    union = int(lm.sum()) + int(rm.sum()) - intersection
    return float(intersection / union) if union else 0.0


def fuse_per_exemplar(candidates: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    kept: list[dict[str, Any]] = []
    for candidate in sorted(candidates, key=lambda row: (-row["score"], row["candidateId"])):
        duplicate = next((item for item in kept if item["nativeTile"]["tileId"] != candidate["nativeTile"]["tileId"] and native_mask_iou(candidate, item) >= AGREEMENT_IOU), None)
        if duplicate is None:
            candidate["duplicateLineage"] = []
            kept.append(candidate)
        else:
            duplicate["duplicateLineage"].append(candidate["candidateId"])
    return kept


def agreement_groups(per_exemplar: dict[str, list[dict[str, Any]]], target_asset_id: str) -> list[dict[str, Any]]:
    if len(per_exemplar) != 3:
        raise ValueError("agreement requires three independent exemplar runs")
    groups: list[list[dict[str, Any]]] = []
    all_candidates = [candidate for exemplar_id in sorted(per_exemplar) for candidate in per_exemplar[exemplar_id]]
    for candidate in sorted(all_candidates, key=lambda row: (-row["score"], row["candidateId"])):
        best = None
        for group in groups:
            if any(item["exemplarId"] == candidate["exemplarId"] for item in group):
                continue
            iou = max(native_mask_iou(candidate, item) for item in group)
            if iou >= AGREEMENT_IOU and (best is None or iou > best[0]):
                best = (iou, group)
        if best is None:
            groups.append([candidate])
        else:
            best[1].append(candidate)
    result = []
    for index, members in enumerate(groups, 1):
        representative = sorted(members, key=lambda row: (-row["score"], row["candidateId"]))[0]
        result.append({
            "agreementId": f"{target_asset_id}-agreement-{index:06d}", "targetAssetId": target_asset_id,
            "representativeCandidateId": representative["candidateId"], "agreementLevel": len(members),
            "scoresByExemplar": {member["exemplarId"]: member["score"] for member in members},
            "nativePolygon": representative["nativePolygon"], "candidateIds": sorted(member["candidateId"] for member in members),
        })
    return result


class PinnedPineSam3:
    """Load only the sealed model revision from a verified local directory."""

    _lock = threading.Lock()

    def __init__(self) -> None:
        self.model = None
        self.processor = None
        self.device = None
        self.dtype = None

    @staticmethod
    def model_dir() -> Path:
        value = os.environ.get("PINE_SAM3_MODEL_DIR", "").strip()
        if not value:
            raise RuntimeError("PINE_SAM3_MODEL_DIR is required; fallback model loading is prohibited")
        model_dir = Path(value).resolve()
        if MODEL_REVISION not in str(model_dir):
            raise RuntimeError("SAM3 model directory does not identify the pinned revision")
        weight = model_dir / "model.safetensors"
        if not weight.is_file() or sha256_file(weight) != MODEL_WEIGHT_SHA256:
            raise RuntimeError("SAM3 weight hash drift")
        return model_dir

    def identity(self) -> dict[str, str]:
        model_dir = self.model_dir()
        return {"repository": MODEL_REPOSITORY, "revision": MODEL_REVISION, "weightSha256": MODEL_WEIGHT_SHA256, "method": METHOD, "modelDir": str(model_dir)}

    def load(self) -> None:
        if self.model is not None:
            return
        with self._lock:
            if self.model is not None:
                return
            import torch
            from transformers import Sam3Model, Sam3Processor

            model_dir = self.model_dir()
            self.device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
            self.dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
            self.model = Sam3Model.from_pretrained(str(model_dir), dtype=self.dtype).to(self.device).eval()
            self.processor = Sam3Processor.from_pretrained(str(model_dir))

    def unload(self) -> dict[str, Any]:
        """Release the pinned model so YOLO can take exclusive GPU ownership."""
        with self._lock:
            was_loaded = self.model is not None
            self.model = None
            self.processor = None
            self.device = None
            self.dtype = None
            gc.collect()
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
        return {"success": True, "message": "Pine SAM3 model unloaded", "wasLoaded": was_loaded}

    def run(self, targets: list[dict[str, Any]], exemplars: list[dict[str, Any]]) -> dict[str, Any]:
        import torch

        self.load()
        if len(exemplars) != 3 or any(not item.get("approved") for item in exemplars):
            raise ValueError("exactly three approved exemplars are required")
        inference_runs, candidates, groups = [], [], []
        for exemplar in exemplars:
            source_bytes = exemplar.pop("_bytes")
            if sha256_bytes(source_bytes) != exemplar["sourceImageSha256"]:
                raise ValueError("exemplar source image hash mismatch")
            with Image.open(io.BytesIO(source_bytes)) as source:
                reference = source.convert("RGB")
            crop, prompt = centre_crop_for_support(exemplar["nativePolygon"], reference.size)
            support = reference.crop((crop.x, crop.y, crop.x + crop.width, crop.y + crop.height)).resize((CANVAS_SIZE, SUPPORT_HEIGHT), Image.Resampling.BILINEAR)
            for target in targets:
                if target["assetId"] == exemplar["sourceAssetId"]:
                    raise ValueError("target-image annotations are forbidden as prompts")
                target_bytes = target["_bytes"]
                if sha256_bytes(target_bytes) != target["sha256"]:
                    raise ValueError("target image hash mismatch")
                with Image.open(io.BytesIO(target_bytes)) as source:
                    native = source.convert("RGB")
                run_key = stable_sha256({"method": METHOD, "target": target["sha256"], "exemplar": exemplar["exemplarSha256"]})
                run_candidates = []
                for tile in native_tiles(*native.size):
                    canvas = canvas_for_tile(native, tile, support)
                    inputs = self.processor(images=canvas, input_boxes=[[prompt]], input_boxes_labels=[[1]], return_tensors="pt").to(self.device, dtype=self.dtype)
                    with torch.inference_mode():
                        outputs = self.model(**inputs)
                    post = self.processor.post_process_instance_segmentation(outputs, threshold=SCORE_THRESHOLD, mask_threshold=MASK_THRESHOLD, target_sizes=inputs["original_sizes"].tolist())[0]
                    for ordinal, (score, box, value) in enumerate(zip(post["scores"], post["boxes"], post["masks"]), 1):
                        box_values = [float(item) for item in box]
                        centre_x, centre_y = (box_values[0] + box_values[2]) / 2, (box_values[1] + box_values[3]) / 2
                        if not (0 <= centre_x < CANVAS_SIZE and SUPPORT_HEIGHT <= centre_y < CANVAS_SIZE):
                            continue
                        mask = value.detach().cpu().numpy() if hasattr(value, "detach") else np.asarray(value)
                        while mask.ndim > 2:
                            mask = mask[0]
                        query_mask = mask[SUPPORT_HEIGHT:CANVAS_SIZE, 0:CANVAS_SIZE]
                        native_mask = cv2.resize(query_mask.astype(np.uint8), (tile.width, tile.height), interpolation=cv2.INTER_NEAREST).astype(bool)
                        polygon = mask_polygon(native_mask, tile)
                        if len(polygon) < 3:
                            continue
                        ys, xs = np.nonzero(native_mask)
                        candidate_id = stable_sha256({"run": run_key, "tile": tile.tile_id, "ordinal": ordinal})[:32]
                        row = {
                            "candidateId": candidate_id, "inferenceRunKey": run_key, "exemplarId": exemplar["id"],
                            "targetAssetId": target["assetId"], "targetImageSha256": target["sha256"], "score": float(score),
                            "nativeTile": {"tileId": tile.tile_id, "x1": tile.x1, "y1": tile.y1, "x2": tile.x2, "y2": tile.y2, "width": tile.width, "height": tile.height, "partial": tile.width < TILE_SIZE or tile.height < TILE_SIZE},
                            "nativeBbox": [int(xs.min()) + tile.x1, int(ys.min()) + tile.y1, int(xs.max()) + 1 + tile.x1, int(ys.max()) + 1 + tile.y1],
                            "nativePolygon": polygon, "maskEncoding": encode_mask_rle(native_mask),
                            "modelResultSha256": stable_sha256({"candidateId": candidate_id, "score": float(score), "polygon": polygon}),
                            "_mask": native_mask, "_tile": tile,
                        }
                        run_candidates.append(row)
                fused = fuse_per_exemplar(run_candidates)
                candidates.extend(fused)
                inference_runs.append({"idempotencyKey": run_key, "exemplarId": exemplar["id"], "targetAssetId": target["assetId"], "nativeTileManifest": [{"tileId": tile.tile_id, "xyxy": [tile.x1, tile.y1, tile.x2, tile.y2]} for tile in native_tiles(*native.size)], "candidateIds": [item["candidateId"] for item in fused]})
        for target in targets:
            separated = {exemplar["id"]: [item for item in candidates if item["targetAssetId"] == target["assetId"] and item["exemplarId"] == exemplar["id"]] for exemplar in exemplars}
            groups.extend(agreement_groups(separated, target["assetId"]))
        serializable = [{key: value for key, value in item.items() if not key.startswith("_")} for item in candidates]
        return {"schema": "nd.agri.pine-stocktake.sam3-result.v1", "model": self.identity(), "inferenceRuns": inference_runs, "candidates": serializable, "agreementGroups": groups, "processed": len(targets)}


pine_sam3 = PinnedPineSam3()
