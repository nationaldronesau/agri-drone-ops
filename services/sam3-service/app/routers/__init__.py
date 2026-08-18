"""API routers for SAM3 service."""
from .health import router as health_router
from .predict import router as predict_router
from .segment import router as segment_router
from .yolo import router as yolo_router
from .pine_stocktake import router as pine_stocktake_router

__all__ = ["health_router", "predict_router", "segment_router", "yolo_router", "pine_stocktake_router"]
