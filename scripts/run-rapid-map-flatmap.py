#!/usr/bin/env python3
"""Adapt AgriDrone Rapid Map jobs to the flat-map-runner CLI."""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import rasterio
from rasterio.warp import transform_bounds


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".tif", ".tiff", ".png", ".dng"}
ARTIFACTS = [
    ("flat-footprint-mosaic.tif", "geotiff", "image/tiff", "rapid-map.tif"),
    ("flat-footprint-mosaic-overlay.png", "overlay", "image/png", "overlay.png"),
    ("flat-map-footprints.geojson", "metadata", "application/geo+json", "footprints.geojson"),
    ("flat-map-images.csv", "metadata", "text/csv; charset=utf-8", "images.csv"),
    ("flat-map-artifacts-input.json", "metadata", "application/json", "runner-input.json"),
    ("run-summary.json", "summary", "application/json", "run-summary.json"),
    ("basemap-viewer.html", "other", "text/html; charset=utf-8", "basemap-viewer.html"),
]


def run(command: list[str], cwd: Path | None = None) -> None:
    print("+", " ".join(str(part) for part in command), flush=True)
    subprocess.run([str(part) for part in command], cwd=cwd, check=True)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def ensure_directory(path: Path, label: str) -> Path:
    if not path.exists() or not path.is_dir():
        raise SystemExit(f"{label} does not exist or is not a directory: {path}")
    return path


def require_aws_cli() -> None:
    if not shutil.which("aws"):
        raise SystemExit("AWS CLI is required for S3 Rapid Map sources.")


def sync_s3_prefix(bucket: str, prefix: str, destination: Path) -> Path:
    require_aws_cli()
    destination.mkdir(parents=True, exist_ok=True)
    run(
        [
            "aws",
            "s3",
            "sync",
            f"s3://{bucket}/{prefix.rstrip('/')}",
            str(destination),
            "--exclude",
            "*",
            "--include",
            "*.JPG",
            "--include",
            "*.JPEG",
            "--include",
            "*.jpg",
            "--include",
            "*.jpeg",
            "--include",
            "*.TIF",
            "--include",
            "*.TIFF",
            "--include",
            "*.tif",
            "--include",
            "*.tiff",
            "--include",
            "*.DNG",
            "--include",
            "*.dng",
            "--include",
            "metadata.csv",
        ]
    )
    return destination


def download_asset_set(bucket: str, asset_objects: Any, destination: Path) -> Path:
    require_aws_cli()
    if not isinstance(asset_objects, list) or not asset_objects:
        raise SystemExit("ASSET_SET Rapid Map source requires a non-empty assetObjects array.")

    destination.mkdir(parents=True, exist_ok=True)
    filenames: set[str] = set()
    for index, asset_object in enumerate(asset_objects):
        if not isinstance(asset_object, dict):
            raise SystemExit(f"ASSET_SET assetObjects[{index}] must be an object.")

        s3_key = asset_object.get("s3Key")
        filename = asset_object.get("filename")
        if not isinstance(s3_key, str) or not s3_key.strip():
            raise SystemExit(f"ASSET_SET assetObjects[{index}] requires s3Key.")
        if not isinstance(filename, str) or not filename.strip():
            raise SystemExit(f"ASSET_SET assetObjects[{index}] requires filename.")
        if Path(filename).name != filename:
            raise SystemExit(f"ASSET_SET assetObjects[{index}] filename must be a basename.")
        if filename in filenames:
            raise SystemExit(f"ASSET_SET contains duplicate filename: {filename}")

        filenames.add(filename)
        run(["aws", "s3", "cp", f"s3://{bucket}/{s3_key.lstrip('/')}", str(destination / filename)])

    return destination


def discover_input_paths(source_root: Path) -> tuple[Path, Path]:
    metadata_candidates = [
        source_root / "metadata.csv",
        source_root / "images" / "metadata.csv",
    ]
    metadata = next((path for path in metadata_candidates if path.exists()), None)
    if metadata is None:
        matches = list(source_root.rglob("metadata.csv"))
        metadata = matches[0] if matches else None

    if metadata is None:
        raise SystemExit(f"No metadata.csv found under {source_root}")

    image_dirs = [metadata.parent, source_root / "images", source_root]
    image_dir = next(
        (
            directory
            for directory in image_dirs
            if directory.exists()
            and any(path.suffix.lower() in IMAGE_EXTENSIONS for path in directory.rglob("*"))
        ),
        None,
    )

    if image_dir is None:
        raise SystemExit(f"No source images found under {source_root}")

    return image_dir, metadata


