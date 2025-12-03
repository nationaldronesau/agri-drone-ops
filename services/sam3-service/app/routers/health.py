"""Health check router for SAM3 service."""
from fastapi import APIRouter
import time
import logging

from ..sam3_predictor import get_predictor
from ..config import get_device

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["health"])


@router.get("/health")
async def health_check():
    """
    Health check endpoint.

    Returns service status, device info, and model availability.
    """
    predictor = get_predictor()
    device = get_device()

    # Determine mode based on device and model status
    if predictor.model_loaded:
        if device in ("cuda", "mps"):
            mode = "realtime"
            latency_estimate = 500  # ~500ms with GPU
        else:
            mode = "degraded"
            latency_estimate = 8000  # ~8s on CPU
    else:
        mode = "loading"
        latency_estimate = None

    return {
        "available": predictor.model_loaded,
        "mode": mode,
        "device": device,
        "latencyMs": latency_estimate,
        "modelLoadTimeMs": predictor.load_time_ms,
    }


@router.get("/ready")
async def readiness_check():
    """
    Readiness check for Kubernetes/Docker health checks.

    Returns 200 only if model is loaded and ready to serve.
    """
    predictor = get_predictor()

    if not predictor.model_loaded:
        return {
            "ready": False,
            "message": "Model not yet loaded"
        }

    return {
        "ready": True,
        "device": get_device(),
        "currentImageId": predictor._current_image_id,
    }


@router.get("/status")
async def detailed_status():
    """
    Detailed status for debugging and monitoring.
    """
    predictor = get_predictor()

    return {
        "predictor": predictor.get_status(),
        "device": get_device(),
        "settings": {
            "hf_token_set": bool(predictor.settings.hf_token),
        }
    }
