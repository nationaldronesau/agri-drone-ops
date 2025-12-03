#!/usr/bin/env python3
"""
Batch Segmentation Tool using SAM3 - MASK GENERATION FOR REVIEW

Generates segmentation masks for all objects in drone imagery using SAM3.
These masks are meant for MANUAL REVIEW, not direct training data.

IMPORTANT: SAM3's "everything" mode segments ALL objects (roads, trees, grass,
buildings, etc.), not just your target class. The masks generated here should
be reviewed and filtered before use as training data.

RECOMMENDED WORKFLOW:
1. Use click_segment.py to manually annotate a subset of images (clean training data)
2. Train an initial model in Roboflow
3. Use that trained model for inference on new images
4. Use this tool only for generating candidate regions for human review

Usage:
    # Generate masks for review (no class assignment)
    python batch_segment.py /path/to/images --output ./review_masks

    # Generate masks with tentative class (REQUIRES MANUAL REVIEW)
    python batch_segment.py /path/to/images --output ./review --class sapling --review-mode

    # Use GPU for faster processing
    python batch_segment.py /path/to/images --device cuda --output ./masks

    # Limit number of images (useful for testing)
    python batch_segment.py /path/to/images --limit 10 --output ./test_masks

For creating clean labeled training data, use click_segment.py instead:
    python click_segment.py image.tif --class pine_sapling
"""

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image


