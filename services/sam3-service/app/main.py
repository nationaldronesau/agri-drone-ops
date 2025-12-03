"""SAM3 FastAPI Application - Main entry point."""
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .sam3_predictor import get_predictor
from .routers import health_router, predict_router

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan handler.

    Loads the SAM3 model at startup for faster first inference.
    """
    settings = get_settings()
    logger.info("SAM3 Service starting up...")

    # Optionally preload model at startup
    if settings.preload_model:
        logger.info("Preloading SAM3 model...")
        predictor = get_predictor()
        if predictor.load_model():
            logger.info("SAM3 model preloaded successfully")
        else:
            logger.warning("Failed to preload SAM3 model - will load on first request")

    yield

    # Cleanup on shutdown
    logger.info("SAM3 Service shutting down...")


# Create FastAPI application
app = FastAPI(
    title="SAM3 Segmentation Service",
    description="Segment Anything Model 3 inference service for AgriDrone Ops",
    version="1.0.0",
    lifespan=lifespan,
)

# Configure CORS
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health_router)
app.include_router(predict_router)


@app.get("/")
async def root():
    """Root endpoint with service info."""
    return {
        "service": "SAM3 Segmentation Service",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/api/v1/health",
    }
