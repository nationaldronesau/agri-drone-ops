"""Image utility functions for fetching and processing images."""
import httpx
import logging
from typing import Optional, Tuple
from PIL import Image
import io
import numpy as np

logger = logging.getLogger(__name__)

# HTTP client with reasonable timeouts
http_client = httpx.AsyncClient(
    timeout=httpx.Timeout(30.0, connect=10.0),
    follow_redirects=True
)


async def fetch_image(url: str) -> Optional[bytes]:
    """
    Fetch image from URL.

    Args:
        url: URL to fetch image from (S3 signed URL, etc.)

    Returns:
        Image bytes or None if fetch failed
    """
    try:
        logger.info(f"Fetching image from: {url[:100]}...")
        response = await http_client.get(url)
        response.raise_for_status()

        content_type = response.headers.get("content-type", "")
        if not content_type.startswith("image/"):
            logger.warning(f"Unexpected content type: {content_type}")

        logger.info(f"Fetched {len(response.content)} bytes")
        return response.content

    except httpx.HTTPError as e:
        logger.error(f"HTTP error fetching image: {e}")
        return None
    except Exception as e:
        logger.error(f"Error fetching image: {e}")
        return None


async def load_image_from_url(url: str) -> Optional[Tuple[np.ndarray, Tuple[int, int]]]:
    """
    Load image from URL into numpy array.

    Args:
        url: URL to fetch image from

    Returns:
        Tuple of (image_array, (width, height)) or None if failed
    """
    image_bytes = await fetch_image(url)
    if image_bytes is None:
        return None

    try:
        image = Image.open(io.BytesIO(image_bytes))
        # Convert to RGB if needed
        if image.mode != "RGB":
            image = image.convert("RGB")

        width, height = image.size
        array = np.array(image)

        logger.info(f"Loaded image: {width}x{height}")
        return array, (width, height)

    except Exception as e:
        logger.error(f"Error loading image: {e}")
        return None


def validate_image_size(width: int, height: int, max_size: int = 8192) -> bool:
    """
    Validate image dimensions are within limits.

    Args:
        width: Image width
        height: Image height
        max_size: Maximum allowed dimension

    Returns:
        True if valid, False if too large
    """
    if width > max_size or height > max_size:
        logger.warning(f"Image too large: {width}x{height} (max: {max_size})")
        return False
    return True