def get_best_device():
    """Detect the best available device (CUDA > MPS > CPU)."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


class BatchSegmenter:
    """Process multiple images with SAM3 for mask generation (review mode).

    WARNING: SAM3's "everything" mode segments ALL objects, not just your
    target class. Output should be reviewed before use as training data.
    """

    def __init__(
        self,
        output_dir: str,
        class_name: str = "unknown",
        device: str = None,
        min_area: int = 100,
        max_objects: int = 500,
        review_mode: bool = True
    ):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.class_name = class_name
        self.device = device or get_best_device()
        self.min_area = min_area
        self.max_objects = max_objects
        self.review_mode = review_mode

        self.sam3 = None
        self.results = []
        self.stats = {
            "processed": 0,
            "failed": 0,
            "total_objects": 0,
            "start_time": None,
            "end_time": None
        }

    def load_sam3(self):
        """Load SAM3 model (lazy loading for efficiency)."""
        if self.sam3 is None:
            from samgeo import SamGeo3
            print(f"\nLoading SAM3 model on {self.device.upper()}...")
            print("(First load downloads ~1.5GB model, please wait)")
            self.sam3 = SamGeo3(
                backend="transformers",
                device=self.device,
                load_from_HF=True,
            )
            print("SAM3 model loaded successfully!")
        return self.sam3

    def find_images(self, input_path: str, limit: Optional[int] = None) -> List[Path]:
        """Find all images in a directory or S3 path."""
        input_path = Path(input_path)

        # Supported image extensions
        extensions = {'.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp'}

        if input_path.is_file():
            return [input_path]

        images = []
        for ext in extensions:
            images.extend(input_path.glob(f"*{ext}"))
            images.extend(input_path.glob(f"*{ext.upper()}"))

        # Sort by name for consistent ordering
        images = sorted(images)

        if limit:
            images = images[:limit]

        return images

    def load_image(self, image_path: Path) -> Optional[np.ndarray]:
        """Load image as numpy array, handling GeoTIFF and standard formats."""
        try:
            # Try rasterio first for GeoTIFF support
            import rasterio
            with rasterio.open(image_path) as src:
                if src.count >= 3:
                    image = np.dstack([src.read(i) for i in [1, 2, 3]])
                else:
                    image = src.read(1)
                if image.max() > 255:
                    image = (image / image.max() * 255).astype(np.uint8)
                return image
        except Exception:
            # Fallback to PIL
            try:
                return np.array(Image.open(image_path).convert('RGB'))
            except Exception as e:
                print(f"Failed to load {image_path}: {e}")
                return None

    def mask_to_bbox(self, mask: np.ndarray) -> Optional[List[int]]:
        """Convert binary mask to bounding box [x1, y1, x2, y2]."""
        rows = np.any(mask, axis=1)
        cols = np.any(mask, axis=0)
        if not rows.any() or not cols.any():
            return None
        y1, y2 = np.where(rows)[0][[0, -1]]
        x1, x2 = np.where(cols)[0][[0, -1]]
        return [int(x1), int(y1), int(x2), int(y2)]

    def process_image(self, image_path: Path) -> Dict:
        """Process a single image with SAM3 automatic segmentation."""
        result = {
            "image": str(image_path),
            "image_name": image_path.name,
            "annotations": [],
            "status": "pending",
            "error": None
        }

        try:
            sam3 = self.load_sam3()

            # Set image for SAM3
            sam3.set_image(str(image_path))

            # Generate automatic masks (SAM3's everything mode)
            # This finds all objects in the image automatically
            output_mask_path = self.output_dir / "masks" / f"{image_path.stem}_masks.tif"
            output_mask_path.parent.mkdir(parents=True, exist_ok=True)

            # Run automatic segmentation
            sam3.generate(
                output=str(output_mask_path),
                foreground=True,
                unique=True,
            )

            # Load generated masks and extract bounding boxes
            if output_mask_path.exists():
                import rasterio
                with rasterio.open(output_mask_path) as src:
                    mask_data = src.read(1)

                # Each unique value (except 0) is a different object
                unique_values = np.unique(mask_data)
                unique_values = unique_values[unique_values > 0]

                annotations = []
                for val in unique_values[:self.max_objects]:
                    obj_mask = (mask_data == val)

                    # Skip small objects
                    area = obj_mask.sum()
                    if area < self.min_area:
                        continue

                    bbox = self.mask_to_bbox(obj_mask)
                    if bbox:
                        annotations.append({
                            "bbox": bbox,
                            "class": self.class_name,
                            "area": int(area),
                            "mask_id": int(val),
                            "status": "needs_review",  # Flag for human review
                            "auto_generated": True
                        })

                result["annotations"] = annotations
                result["num_objects"] = len(annotations)
                result["mask_path"] = str(output_mask_path)
                result["status"] = "success"

                self.stats["total_objects"] += len(annotations)

            else:
                result["status"] = "no_masks"
                result["error"] = "No masks generated"

        except Exception as e:
            import traceback
            result["status"] = "error"
            result["error"] = str(e)
            result["traceback"] = traceback.format_exc()

        return result

    def process_batch(
        self,
        input_path: str,
        limit: Optional[int] = None,
        progress_callback=None
    ) -> List[Dict]:
        """Process all images in a directory."""
        images = self.find_images(input_path, limit)

        if not images:
            print(f"No images found in {input_path}")
            return []

        print(f"\nFound {len(images)} images to process")
        print(f"Device: {self.device.upper()}")
        print(f"Class: {self.class_name}")
        print(f"Output: {self.output_dir}")
        print("-" * 50)

        self.stats["start_time"] = datetime.now()
        results = []

        for i, image_path in enumerate(images):
            start_time = time.time()

            print(f"[{i+1}/{len(images)}] Processing: {image_path.name}...", end=" ", flush=True)

            result = self.process_image(image_path)
            results.append(result)

            elapsed = time.time() - start_time

            if result["status"] == "success":
                print(f"OK ({result['num_objects']} objects, {elapsed:.1f}s)")
                self.stats["processed"] += 1
            else:
                print(f"FAILED: {result['error']}")
                self.stats["failed"] += 1

            if progress_callback:
                progress_callback(i + 1, len(images), result)

        self.stats["end_time"] = datetime.now()
        self.results = results
        return results

    def export_results(self) -> Dict:
        """Export all results to JSON and summary files."""
        # Save detailed results
        results_file = self.output_dir / "batch_results.json"
        with open(results_file, "w") as f:
            json.dump({
                "class": self.class_name,
                "device": self.device,
                "min_area": self.min_area,
                "stats": {
                    **self.stats,
                    "start_time": self.stats["start_time"].isoformat() if self.stats["start_time"] else None,
                    "end_time": self.stats["end_time"].isoformat() if self.stats["end_time"] else None,
                },
                "results": self.results
            }, f, indent=2)

        # Create consolidated annotations file for Roboflow export
        all_annotations = []
        for result in self.results:
            if result["status"] == "success":
                for ann in result["annotations"]:
                    all_annotations.append({
                        "image": result["image"],
                        "image_name": result["image_name"],
                        **ann
                    })

        annotations_file = self.output_dir / "all_annotations.json"
        with open(annotations_file, "w") as f:
            json.dump({
                "class": self.class_name,
                "total_images": len(self.results),
                "total_annotations": len(all_annotations),
                "annotations": all_annotations,
                "exported_at": datetime.now().isoformat()
            }, f, indent=2)

        # Print summary
        duration = (self.stats["end_time"] - self.stats["start_time"]).total_seconds() if self.stats["end_time"] and self.stats["start_time"] else 0

        print("\n" + "=" * 50)
        print("BATCH PROCESSING COMPLETE - REVIEW REQUIRED")
        print("=" * 50)
        print(f"Processed: {self.stats['processed']} images")
        print(f"Failed: {self.stats['failed']} images")
        print(f"Total candidate objects: {self.stats['total_objects']}")
        print(f"Duration: {duration:.1f} seconds")
        print(f"\nOutput files:")
        print(f"  Results: {results_file}")
        print(f"  Annotations: {annotations_file}")
        print(f"  Masks: {self.output_dir}/masks/")
        print(f"\n⚠️  IMPORTANT: These annotations need human review!")
        print(f"   SAM3 segments ALL objects (roads, trees, etc.), not just {self.class_name}.")
        print(f"   Review masks before using as training data.")
        print(f"\nFor clean labeled data, use click_segment.py instead:")
        print(f"  python click_segment.py image.tif --class {self.class_name}")
        print("=" * 50)

        return {
            "results_file": str(results_file),
            "annotations_file": str(annotations_file),
            "stats": self.stats
        }


def main():
    parser = argparse.ArgumentParser(
        description="Generate SAM3 segmentation masks for review (NOT direct training data)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
⚠️  IMPORTANT: This tool generates CANDIDATE masks that need human review.
    SAM3's "everything" mode segments ALL objects (roads, trees, buildings),
    not just your target class. DO NOT use output directly as training data.

For clean labeled training data, use click_segment.py instead:
    python click_segment.py image.tif --class pine_sapling

Examples:
  # Generate masks for review (recommended)
  python batch_segment.py /path/to/images --output ./review_masks

  # Generate with tentative class label (still needs review!)
  python batch_segment.py /path/to/images --class sapling --output ./review

  # Use GPU for faster processing
  python batch_segment.py /path/to/images --device cuda --output ./masks

  # Limit to first 10 images (for testing)
  python batch_segment.py /path/to/images --limit 10

Workflow:
  1. Run batch_segment.py to generate candidate masks
  2. REVIEW generated masks in output/masks/ - remove false positives
  3. After review, export to Roboflow
  4. Or better: use click_segment.py for accurate labeled data

Notes:
  - First run downloads SAM3 model (~1.5GB)
  - GPU (CUDA) recommended for production use
  - Each image takes 5-30 seconds depending on size and device
"""
    )

    parser.add_argument("input", help="Directory containing images to process")
    parser.add_argument("--output", "-o", default="./sam3_review",
                        help="Output directory for results (default: ./sam3_review)")
    parser.add_argument("--class", dest="class_name", default="unknown",
                        help="Tentative class label (default: unknown - needs review)")
    parser.add_argument("--device", "-d", choices=["cuda", "mps", "cpu"],
                        help="Device for inference (default: auto-detect)")
    parser.add_argument("--limit", "-l", type=int,
                        help="Limit number of images to process (for testing)")
    parser.add_argument("--min-area", type=int, default=100,
                        help="Minimum object area in pixels (default: 100)")
    parser.add_argument("--max-objects", type=int, default=500,
                        help="Maximum objects per image (default: 500)")

    args = parser.parse_args()

    # Validate input path
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: Input path does not exist: {args.input}")
        sys.exit(1)

    # Create segmenter and run
    segmenter = BatchSegmenter(
        output_dir=args.output,
        class_name=args.class_name,
        device=args.device,
        min_area=args.min_area,
        max_objects=args.max_objects
    )

    segmenter.process_batch(args.input, limit=args.limit)
    segmenter.export_results()


if __name__ == "__main__":
    main()
