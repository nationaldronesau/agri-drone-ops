"""SAM3 Service Configuration"""
import os
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Service configuration
    app_name: str = "SAM3 Annotation Service"
    app_version: str = "1.0.0"
    debug: bool = False

    # Device configuration
    device: str = "auto"  # auto, cuda, mps, cpu

    # HuggingFace configuration
    hf_token: str = ""
    hf_home: str = "/root/.cache/huggingface"

    # Model configuration
    model_checkpoint: str = "facebook/sam2-hiera-large"

    # API configuration
    max_image_size: int = 8192  # Max dimension in pixels
    max_points: int = 20  # Max click points per request

    # Cache configuration
    image_cache_size: int = 5  # Number of images to keep in memory

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


def get_device() -> str:
    """Detect best available device for inference."""
    settings = get_settings()

    if settings.device != "auto":
        return settings.device

    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass

    return "cpu"
