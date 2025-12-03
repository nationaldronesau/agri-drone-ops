#!/usr/bin/env python3
"""
Click-to-Segment Tool using SAM3

Click on objects in your image and SAM3 will segment them automatically.
No need to draw bounding boxes - just click!

Usage:
    python click_segment.py image.png
    python click_segment.py image.tif --output segmented.png

Controls:
    - Left-click: Add positive point (object to include)
    - Right-click: Add negative point (background to exclude)
    - Enter/S: Run segmentation with current points
    - C: Clear points
    - Z: Undo last point
    - Q: Quit
"""

import argparse
import json
import sys
from pathlib import Path
from datetime import datetime

import matplotlib.pyplot as plt
import matplotlib.patches as patches
import numpy as np
from PIL import Image


def get_best_device():
    """Detect the best available device (CUDA > MPS > CPU)."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            return "mps"  # Apple Silicon
    except ImportError:
        pass
    return "cpu"


class ClickSegmentTool:
    def __init__(self, image_path: str, output_path: str = None, class_name: str = "sapling", device: str = None):
        self.image_path = image_path
        self.output_path = output_path or str(Path(image_path).stem + "_segmented.png")
        self.class_name = class_name
        self.device = device or get_best_device()

        self.points = []  # List of (x, y)
        self.labels = []  # 1 = foreground, 0 = background
        self.point_artists = []

        self.sam3 = None
        self.masks = None

        # Annotation storage for export
        self.saved_annotations = []  # List of {bbox, mask, score, class}

        # Load image
        self.load_image()
        self.setup_ui()

    def load_image(self):
        """Load image."""
        try:
            import rasterio
            with rasterio.open(self.image_path) as src:
                if src.count >= 3:
                    self.image = np.dstack([src.read(i) for i in [1, 2, 3]])
                else:
                    self.image = src.read(1)
                if self.image.max() > 255:
                    self.image = (self.image / self.image.max() * 255).astype(np.uint8)
        except Exception:
            self.image = np.array(Image.open(self.image_path))

    def setup_ui(self):
        """Setup matplotlib UI."""
        self.fig, self.ax = plt.subplots(1, 1, figsize=(14, 10))
        self.ax.imshow(self.image)
        self.ax.set_title(
            "Click to segment | Left=Include | Right=Exclude | Enter=Segment | C=Clear | Q=Quit",
            fontsize=11
        )
        self.ax.axis('off')

        # Connect events
        self.fig.canvas.mpl_connect('button_press_event', self.on_click)
        self.fig.canvas.mpl_connect('key_press_event', self.on_key)

        self.update_title()

    def load_sam3(self):
        """Load SAM3 model (lazy loading)."""
        if self.sam3 is None:
            from samgeo import SamGeo3
            print(f"\nLoading SAM3 model on {self.device.upper()} (this may take a minute)...")
            self.sam3 = SamGeo3(
                backend="transformers",
                device=self.device,
                load_from_HF=True,
            )
            print("Setting image...")
            self.sam3.set_image(self.image_path)
            print("SAM3 ready!")
        return self.sam3

    def on_click(self, event):
        """Handle mouse clicks."""
        if event.inaxes != self.ax:
            return

        x, y = int(event.xdata), int(event.ydata)

        if event.button == 1:  # Left click - positive point
            self.points.append([x, y])
            self.labels.append(1)
            color = 'lime'
            marker = 'o'
        elif event.button == 3:  # Right click - negative point
            self.points.append([x, y])
            self.labels.append(0)
            color = 'red'
            marker = 'x'
        else:
            return

        # Draw point
        artist = self.ax.plot(x, y, marker, color=color, markersize=12,
                             markeredgewidth=2, markeredgecolor='white')[0]
        self.point_artists.append(artist)

        self.update_title()
        self.fig.canvas.draw()

    def on_key(self, event):
        """Handle keyboard input."""
        if event.key in ['enter']:
            self.run_segmentation()
        elif event.key == 's':
            self.save_current_annotation()
        elif event.key == 'e':
            self.export_annotations()
        elif event.key == 'c':
            self.clear_points()
        elif event.key == 'z':
            self.undo_point()
        elif event.key == 'q':
            self.export_annotations()  # Auto-export on quit
            plt.close(self.fig)

    def clear_points(self):
        """Clear all points."""
        self.points = []
        self.labels = []
        for artist in self.point_artists:
            artist.remove()
        self.point_artists = []

        # Clear any mask overlay
        self.redraw_image()
        self.update_title()
        self.fig.canvas.draw()

    def undo_point(self):
        """Remove last point."""
        if self.points:
            self.points.pop()
            self.labels.pop()
            if self.point_artists:
                self.point_artists[-1].remove()
                self.point_artists.pop()
            self.update_title()
            self.fig.canvas.draw()

    def redraw_image(self):
        """Redraw the base image."""
        self.ax.clear()
        self.ax.imshow(self.image)
        self.ax.axis('off')

        # Redraw points
        for (x, y), label, artist in zip(self.points, self.labels, self.point_artists):
            color = 'lime' if label == 1 else 'red'
            marker = 'o' if label == 1 else 'x'
            new_artist = self.ax.plot(x, y, marker, color=color, markersize=12,
                                      markeredgewidth=2, markeredgecolor='white')[0]

    def update_title(self):
        """Update title with point count."""
        pos = sum(1 for l in self.labels if l == 1)
        neg = sum(1 for l in self.labels if l == 0)
        self.ax.set_title(
            f"Points: {pos} positive, {neg} negative | "
            "Left=Include | Right=Exclude | Enter=Segment | C=Clear",
            fontsize=11
        )

    def run_segmentation(self):
        """Run SAM3 segmentation with current points."""
        if not self.points:
            print("Add at least one point first!")
            return

        print(f"\nRunning segmentation with {len(self.points)} point(s)...")

        try:
            sam3 = self.load_sam3()

            # Convert to numpy arrays
            point_coords = np.array(self.points)
            point_labels = np.array(self.labels)

            print(f"Points: {point_coords.tolist()}")
            print(f"Labels: {point_labels.tolist()} (1=foreground, 0=background)")

            # Run prediction with points using SamGeo3's predict method
            result = sam3.predict(
                point_coords=point_coords,
                point_labels=point_labels,
                multimask_output=True,
                return_results=True
            )

            # Result is (masks, scores, logits) when return_results=True
            if result is None:
                print("No masks returned from prediction")
                return

            masks, scores, logits = result

            # Use the mask with highest score
            best_idx = np.argmax(scores)
            mask = masks[best_idx]
            score = scores[best_idx]

            print(f"Best mask score: {score:.3f}")

            # Display result
            self.display_mask(mask, score)

            # Get bounding box from mask
            bbox = self.mask_to_bbox(mask)
            if bbox:
                print(f"Bounding box: {bbox}")

            self.masks = masks
            self.best_mask = mask
            self.best_score = float(score)

        except Exception as e:
            import traceback
            print(f"Error: {e}")
            traceback.print_exc()

    def mask_to_bbox(self, mask):
        """Convert binary mask to bounding box."""
        rows = np.any(mask, axis=1)
        cols = np.any(mask, axis=0)
        if not rows.any() or not cols.any():
            return None
        y1, y2 = np.where(rows)[0][[0, -1]]
        x1, x2 = np.where(cols)[0][[0, -1]]
        return [int(x1), int(y1), int(x2), int(y2)]

    def display_mask(self, mask, score):
        """Display the segmentation mask."""
        self.ax.clear()
        self.ax.imshow(self.image)

        # Overlay mask
        mask_overlay = np.zeros((*mask.shape, 4))
        mask_overlay[mask] = [0, 1, 0.5, 0.5]  # Green with alpha
        self.ax.imshow(mask_overlay)

        # Draw contour
        from matplotlib import cm
        self.ax.contour(mask, colors=['lime'], linewidths=2)

        # Draw bounding box
        bbox = self.mask_to_bbox(mask)
        if bbox:
            x1, y1, x2, y2 = bbox
            rect = patches.Rectangle(
                (x1, y1), x2-x1, y2-y1,
                linewidth=2, edgecolor='yellow', facecolor='none',
                linestyle='--'
            )
            self.ax.add_patch(rect)

        # Redraw points
        for (x, y), label in zip(self.points, self.labels):
            color = 'lime' if label == 1 else 'red'
            marker = 'o' if label == 1 else 'x'
            self.ax.plot(x, y, marker, color=color, markersize=12,
                        markeredgewidth=2, markeredgecolor='white')

        self.ax.set_title(f"Segmentation (score: {score:.3f}) | Press C to clear, Enter to re-segment")
        self.ax.axis('off')
        self.fig.canvas.draw()

        # Print bbox for copying
        if bbox:
            print(f"\n=== COPY THIS BOX ===")
            print(f"JSON: {bbox}")
            print(f"CLI:  {bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}")
            print(f"=====================\n")

    def save_mask(self):
        """Save the current mask."""
        if hasattr(self, 'best_mask') and self.best_mask is not None:
            mask_img = Image.fromarray((self.best_mask * 255).astype(np.uint8))
            mask_img.save(self.output_path)
            print(f"Saved mask to: {self.output_path}")

    def save_current_annotation(self):
        """Save the current segmentation as an annotation."""
        if not hasattr(self, 'best_mask') or self.best_mask is None:
            print("No segmentation to save. Run segmentation first (Enter).")
            return

        bbox = self.mask_to_bbox(self.best_mask)
        if not bbox:
            print("No valid bounding box found.")
            return

        score = getattr(self, 'best_score', 0.0)

        annotation = {
            "bbox": bbox,
            "class": self.class_name,
            "score": float(score),
            "points_used": len(self.points)
        }

        self.saved_annotations.append(annotation)
        print(f"\nSaved annotation #{len(self.saved_annotations)}: {bbox} ({self.class_name})")
        print(f"Total annotations: {len(self.saved_annotations)}")
        print("Press 'E' to export all, or continue annotating.\n")

        # Clear for next annotation
        self.clear_points()

    def export_annotations(self):
        """Export all saved annotations to JSON file."""
        if not self.saved_annotations:
            print("No annotations to export.")
            return

        # Get image dimensions
        if hasattr(self, 'image'):
            h, w = self.image.shape[:2]
        else:
            w, h = 1000, 1000  # fallback

        export_data = {
            "image": str(self.image_path),
            "image_size": [w, h],
            "class": self.class_name,
            "boxes": [a["bbox"] for a in self.saved_annotations],
            "annotations": self.saved_annotations,
            "exported_at": datetime.now().isoformat()
        }

        # Save JSON
        json_path = Path(self.image_path).stem + "_annotations.json"
        with open(json_path, "w") as f:
            json.dump(export_data, f, indent=2)

        print(f"\n{'='*50}")
        print(f"EXPORTED {len(self.saved_annotations)} ANNOTATIONS")
        print(f"{'='*50}")
        print(f"Saved to: {json_path}")
        print(f"\nBoxes for CLI:")
        boxes_cli = ";".join([f"{b[0]},{b[1]},{b[2]},{b[3]}" for b in export_data["boxes"]])
        print(f"  {boxes_cli}")
        print(f"\nTo export for Roboflow:")
        print(f"  python export_to_roboflow.py --annotations {json_path} --output dataset/")
        print(f"{'='*50}\n")

        return json_path

    def run(self):
        """Start the tool."""
        print("\n" + "="*50)
        print("Click-to-Segment Tool")
        print("="*50)
        print(f"\nImage: {self.image_path}")
        print(f"Class: {self.class_name}")
        print(f"Device: {self.device.upper()}")
        print("\nControls:")
        print("  - Left-click:  Mark object (green)")
        print("  - Right-click: Mark background (red)")
        print("  - Enter:       Run segmentation")
        print("  - S:           Save annotation (after segmenting)")
        print("  - E:           Export all annotations to JSON")
        print("  - C:           Clear all points")
        print("  - Z:           Undo last point")
        print("  - Q:           Quit (auto-exports)")
        print("\nWorkflow: Click -> Enter -> S (save) -> repeat -> Q (export)")
        print("")

        plt.tight_layout()
        plt.show()


def main():
    parser = argparse.ArgumentParser(
        description="Click-to-Segment Tool using SAM3",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Annotate saplings
  python click_segment.py image.tif --class sapling

  # Annotate weeds
  python click_segment.py image.tif --class weed

Workflow:
  1. Click on object(s) to mark them
  2. Press Enter to run segmentation
  3. Press S to save the annotation
  4. Repeat for more objects
  5. Press Q to quit and export JSON

Output:
  Creates <image>_annotations.json with all bounding boxes
  Use with: python export_to_roboflow.py --annotations <file>.json
"""
    )
    parser.add_argument("image", nargs='?', help="Path to image file")
    parser.add_argument("--output", "-o", help="Output mask path")
    parser.add_argument("--class", dest="class_name", default="sapling",
                        help="Class label for annotations (default: sapling)")
    parser.add_argument("--device", "-d", choices=["cuda", "mps", "cpu"],
                        help="Device for inference (default: auto-detect)")

    args = parser.parse_args()

    if not args.image:
        # Use sample image if available
        sample = Path("output/sample_image.tif")
        if sample.exists():
            args.image = str(sample)
            print(f"Using sample image: {args.image}")
        else:
            print("Usage: python click_segment.py <image_path>")
            sys.exit(1)

    if not Path(args.image).exists():
        print(f"Error: Image not found: {args.image}")
        sys.exit(1)

    tool = ClickSegmentTool(args.image, args.output, args.class_name, args.device)
    tool.run()


if __name__ == "__main__":
    main()
