#!/usr/bin/env python3
"""
Export SAM3 Annotations to Roboflow-Compatible Formats

Converts SAM3 segmentation outputs (masks, bounding boxes) to formats
that can be uploaded to Roboflow for YOLO training.

Supported export formats:
- COCO JSON (recommended for segmentation masks)
- YOLO TXT (for bounding boxes only)
- Pascal VOC XML

Usage:
    # Export a single annotation
    python export_to_roboflow.py --image image.png --boxes "[[10,20,100,150]]" --class sapling

    # Export from a JSON annotations file
    python export_to_roboflow.py --annotations annotations.json --output dataset/

    # Export with segmentation masks
    python export_to_roboflow.py --image image.png --mask mask.tif --class sapling
"""

import argparse
import json
import os
import shutil
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image


class RoboflowExporter:
    """Export annotations to Roboflow-compatible formats."""

    def __init__(self, output_dir: str, classes: List[str] = None):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Default classes for forestry/agriculture
        self.classes = classes or ["sapling", "weed", "tree"]
        self.class_to_id = {name: i for i, name in enumerate(self.classes)}

        # COCO format accumulator
        self.coco_data = {
            "info": {
                "description": "SAM3 Forestry/Agriculture Dataset",
                "version": "1.0",
                "year": datetime.now().year,
                "contributor": "SAM3 Annotation Pipeline",
                "date_created": datetime.now().isoformat()
            },
            "licenses": [{"id": 1, "name": "Private", "url": ""}],
            "categories": [
                {"id": i, "name": name, "supercategory": "object"}
                for i, name in enumerate(self.classes)
            ],
            "images": [],
            "annotations": []
        }
        self.image_id = 0
        self.annotation_id = 0

    def _get_or_add_class(self, class_name: str) -> int:
        """Get class ID, auto-adding unknown classes with warning."""
        if class_name in self.class_to_id:
            return self.class_to_id[class_name]

        # Auto-add unknown class
        new_id = len(self.classes)
        self.classes.append(class_name)
        self.class_to_id[class_name] = new_id
        self.coco_data["categories"].append({
            "id": new_id,
            "name": class_name,
            "supercategory": "object"
        })
        print(f"WARNING: Class '{class_name}' not in initial class list. Added as class {new_id}.")
        return new_id

    def add_image_with_boxes(
        self,
        image_path: str,
        boxes: List[List[float]],
        class_name: str = "sapling",
        masks: Optional[np.ndarray] = None
    ) -> Dict:
        """
        Add an image with bounding box annotations.

        Args:
            image_path: Path to the source image
            boxes: List of [x1, y1, x2, y2] bounding boxes
            class_name: Class label for all boxes
            masks: Optional segmentation masks (H, W) or (N, H, W)

        Returns:
            Dict with export info
        """
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"Image not found: {image_path}")

        # Get image dimensions
        with Image.open(image_path) as img:
            width, height = img.size

        # Copy image to output directory
        images_dir = self.output_dir / "images"
        images_dir.mkdir(exist_ok=True)
        dest_image = images_dir / image_path.name
        if not dest_image.exists():
            shutil.copy(image_path, dest_image)

        # Add to COCO format
        self.image_id += 1
        self.coco_data["images"].append({
            "id": self.image_id,
            "file_name": image_path.name,
            "width": width,
            "height": height
        })

        class_id = self._get_or_add_class(class_name)

        # Process each box
        for i, box in enumerate(boxes):
            x1, y1, x2, y2 = box[:4]

            # COCO uses [x, y, width, height]
            bbox_coco = [x1, y1, x2 - x1, y2 - y1]
            area = (x2 - x1) * (y2 - y1)

            self.annotation_id += 1
            annotation = {
                "id": self.annotation_id,
                "image_id": self.image_id,
                "category_id": class_id,
                "bbox": bbox_coco,
                "area": area,
                "iscrowd": 0
            }

            # Add segmentation if mask provided
            if masks is not None:
                if masks.ndim == 2:
                    mask = masks
                elif masks.ndim == 3 and i < len(masks):
                    mask = masks[i]
                else:
                    mask = None

                if mask is not None:
                    segmentation = self._mask_to_polygon(mask)
                    if segmentation:
                        annotation["segmentation"] = segmentation

            self.coco_data["annotations"].append(annotation)

        # Also create YOLO format
        self._write_yolo_annotation(image_path.name, boxes, class_id, width, height)

        return {
            "image_id": self.image_id,
            "num_annotations": len(boxes),
            "class": class_name
        }

    def _mask_to_polygon(self, mask: np.ndarray) -> List[List[float]]:
        """Convert binary mask to polygon segmentation."""
        try:
            import cv2
            contours, _ = cv2.findContours(
                mask.astype(np.uint8),
                cv2.RETR_EXTERNAL,
                cv2.CHAIN_APPROX_SIMPLE
            )

            polygons = []
            for contour in contours:
                if len(contour) >= 3:
                    # Flatten to [x1, y1, x2, y2, ...]
                    polygon = contour.flatten().tolist()
                    if len(polygon) >= 6:  # At least 3 points
                        polygons.append(polygon)

            return polygons
        except ImportError:
            # cv2 not available, skip polygon conversion
            return []

    def _write_yolo_annotation(
        self,
        image_name: str,
        boxes: List[List[float]],
        class_id: int,
        img_width: int,
        img_height: int
    ):
        """Write YOLO format annotation file."""
        labels_dir = self.output_dir / "labels"
        labels_dir.mkdir(exist_ok=True)

        label_file = labels_dir / (Path(image_name).stem + ".txt")

        lines = []
        for box in boxes:
            x1, y1, x2, y2 = box[:4]

            # YOLO uses normalized center coordinates + width/height
            x_center = ((x1 + x2) / 2) / img_width
            y_center = ((y1 + y2) / 2) / img_height
            width = (x2 - x1) / img_width
            height = (y2 - y1) / img_height

            lines.append(f"{class_id} {x_center:.6f} {y_center:.6f} {width:.6f} {height:.6f}")

        with open(label_file, "w") as f:
            f.write("\n".join(lines))

    def add_from_sam3_output(
        self,
        image_path: str,
        mask_path: str = None,
        class_name: str = "sapling",
        min_area: int = 100
    ) -> Dict:
        """
        Import annotations from SAM3 mask output.

        Args:
            image_path: Original image path
            mask_path: SAM3 output mask (labeled regions)
            class_name: Class label
            min_area: Minimum object area in pixels

        Returns:
            Dict with import stats
        """
        if mask_path is None:
            raise ValueError("mask_path required for SAM3 import")

        # Load mask
        try:
            import rasterio
            with rasterio.open(mask_path) as src:
                mask = src.read(1)
        except ImportError:
            mask = np.array(Image.open(mask_path))

        # Find unique objects (each has different value)
        unique_values = np.unique(mask)
        unique_values = unique_values[unique_values > 0]  # Skip background

        boxes = []
        masks_list = []

        for val in unique_values:
            obj_mask = (mask == val)

            # Skip small objects
            if obj_mask.sum() < min_area:
                continue

            # Get bounding box
            rows = np.any(obj_mask, axis=1)
            cols = np.any(obj_mask, axis=0)
            y1, y2 = np.where(rows)[0][[0, -1]]
            x1, x2 = np.where(cols)[0][[0, -1]]

            boxes.append([int(x1), int(y1), int(x2), int(y2)])
            masks_list.append(obj_mask)

        if not boxes:
            return {"image_id": None, "num_annotations": 0, "skipped": "no objects found"}

        masks_array = np.array(masks_list) if masks_list else None

        return self.add_image_with_boxes(
            image_path=image_path,
            boxes=boxes,
            class_name=class_name,
            masks=masks_array
        )

    def save_coco(self, filename: str = "annotations.json"):
        """Save COCO format annotations."""
        output_file = self.output_dir / filename
        with open(output_file, "w") as f:
            json.dump(self.coco_data, f, indent=2)
        print(f"Saved COCO annotations to: {output_file}")
        return output_file

    def save_classes(self, filename: str = "classes.txt"):
        """Save class names file (for YOLO)."""
        output_file = self.output_dir / filename
        with open(output_file, "w") as f:
            f.write("\n".join(self.classes))
        print(f"Saved classes to: {output_file}")
        return output_file

    def save_dataset_yaml(self, filename: str = "data.yaml"):
        """Save YOLO dataset configuration."""
        output_file = self.output_dir / filename
        yaml_content = f"""# SAM3 Forestry/Agriculture Dataset
# Auto-generated for YOLO training

path: {self.output_dir.absolute()}
train: images
val: images

names:
"""
        for i, name in enumerate(self.classes):
            yaml_content += f"  {i}: {name}\n"

        with open(output_file, "w") as f:
            f.write(yaml_content)
        print(f"Saved dataset YAML to: {output_file}")
        return output_file

    def finalize(self) -> Dict:
        """Save all format files and return summary."""
        self.save_coco()
        self.save_classes()
        self.save_dataset_yaml()

        summary = {
            "output_dir": str(self.output_dir),
            "num_images": len(self.coco_data["images"]),
            "num_annotations": len(self.coco_data["annotations"]),
            "classes": self.classes,
            "formats": ["COCO JSON", "YOLO TXT", "data.yaml"]
        }

        print(f"\nExport complete!")
        print(f"  Images: {summary['num_images']}")
        print(f"  Annotations: {summary['num_annotations']}")
        print(f"  Output: {self.output_dir}/")

        return summary


