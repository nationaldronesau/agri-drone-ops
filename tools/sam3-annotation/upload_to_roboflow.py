#!/usr/bin/env python3
"""
Upload Dataset to Roboflow

Uploads annotated images to Roboflow for training YOLO models.

Prerequisites:
    pip install roboflow

Usage:
    # Upload a dataset exported by export_to_roboflow.py
    python upload_to_roboflow.py --dataset ./roboflow_export --project my-sapling-detector

    # Upload with custom workspace
    python upload_to_roboflow.py --dataset ./roboflow_export \\
        --workspace my-workspace --project forestry-detection

Environment:
    Set ROBOFLOW_API_KEY environment variable or use --api-key flag
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Optional


def check_roboflow_installed():
    """Check if roboflow package is installed."""
    try:
        import roboflow
        return True
    except ImportError:
        print("Roboflow package not installed.")
        print("Install with: pip install roboflow")
        return False


def get_api_key(api_key_arg: Optional[str] = None) -> str:
    """Get Roboflow API key from argument or environment."""
    if api_key_arg:
        return api_key_arg

    api_key = os.environ.get("ROBOFLOW_API_KEY")
    if api_key:
        return api_key

    # Try to read from config file
    config_path = Path.home() / ".roboflow" / "config.json"
    if config_path.exists():
        with open(config_path) as f:
            config = json.load(f)
            if "api_key" in config:
                return config["api_key"]

    print("Roboflow API key not found.")
    print("Set it via:")
    print("  1. --api-key argument")
    print("  2. ROBOFLOW_API_KEY environment variable")
    print("  3. ~/.roboflow/config.json file")
    print("\nGet your API key from: https://app.roboflow.com/settings/api")
    sys.exit(1)


def upload_dataset(
    dataset_dir: str,
    workspace: str,
    project: str,
    api_key: str,
    batch_name: Optional[str] = None,
    split: str = "train"
):
    """
    Upload dataset to Roboflow.

    Args:
        dataset_dir: Path to exported dataset (from export_to_roboflow.py)
        workspace: Roboflow workspace name
        project: Roboflow project name
        api_key: Roboflow API key
        batch_name: Optional batch name for this upload
        split: Dataset split (train, valid, test)
    """
    from roboflow import Roboflow

    dataset_path = Path(dataset_dir)

    # Verify dataset structure
    images_dir = dataset_path / "images"
    labels_dir = dataset_path / "labels"
    coco_file = dataset_path / "annotations.json"

    if not images_dir.exists():
        print(f"Error: Images directory not found: {images_dir}")
        sys.exit(1)

    # Initialize Roboflow
    print(f"Connecting to Roboflow...")
    rf = Roboflow(api_key=api_key)

    # Get or create project
    try:
        workspace_obj = rf.workspace(workspace)
        project_obj = workspace_obj.project(project)
        print(f"Found existing project: {project}")
    except Exception:
        print(f"Project '{project}' not found in workspace '{workspace}'")
        print("Please create the project first at https://app.roboflow.com")
        print("Or check your workspace/project names")
        sys.exit(1)

    # Upload images with annotations
    image_files = list(images_dir.glob("*.png")) + \
                  list(images_dir.glob("*.jpg")) + \
                  list(images_dir.glob("*.jpeg")) + \
                  list(images_dir.glob("*.tif")) + \
                  list(images_dir.glob("*.tiff"))

    print(f"\nUploading {len(image_files)} images to Roboflow...")
    print(f"  Workspace: {workspace}")
    print(f"  Project: {project}")
    print(f"  Split: {split}")

    uploaded = 0
    failed = 0

    for i, image_path in enumerate(image_files):
        # Find corresponding annotation
        label_file = labels_dir / (image_path.stem + ".txt")

        try:
            if label_file.exists():
                # Upload with YOLO annotation
                project_obj.upload(
                    image_path=str(image_path),
                    annotation_path=str(label_file),
                    split=split,
                    batch_name=batch_name,
                    annotation_labelmap=str(dataset_path / "classes.txt")
                )
            else:
                # Upload image only (for manual annotation in Roboflow)
                project_obj.upload(
                    image_path=str(image_path),
                    split=split,
                    batch_name=batch_name
                )

            uploaded += 1
            print(f"  [{i+1}/{len(image_files)}] Uploaded: {image_path.name}")

        except Exception as e:
            failed += 1
            print(f"  [{i+1}/{len(image_files)}] Failed: {image_path.name} - {e}")

    print(f"\nUpload complete!")
    print(f"  Uploaded: {uploaded}")
    print(f"  Failed: {failed}")
    print(f"\nView your dataset at:")
    print(f"  https://app.roboflow.com/{workspace}/{project}")

    return {"uploaded": uploaded, "failed": failed}


def upload_coco_format(
    dataset_dir: str,
    workspace: str,
    project: str,
    api_key: str
):
    """Upload using COCO format (alternative method)."""
    from roboflow import Roboflow

    dataset_path = Path(dataset_dir)
    coco_file = dataset_path / "annotations.json"

    if not coco_file.exists():
        print(f"Error: COCO annotations not found: {coco_file}")
        sys.exit(1)

    print("Uploading COCO format dataset...")
    print("Note: For COCO format, use Roboflow's web uploader:")
    print(f"  1. Go to https://app.roboflow.com/{workspace}/{project}")
    print(f"  2. Click 'Upload' > 'COCO JSON'")
    print(f"  3. Select {coco_file}")
    print(f"  4. Upload the images folder: {dataset_path / 'images'}")


def create_project_if_needed(
    workspace: str,
    project: str,
    api_key: str,
    project_type: str = "object-detection"
) -> bool:
    """
    Attempt to create a new Roboflow project.

    Note: Project creation via API may require specific permissions.
    """
    from roboflow import Roboflow

    rf = Roboflow(api_key=api_key)

    try:
        workspace_obj = rf.workspace(workspace)

        # Check if project exists
        try:
            workspace_obj.project(project)
            print(f"Project '{project}' already exists")
            return True
        except Exception:
            pass

        # Try to create (may not be available for all accounts)
        print(f"Attempting to create project '{project}'...")
        # Note: create_project API may vary by Roboflow version
        # This is a placeholder - actual API call depends on roboflow package version

        print("Project creation via API may require specific permissions.")
        print(f"Please create the project manually at:")
        print(f"  https://app.roboflow.com/{workspace}/projects/new")
        return False

    except Exception as e:
        print(f"Error: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(
        description="Upload SAM3 annotated dataset to Roboflow",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic upload
  python upload_to_roboflow.py --dataset ./roboflow_export \\
      --workspace my-workspace --project sapling-detection

  # Upload with custom batch name
  python upload_to_roboflow.py --dataset ./roboflow_export \\
      --workspace my-workspace --project sapling-detection \\
      --batch "field-survey-2024-01"

  # Upload to validation split
  python upload_to_roboflow.py --dataset ./roboflow_export \\
      --workspace my-workspace --project sapling-detection \\
      --split valid

Environment Variables:
  ROBOFLOW_API_KEY - Your Roboflow API key
"""
    )

    parser.add_argument("--dataset", "-d", required=True,
                        help="Path to dataset directory (from export_to_roboflow.py)")
    parser.add_argument("--workspace", "-w", required=True,
                        help="Roboflow workspace name")
    parser.add_argument("--project", "-p", required=True,
                        help="Roboflow project name")
    parser.add_argument("--api-key", help="Roboflow API key (or use ROBOFLOW_API_KEY env var)")
    parser.add_argument("--batch", help="Batch name for this upload")
    parser.add_argument("--split", choices=["train", "valid", "test"], default="train",
                        help="Dataset split (default: train)")
    parser.add_argument("--format", choices=["yolo", "coco"], default="yolo",
                        help="Upload format (default: yolo)")

    args = parser.parse_args()

    if not check_roboflow_installed():
        sys.exit(1)

    api_key = get_api_key(args.api_key)

    if args.format == "coco":
        upload_coco_format(args.dataset, args.workspace, args.project, api_key)
    else:
        upload_dataset(
            dataset_dir=args.dataset,
            workspace=args.workspace,
            project=args.project,
            api_key=api_key,
            batch_name=args.batch,
            split=args.split
        )


if __name__ == "__main__":
    main()
