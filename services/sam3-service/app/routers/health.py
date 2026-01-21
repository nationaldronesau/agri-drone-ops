"""Health check router for SAM3 service."""
from fastapi import APIRouter
import time
import logging

from ..sam3_predictor import get_predictor
from ..config import get_device
from .segment import unload_model as unload_segment_model

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


@router.post("/warmup")
async def warmup_model():
    """
    Warm up the SAM3 model by loading it into memory.

    This is called after instance start to ensure the model is loaded
    and ready for predictions before user requests arrive.
    """
    predictor = get_predictor()
    start_time = time.time()

    if predictor.model_loaded:
        return {
            "success": True,
            "message": "Model already loaded",
            "load_time_ms": predictor.load_time_ms,
            "device": get_device(),
        }

    logger.info("Warming up SAM3 model...")
    success = predictor.load_model()

    if not success:
        logger.error("Failed to warm up model")
        return {
            "success": False,
            "message": "Failed to load model",
            "device": get_device(),
        }

    warmup_time_ms = (time.time() - start_time) * 1000
    logger.info(f"Model warmed up in {warmup_time_ms:.0f}ms")

    return {
        "success": True,
        "message": "Model loaded successfully",
        "load_time_ms": predictor.load_time_ms,
        "warmup_time_ms": warmup_time_ms,
        "device": get_device(),
    }


@router.post("/unload")
async def unload_model():
    """
    Unload SAM3 models to free GPU memory for YOLO training.
    """
    predictor = get_predictor()
    predictor_result = predictor.unload_model()
    segment_result = unload_segment_model()

    success = predictor_result.get("success") and segment_result.get("success")
    message = "Models unloaded" if success else "Failed to unload one or more models"

    return {
        "success": success,
        "message": message,
        "predictor": predictor_result,
        "segment": segment_result,
    }
