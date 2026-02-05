"""YOLO inference router for SAM3 service."""
from __future__ import annotations

import base64
import io
import logging
import os
import tempfile
import time
from typing import Optional

import boto3
import torch
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from PIL import Image
from ultralytics import YOLO

from ..sam3_predictor import get_predictor
from .segment import unload_model as unload_segment_model

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/yolo", tags=["yolo"])

current_model: Optional[YOLO] = None
current_model_id: Optional[str] = None


def parse_s3_path(path: str) -> tuple[str, str]:
    if not path.startswith("s3://"):
        raise ValueError("Invalid S3 path")
    without_scheme = path.replace("s3://", "", 1)
    bucket, _, key = without_scheme.partition("/")
    if not bucket or not key:
        raise ValueError("Invalid S3 path")
    return bucket, key


def resolve_model_s3_location(model_id: str) -> tuple[str, str]:
    if model_id.startswith("s3://"):
        return parse_s3_path(model_id)

    bucket = os.getenv("AWS_S3_BUCKET") or os.getenv("S3_BUCKET")
    if not bucket:
        raise ValueError("AWS_S3_BUCKET not configured")

    key = model_id
    if "/" not in key:
        key = f"models/{model_id}/best.pt"
    if not key.endswith(".pt"):
        key = key.rstrip("/") + "/best.pt"

    return bucket, key


def download_weights(model_id: str) -> str:
    bucket, key = resolve_model_s3_location(model_id)
    logger.info("Downloading YOLO weights from s3://%s/%s", bucket, key)

    s3 = boto3.client("s3")
    _, extension = os.path.splitext(key)
    suffix = extension if extension else ".pt"

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_file:
        s3.download_fileobj(bucket, key, tmp_file)
        return tmp_file.name


def decode_image(image_b64: str) -> Image.Image:
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]
    image_bytes = base64.b64decode(image_b64)
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


def unload_current_model() -> None:
    global current_model, current_model_id
    if current_model is None:
        return
    current_model = None
    current_model_id = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def ensure_sam3_unloaded() -> None:
    predictor = get_predictor()
    predictor.unload_model()
    unload_segment_model()


class DetectRequest(BaseModel):
    model_id: Optional[str] = None
    model: Optional[str] = None
    image: Optional[str] = None
    s3_path: Optional[str] = None
    confidence: float = 0.25
    iou_threshold: float = 0.45


class LoadRequest(BaseModel):
    model_id: str


@router.post("/load")
async def load_model(request: LoadRequest):
    """Load YOLO model weights from S3."""
    global current_model, current_model_id
    model_id = request.model_id
    if current_model is not None and current_model_id == model_id:
        return {"status": "loaded", "model_id": current_model_id}

    ensure_sam3_unloaded()
    unload_current_model()

    try:
        weights_path = download_weights(model_id)
        current_model = YOLO(weights_path)
        current_model_id = model_id
        return {"status": "loaded", "model_id": model_id}
    except Exception as exc:
        logger.error("Failed to load YOLO model: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to load YOLO model: {exc}")


@router.post("/unload")
async def unload_model():
    """Unload YOLO model to free GPU memory."""
    unload_current_model()
    return {"status": "unloaded"}


@router.get("/status")
async def status():
    """Get current YOLO inference status."""
    gpu_memory = None
    if torch.cuda.is_available():
        gpu_memory = torch.cuda.memory_allocated()
    return {
        "model_loaded": current_model is not None,
        "model_id": current_model_id,
        "gpu_memory": gpu_memory,
    }


@router.post("/detect")
async def detect(request: DetectRequest):
    """Run YOLO detection on an image."""
    global current_model, current_model_id

    model_id = request.model_id or request.model
    if not model_id:
        raise HTTPException(status_code=400, detail="model_id is required")

    if request.image is None and request.s3_path is None:
        raise HTTPException(status_code=400, detail="image or s3_path is required")

    if current_model is None or current_model_id != model_id:
        await load_model(LoadRequest(model_id=model_id))

    if current_model is None:
        raise HTTPException(status_code=500, detail="YOLO model not loaded")

    if request.s3_path:
        bucket, key = parse_s3_path(request.s3_path)
        s3 = boto3.client("s3")
        response = s3.get_object(Bucket=bucket, Key=key)
        image_data = response["Body"].read()
        image = Image.open(io.BytesIO(image_data)).convert("RGB")
    else:
        image = decode_image(request.image)

    start = time.time()
    results = current_model.predict(
        source=image,
        conf=request.confidence,
        iou=request.iou_threshold,
        verbose=False,
    )
    inference_time = (time.time() - start) * 1000

    detections = []
    result = results[0] if results else None
    if result is not None and hasattr(result, "boxes"):
        names = result.names or {}
        for box in result.boxes:
            xyxy = box.xyxy[0].tolist()
            conf = float(box.conf[0]) if hasattr(box, "conf") else 0.0
            cls_id = int(box.cls[0]) if hasattr(box, "cls") else -1
            class_name = names.get(cls_id, str(cls_id))
            detections.append({
                "class": class_name,
                "confidence": conf,
                "bbox": xyxy,
            })

    return {
        "detections": detections,
        "inference_time_ms": inference_time,
        "model_used": current_model_id or model_id,
    }
