"""SAM3 Model Predictor - Singleton wrapper for Segment Anything Model 3."""
import time
import logging
from typing import Optional, Tuple, List, Dict, Any
from pathlib import Path
import numpy as np
from PIL import Image
import io

from .config import get_settings, get_device

logger = logging.getLogger(__name__)


class SAM3Predictor:
    """
    Singleton wrapper for SAM3 model.

    Keeps model loaded in memory for fast inference.
    Caches current image to avoid reloading between clicks.
    """

    _instance: Optional["SAM3Predictor"] = None
    _initialized: bool = False

    def __new__(cls) -> "SAM3Predictor":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if SAM3Predictor._initialized:
            return

        self.settings = get_settings()
        self.device = get_device()
        self.sam3 = None
        self.model_loaded = False
        self.load_time_ms: Optional[float] = None

        # Image cache
        self._current_image_id: Optional[str] = None
        self._current_image_path: Optional[str] = None

        logger.info(f"SAM3Predictor initialized (device: {self.device})")
        SAM3Predictor._initialized = True

    def load_model(self) -> bool:
        """
        Load SAM3 model into memory.

        Returns:
            True if model loaded successfully, False otherwise.
        """
        if self.model_loaded:
            logger.info("Model already loaded")
            return True

        try:
            start_time = time.time()
            logger.info(f"Loading SAM3 model on {self.device}...")

            # Set HuggingFace token if provided
            if self.settings.hf_token:
                import os
                os.environ["HF_TOKEN"] = self.settings.hf_token

            from samgeo import SamGeo3

            self.sam3 = SamGeo3(
                backend="transformers",
                device=self.device,
                load_from_HF=True,
            )

            self.load_time_ms = (time.time() - start_time) * 1000
            self.model_loaded = True
            logger.info(f"SAM3 model loaded in {self.load_time_ms:.0f}ms")
            return True

        except Exception as e:
            logger.error(f"Failed to load SAM3 model: {e}")
            return False

    def set_image(self, image_path: str, image_id: str) -> bool:
        """
        Set current image for segmentation.

        Args:
            image_path: Path to image file (local or URL)
            image_id: Unique identifier for caching

        Returns:
            True if image set successfully.
        """
        if not self.model_loaded:
            if not self.load_model():
                return False

        # Skip if same image already loaded
        if self._current_image_id == image_id:
            logger.debug(f"Image {image_id} already loaded")
            return True

        try:
            logger.info(f"Setting image: {image_id}")
            self.sam3.set_image(image_path)
            self._current_image_id = image_id
            self._current_image_path = image_path
            return True
        except Exception as e:
            logger.error(f"Failed to set image: {e}")
            return False

    def set_image_from_bytes(self, image_bytes: bytes, image_id: str) -> bool:
        """
        Set current image from bytes (for images fetched from URLs).

        Args:
            image_bytes: Raw image bytes
            image_id: Unique identifier for caching

        Returns:
            True if image set successfully.
        """
        if not self.model_loaded:
            if not self.load_model():
                return False

        # Skip if same image already loaded
        if self._current_image_id == image_id:
            logger.debug(f"Image {image_id} already loaded")
            return True

        try:
            # Save to temp file (SamGeo3 expects file path)
            import tempfile
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                f.write(image_bytes)
                temp_path = f.name

            logger.info(f"Setting image from bytes: {image_id}")
            self.sam3.set_image(temp_path)
            self._current_image_id = image_id
            self._current_image_path = temp_path
            return True
        except Exception as e:
            logger.error(f"Failed to set image from bytes: {e}")
            return False

    def predict(
        self,
        points: List[Dict[str, Any]],
        multimask: bool = True
    ) -> Tuple[Optional[np.ndarray], float, Dict[str, Any]]:
        """
        Run SAM3 prediction with click points.

        Args:
            points: List of {x, y, label} dicts where label is 1 (foreground) or 0 (background)
            multimask: Whether to return multiple mask candidates

        Returns:
            Tuple of (best_mask, confidence_score, metadata)
        """
        if not self.model_loaded or self.sam3 is None:
            logger.error("Model not loaded")
            return None, 0.0, {"error": "Model not loaded"}

        if self._current_image_id is None:
            logger.error("No image set")
            return None, 0.0, {"error": "No image set"}

        try:
            start_time = time.time()

            # Convert points to numpy arrays
            point_coords = np.array([[p["x"], p["y"]] for p in points])
            point_labels = np.array([p["label"] for p in points])

            logger.info(f"Running prediction with {len(points)} points")

            # Run SAM3 prediction
            result = self.sam3.predict(
                point_coords=point_coords,
                point_labels=point_labels,
                multimask_output=multimask,
                return_results=True
            )

            masks, scores, logits = result

            # Select best mask
            best_idx = np.argmax(scores)
            best_mask = masks[best_idx]
            best_score = float(scores[best_idx])

            processing_time_ms = (time.time() - start_time) * 1000

            metadata = {
                "processing_time_ms": processing_time_ms,
                "num_masks": len(masks),
                "all_scores": [float(s) for s in scores],
                "device": self.device,
                "points_used": len(points),
            }

            logger.info(f"Prediction complete in {processing_time_ms:.0f}ms (score: {best_score:.3f})")
            return best_mask, best_score, metadata

        except Exception as e:
            logger.error(f"Prediction failed: {e}")
            return None, 0.0, {"error": str(e)}

    def get_status(self) -> Dict[str, Any]:
        """Get current predictor status."""
        return {
            "model_loaded": self.model_loaded,
            "device": self.device,
            "load_time_ms": self.load_time_ms,
            "current_image_id": self._current_image_id,
        }


# Global singleton instance
predictor = SAM3Predictor()


def get_predictor() -> SAM3Predictor:
    """Get the global predictor instance."""
    return predictor
