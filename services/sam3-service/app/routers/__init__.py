"""API routers for SAM3 service."""
from .health import router as health_router
from .predict import router as predict_router
from .segment import router as segment_router

__all__ = ["health_router", "predict_router", "segment_router"]
