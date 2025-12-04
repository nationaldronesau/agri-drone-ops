"""Prediction router for SAM3 service."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional, Tuple
import logging
import hashlib

from ..sam3_predictor import get_predictor
from ..utils import fetch_image, mask_to_polygon, mask_to_bbox

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["predict"])


class ClickPoint(BaseModel):
    """Single click point with foreground/background label."""
    x: int = Field(..., description="X pixel coordinate")
    y: int = Field(..., description="Y pixel coordinate")
    label: int = Field(..., ge=0, le=1, description="0=background, 1=foreground")


class PredictRequest(BaseModel):
    """Request body for prediction."""
    imageUrl: str = Field(..., description="URL to fetch image from (S3 signed URL)")
    assetId: str = Field(..., description="Asset ID for caching")
    points: List[ClickPoint] = Field(..., min_length=1, description="Click points")
    simplifyTolerance: float = Field(0.02, description="Polygon simplification factor")


class PredictResponse(BaseModel):
    """Response from prediction."""
    success: bool
    score: float = Field(..., description="Confidence score 0-1")
    polygon: Optional[List[List[int]]] = Field(None, description="Simplified polygon [[x,y], ...]")
    bbox: Optional[List[int]] = Field(None, description="Bounding box [x1, y1, x2, y2]")
    processingTimeMs: float
    device: str
    message: Optional[str] = None


@router.post("/predict", response_model=PredictResponse)
async def predict(request: PredictRequest):
    """
    Run SAM3 prediction with click points.

    Takes an image URL and click points, returns a simplified polygon
    representing the segmented object.

    Note: Large images (>2048px) are automatically resized to prevent GPU OOM.
    Point coordinates should be in original image space - they will be scaled
    internally, and output coordinates are scaled back to original space.
    """
    predictor = get_predictor()

    # Ensure model is loaded
    if not predictor.model_loaded:
        logger.info("Model not loaded, loading now...")
        if not predictor.load_model():
            raise HTTPException(
                status_code=503,
                detail="Failed to load SAM3 model"
            )

    # Fetch image if not already cached
    image_id = request.assetId
    scale_factor = 1.0

    # Check if we need to load a new image
    if predictor._current_image_id != image_id:
        logger.info(f"Fetching new image for asset: {image_id}")

        image_bytes = await fetch_image(request.imageUrl)
        if image_bytes is None:
            raise HTTPException(
                status_code=400,
                detail="Failed to fetch image from URL"
            )

        success, scale_factor = predictor.set_image_from_bytes(image_bytes, image_id)
        if not success:
            raise HTTPException(
                status_code=500,
                detail="Failed to set image for segmentation"
            )
    else:
        # Image already loaded, get cached scale factor
        scale_factor = predictor.get_scale_factor()

    # Scale point coordinates to resized image space
    scaled_points = [
        {"x": int(p.x * scale_factor), "y": int(p.y * scale_factor), "label": p.label}
        for p in request.points
    ]

    # Run prediction with scaled points
    mask, score, metadata = predictor.predict(scaled_points)

    if mask is None:
        error_msg = metadata.get("error", "Unknown prediction error")
        raise HTTPException(
            status_code=500,
            detail=f"Prediction failed: {error_msg}"
        )

    # Convert mask to polygon (in resized image coordinates)
    polygon = mask_to_polygon(
        mask,
        simplify_tolerance=request.simplifyTolerance
    )

    # Get bounding box (in resized image coordinates)
    bbox = mask_to_bbox(mask)

    # Scale polygon and bbox back to original image coordinates
    if scale_factor != 1.0:
        inverse_scale = 1.0 / scale_factor
        if polygon:
            polygon = [[int(x * inverse_scale), int(y * inverse_scale)] for x, y in polygon]
        if bbox:
            bbox = [int(coord * inverse_scale) for coord in bbox]

    return PredictResponse(
        success=True,
        score=score,
        polygon=polygon,
        bbox=bbox,
        processingTimeMs=metadata.get("processing_time_ms", 0),
        device=metadata.get("device", "unknown"),
        message=f"Segmentation complete with {metadata.get('points_used', 0)} points (scale: {scale_factor:.3f})"
    )


@router.post("/preload")
async def preload_image(imageUrl: str, assetId: str):
    """
    Preload an image into the model cache.

    This is useful for reducing latency on the first click by
    loading the image before the user starts clicking.
    """
    predictor = get_predictor()

    # Ensure model is loaded
    if not predictor.model_loaded:
        if not predictor.load_model():
            raise HTTPException(
                status_code=503,
                detail="Failed to load SAM3 model"
            )

    # Skip if already loaded
    if predictor._current_image_id == assetId:
        return {
            "success": True,
            "cached": True,
            "message": "Image already loaded"
        }

    # Fetch and load image
    image_bytes = await fetch_image(imageUrl)
    if image_bytes is None:
        raise HTTPException(
            status_code=400,
            detail="Failed to fetch image from URL"
        )

    if not predictor.set_image_from_bytes(image_bytes, assetId):
        raise HTTPException(
            status_code=500,
            detail="Failed to preload image"
        )

    return {
        "success": True,
        "cached": False,
        "message": f"Image {assetId} preloaded successfully"
    }