def resolve_source(job: dict[str, Any], workspace: Path) -> tuple[Path, Path]:
    source = job.get("source") or {}
    source_type = source.get("type")
    source_path = source.get("sourcePath")

    if source_type == "S3_PREFIX":
        bucket = source.get("sourceBucket") or job.get("output", {}).get("bucket")
        if not bucket or not source_path:
            raise SystemExit("S3 Rapid Map source requires sourceBucket and sourcePath.")
        return discover_input_paths(sync_s3_prefix(bucket, source_path, workspace / "input"))

    if source_type == "ASSET_SET":
        bucket = source.get("sourceBucket") or job.get("output", {}).get("bucket")
        metadata_path = source.get("metadataCsvPath")
        if not bucket:
            raise SystemExit("ASSET_SET Rapid Map source requires sourceBucket.")
        if not isinstance(metadata_path, str) or not metadata_path:
            raise SystemExit("ASSET_SET Rapid Map source requires metadataCsvPath.")

        metadata_csv = Path(metadata_path).expanduser().resolve()
        if not metadata_csv.exists() or not metadata_csv.is_file():
            raise SystemExit(f"ASSET_SET metadata.csv does not exist: {metadata_csv}")

        image_dir = download_asset_set(bucket, source.get("assetObjects"), workspace / "input")
        return image_dir, metadata_csv

    if source_type == "PROCESSING_NODE_PATH":
        if not source_path:
            raise SystemExit("Processing-node Rapid Map source requires sourcePath.")
        return discover_input_paths(ensure_directory(Path(source_path).expanduser().resolve(), "Source path"))

    raise SystemExit(f"Unsupported Rapid Map source type for flat-map-runner: {source_type}")


def number(value: Any, default: float) -> float:
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return default


def integer(value: Any, default: int) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return int(value)
    return default


def optional_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def count(value: Any) -> int:
    return integer(value, 0)


def config_value(config: dict[str, Any], key: str, default: Any) -> Any:
    value = config.get(key)
    if value is not None:
        return value
    runner = config.get("runner")
    if isinstance(runner, dict):
        return runner.get(key, default)
    return default


def raster_metadata(path: Path) -> dict[str, Any]:
    with rasterio.open(path) as dataset:
        bounds = dataset.bounds
        if dataset.crs:
            west, south, east, north = transform_bounds(
                dataset.crs,
                "EPSG:4326",
                bounds.left,
                bounds.bottom,
                bounds.right,
                bounds.top,
                densify_pts=21,
            )
            crs = dataset.crs.to_string()
        else:
            west, south, east, north = bounds.left, bounds.bottom, bounds.right, bounds.top
            crs = None

        return {
            "bounds": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [west, south],
                        [east, south],
                        [east, north],
                        [west, north],
                        [west, south],
                    ]
                ],
            },
            "centerLat": (south + north) / 2,
            "centerLon": (west + east) / 2,
            "rasterWidth": dataset.width,
            "rasterHeight": dataset.height,
            "crs": crs,
            "affineTransform": list(dataset.transform)[:6],
            "nodataValues": list(dataset.nodatavals or []),
        }


