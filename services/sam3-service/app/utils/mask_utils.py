"""Mask utility functions for converting SAM3 output to usable formats."""
import numpy as np
import cv2
from typing import List, Tuple, Optional
import logging

logger = logging.getLogger(__name__)


def mask_to_bbox(mask: np.ndarray) -> Optional[List[int]]:
    """
    Convert binary mask to bounding box.

    Args:
        mask: Binary mask array (H, W) with True/1 for object pixels

    Returns:
        Bounding box as [x1, y1, x2, y2] or None if mask is empty
    """
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)

    if not rows.any() or not cols.any():
        return None

    y1, y2 = np.where(rows)[0][[0, -1]]
    x1, x2 = np.where(cols)[0][[0, -1]]

    return [int(x1), int(y1), int(x2), int(y2)]


def mask_to_polygon(
    mask: np.ndarray,
    simplify_tolerance: float = 0.02,
    min_area: int = 100
) -> Optional[List[List[int]]]:
    """
    Convert binary mask to simplified polygon using OpenCV contours.

    Args:
        mask: Binary mask array (H, W) with True/1 for object pixels
        simplify_tolerance: Polygon simplification factor (% of perimeter)
        min_area: Minimum contour area to consider

    Returns:
        List of [x, y] points forming the polygon, or None if no valid contour
    """
    # Convert to uint8 for OpenCV
    mask_uint8 = (mask.astype(np.uint8) * 255)

    # Find contours
    contours, _ = cv2.findContours(
        mask_uint8,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE
    )

    if not contours:
        logger.warning("No contours found in mask")
        return None

    # Filter by area and find largest
    valid_contours = [c for c in contours if cv2.contourArea(c) >= min_area]

    if not valid_contours:
        logger.warning(f"No contours with area >= {min_area}")
        return None

    largest_contour = max(valid_contours, key=cv2.contourArea)

    # Simplify polygon using Douglas-Peucker algorithm
    perimeter = cv2.arcLength(largest_contour, True)
    epsilon = simplify_tolerance * perimeter
    simplified = cv2.approxPolyDP(largest_contour, epsilon, True)

    # Convert to list of [x, y] points
    points = [[int(pt[0][0]), int(pt[0][1])] for pt in simplified]

    # Ensure minimum 3 points for valid polygon
    if len(points) < 3:
        logger.warning(f"Simplified polygon has only {len(points)} points")
        return None

    logger.info(f"Converted mask to polygon with {len(points)} points")
    return points


def mask_to_rle(mask: np.ndarray) -> dict:
    """
    Convert binary mask to Run-Length Encoding (RLE).

    Args:
        mask: Binary mask array (H, W)

    Returns:
        RLE dict with 'counts' and 'size' keys
    """
    pixels = mask.flatten()
    pixels = np.concatenate([[0], pixels, [0]])
    runs = np.where(pixels[1:] != pixels[:-1])[0] + 1
    runs[1::2] -= runs[::2]

    return {
        "counts": runs.tolist(),
        "size": list(mask.shape)
    }


def polygon_area(polygon: List[List[int]]) -> float:
    """
    Calculate area of a polygon using Shoelace formula.

    Args:
        polygon: List of [x, y] points

    Returns:
        Area in square pixels
    """
    n = len(polygon)
    if n < 3:
        return 0.0

    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += polygon[i][0] * polygon[j][1]
        area -= polygon[j][0] * polygon[i][1]

    return abs(area) / 2.0


def polygon_centroid(polygon: List[List[int]]) -> Tuple[float, float]:
    """
    Calculate centroid of a polygon.

    Args:
        polygon: List of [x, y] points

    Returns:
        Tuple of (center_x, center_y)
    """
    n = len(polygon)
    if n == 0:
        return (0.0, 0.0)

    cx = sum(p[0] for p in polygon) / n
    cy = sum(p[1] for p in polygon) / n

    return (cx, cy)