def process_annotations_file(annotations_file: str, output_dir: str, classes: List[str]):
    """Process a JSON file containing multiple image annotations.

    Supports multiple formats:
    1. batch_segment.py output: {"annotations": [{image, bbox, class}, ...]}
    2. click_segment.py output: {"image": "...", "boxes": [...]}
    3. Legacy format: {"images": [{image, boxes}, ...]}
    """
    with open(annotations_file) as f:
        data = json.load(f)

    exporter = RoboflowExporter(output_dir, classes)

    # Format 1: batch_segment.py output (flat annotations array)
    if "annotations" in data and isinstance(data["annotations"], list):
        # Group annotations by image
        from collections import defaultdict
        images_dict = defaultdict(lambda: {"boxes": [], "classes": []})

        for ann in data["annotations"]:
            image_path = ann.get("image") or ann.get("image_path")
            if not image_path:
                continue

            bbox = ann.get("bbox")
            class_name = ann.get("class", data.get("class", "sapling"))

            if bbox:
                images_dict[image_path]["boxes"].append(bbox)
                images_dict[image_path]["classes"].append(class_name)

        # Process each image
        for image_path, img_data in images_dict.items():
            if not Path(image_path).exists():
                print(f"WARNING: Image not found, skipping: {image_path}")
                continue

            # Group boxes by class for proper labeling
            for box, class_name in zip(img_data["boxes"], img_data["classes"]):
                exporter.add_image_with_boxes(image_path, [box], class_name)

        print(f"Processed {len(images_dict)} images from batch annotations")

    # Format 2: Single image (click_segment.py output)
    elif "image" in data and "boxes" in data:
        image_path = data["image"]
        boxes = data["boxes"]
        class_name = data.get("class", "sapling")

        if Path(image_path).exists() and boxes:
            exporter.add_image_with_boxes(image_path, boxes, class_name)

    # Format 3: Legacy format with images array
    elif "images" in data:
        for item in data["images"]:
            image_path = item.get("image") or item.get("image_path")
            boxes = item.get("boxes", [])
            class_name = item.get("class", "sapling")
            mask_path = item.get("mask")

            if not image_path or not Path(image_path).exists():
                continue

            if mask_path and Path(mask_path).exists():
                exporter.add_from_sam3_output(image_path, mask_path, class_name)
            elif boxes:
                exporter.add_image_with_boxes(image_path, boxes, class_name)

    else:
        print(f"WARNING: Unrecognized annotation format in {annotations_file}")
        print("Expected 'annotations' array, 'images' array, or single image with 'boxes'")
        return {"error": "Unrecognized format"}

    return exporter.finalize()