def build_manifest(output_dir: Path, job: dict[str, Any]) -> dict[str, Any]:
    summary_path = output_dir / "run-summary.json"
    summary = load_json(summary_path) if summary_path.exists() else {}
    mosaic_manifest_path = output_dir / "flat-footprint-mosaic.manifest.json"
    mosaic_manifest = load_json(mosaic_manifest_path) if mosaic_manifest_path.exists() else {}
    mosaic_path = output_dir / "flat-footprint-mosaic.tif"
    raster = raster_metadata(mosaic_path) if mosaic_path.exists() else {}
    config = job.get("config") if isinstance(job.get("config"), dict) else {}

    artifacts = []
    for file_name, role, content_type, target_key in ARTIFACTS:
        if (output_dir / file_name).exists():
            artifacts.append(
                {
                    "path": file_name,
                    "role": role,
                    "contentType": content_type,
                    "targetKey": target_key,
                }
            )

    image_count = summary.get("image_count")
    missing_count = count(summary.get("missing_metadata_images"))
    pitch_filtered_count = count(summary.get("pitch_filtered_images"))
    rendered_count = count(mosaic_manifest.get("rendered_count"))
    skipped_count = count(mosaic_manifest.get("skipped_count"))
    pixel_size = optional_number(mosaic_manifest.get("pixel_size"))
    resolution_cm = pixel_size * 100 if pixel_size is not None else None
    skipped = mosaic_manifest.get("skipped")
    if not isinstance(skipped, list):
        skipped = []

    return {
        "version": 1,
        "summary": {
            "sourceImageCount": image_count,
            "renderedImageCount": rendered_count,
            "excludedImageCount": missing_count + pitch_filtered_count + skipped_count,
            "gpsOutlierCount": count(mosaic_manifest.get("gps_outlier_count")),
            "pitchFilteredCount": pitch_filtered_count,
            "elapsedSeconds": optional_number(mosaic_manifest.get("elapsed_seconds")),
            "targetEpsg": summary.get("target_epsg"),
            "blend": summary.get("blend"),
            "skipped": skipped[:50],
            "estimatedErrorMeters": config_value(config, "estimatedErrorMeters", None),
            "rasterWidth": raster.get("rasterWidth"),
            "rasterHeight": raster.get("rasterHeight"),
            "bounds": raster.get("bounds"),
        },
        "artifacts": artifacts,
        "orthomosaic": {
            "name": job.get("name") or f"Rapid Map {job.get('runId', '')[:8]}",
            "description": job.get("description") or "Generated by Rapid Map processing",
            "bounds": raster.get("bounds"),
            "centerLat": raster.get("centerLat"),
            "centerLon": raster.get("centerLon"),
            "resolutionCmPerPixel": resolution_cm,
            "imageCount": rendered_count,
            "rasterWidth": raster.get("rasterWidth"),
            "rasterHeight": raster.get("rasterHeight"),
            "crs": raster.get("crs"),
            "affineTransform": raster.get("affineTransform"),
            "nodataValues": raster.get("nodataValues"),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run flat-map-runner for an AgriDrone Rapid Map job")
    parser.add_argument("--job", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    job_path = Path(args.job).resolve()
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    workspace = output_dir.parent
    job = load_json(job_path)
    config = job.get("config") if isinstance(job.get("config"), dict) else {}

    flat_map_dir = Path(os.environ.get("FLAT_MAP_RUNNER_DIR", "/opt/flat-map-runner")).resolve()
    flat_map_python = os.environ.get("FLAT_MAP_PYTHON") or os.environ.get("PYTHON", "python3")
    flat_map_script = flat_map_dir / "scripts" / "run-flat-map-test.py"
    if not flat_map_script.exists():
        raise SystemExit(f"flat-map-runner script not found: {flat_map_script}")

    image_dir, metadata_csv = resolve_source(job, workspace)
    pixel_size = number(config_value(config, "pixelSizeM", 0.3), 0.3)
    feather_px = integer(config_value(config, "featherPx", 32), 32)
    max_source_px = integer(config_value(config, "maxSourcePx", 1024), 1024)
    preview_max_size = integer(config_value(config, "previewMaxSize", 4000), 4000)
    target_epsg = str(config_value(config, "targetEpsg", "auto"))
    nadir_pitch_tolerance = number(config_value(config, "nadirPitchToleranceDeg", 15), 15)
    blend = str(config_value(config, "blend", "center"))
    workers = integer(config_value(config, "workers", 0), 0)
    max_offset_km = number(config_value(config, "maxOffsetKm", 10), 10)
    max_raster_px = integer(config_value(config, "maxRasterPx", 250_000_000), 250_000_000)
    cog = bool(config_value(config, "cog", True))
    image_orientation_policy = str(config_value(config, "imageOrientationPolicy", "flipv"))
    yaw_offset_deg = number(config_value(config, "yawOffsetDeg", 0), 0)

    command = [
        flat_map_python,
        str(flat_map_script),
        "--images",
        str(image_dir),
        "--metadata",
        str(metadata_csv),
        "--output-dir",
        str(output_dir),
        "--target-epsg",
        target_epsg,
        "--pixel-size",
        str(pixel_size),
        "--feather-px",
        str(feather_px),
        "--max-source-px",
        str(max_source_px),
        "--preview-max-size",
        str(preview_max_size),
        "--nadir-pitch-tolerance",
        str(nadir_pitch_tolerance),
        "--blend",
        blend,
        "--workers",
        str(workers),
        "--max-offset-km",
        str(max_offset_km),
        "--max-raster-px",
        str(max_raster_px),
        "--image-orientation-policy",
        image_orientation_policy,
        "--yaw-offset-deg",
        str(yaw_offset_deg),
        "--python",
        flat_map_python,
    ]

    if cog:
        command.append("--cog")

    run(command)
    (output_dir / "manifest.json").write_text(json.dumps(build_manifest(output_dir, job), indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