def main():
    parser = argparse.ArgumentParser(
        description="Export SAM3 annotations to Roboflow format",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Export single image with boxes
  python export_to_roboflow.py --image photo.png --boxes "[[10,20,100,150]]" --class sapling

  # Export from SAM3 mask output
  python export_to_roboflow.py --image photo.png --mask photo_masks.tif --class sapling

  # Batch export from annotations file
  python export_to_roboflow.py --annotations all_annotations.json --output dataset/

  # Custom classes
  python export_to_roboflow.py --image photo.png --boxes "[[10,20,100,150]]" \\
      --classes "sapling,weed,mature_tree" --class sapling
"""
    )

    parser.add_argument("--image", "-i", help="Input image path")
    parser.add_argument("--boxes", "-b", help="Bounding boxes as JSON: [[x1,y1,x2,y2], ...]")
    parser.add_argument("--mask", "-m", help="SAM3 mask output file")
    parser.add_argument("--class", dest="class_name", default="sapling", help="Class label")
    parser.add_argument("--classes", default="sapling,weed,tree",
                        help="Comma-separated list of all classes")
    parser.add_argument("--annotations", "-a", help="JSON file with multiple annotations")
    parser.add_argument("--output", "-o", default="./roboflow_export",
                        help="Output directory")
    parser.add_argument("--min-area", type=int, default=100,
                        help="Minimum object area in pixels")

    args = parser.parse_args()

    classes = [c.strip() for c in args.classes.split(",")]

    if args.annotations:
        # Batch mode
        process_annotations_file(args.annotations, args.output, classes)
    elif args.image:
        # Single image mode
        exporter = RoboflowExporter(args.output, classes)

        if args.mask:
            exporter.add_from_sam3_output(
                args.image, args.mask, args.class_name, args.min_area
            )
        elif args.boxes:
            boxes = json.loads(args.boxes)
            exporter.add_image_with_boxes(args.image, boxes, args.class_name)
        else:
            parser.error("Must provide --boxes or --mask")

        exporter.finalize()
    else:
        parser.error("Must provide --image or --annotations")


if __name__ == "__main__":
    main()
