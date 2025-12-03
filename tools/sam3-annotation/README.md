# SAM3 Annotation Pipeline

Bulk annotation tool using Meta's Segment Anything Model 3 (SAM3) for rapid labeling of drone imagery. This pipeline enables one-click segmentation of pine saplings, weeds, and other vegetation for training object detection models.

## Overview

This toolkit provides:
- **Interactive Annotation** (`click_segment.py`): Click-to-segment tool for manual annotation
- **Batch Processing** (`batch_segment.py`): Automatic segmentation of hundreds of images
- **Roboflow Export** (`export_to_roboflow.py`): Convert annotations to COCO/YOLO format
- **Roboflow Upload** (`upload_to_roboflow.py`): Push datasets to Roboflow for training

## Requirements

- Python 3.9+
- PyTorch 2.0+ (CUDA recommended for production)
- HuggingFace account (SAM3 is a gated model)
- 8GB+ RAM (16GB recommended)
- GPU with 8GB+ VRAM (optional but strongly recommended)

## Installation

### 1. Create Virtual Environment

```bash
# Navigate to this directory
cd tools/sam3-annotation

# Create isolated environment (separate from Node.js app)
python -m venv venv
source venv/bin/activate  # Linux/Mac
# or: venv\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt
```

### 2. Authenticate with HuggingFace

SAM3 is a gated model requiring HuggingFace authentication:

```bash
# Install HuggingFace CLI
pip install huggingface_hub

# Login (get token from https://huggingface.co/settings/tokens)
huggingface-cli login
```

### 3. Set Roboflow API Key

```bash
# Option 1: Environment variable
export ROBOFLOW_API_KEY=your_api_key_here

# Option 2: Create config file
mkdir -p ~/.roboflow
echo '{"api_key": "your_api_key"}' > ~/.roboflow/config.json
```

## Usage

### Interactive Annotation (Single Images)

Best for creating high-quality training data with manual review:

```bash
# Activate environment
source venv/bin/activate

# Annotate an image
python click_segment.py /path/to/image.tif --class pine_sapling

# Use GPU for faster inference
python click_segment.py /path/to/image.tif --device cuda --class weed
```

**Controls:**
- Left-click: Mark object to include (green)
- Right-click: Mark background to exclude (red)
- Enter: Run segmentation
- S: Save current annotation
- C: Clear points
- Z: Undo last point
- Q: Quit and export JSON

### Batch Processing (Hundreds of Images)

Best for bulk annotation on AWS GPU instances:

```bash
# Process all images in a directory
python batch_segment.py /path/to/images --class pine_sapling --output ./dataset

# Use GPU (required for production)
python batch_segment.py /path/to/images --device cuda --class sapling

# Limit for testing
python batch_segment.py /path/to/images --limit 10 --class weed

# Filter small objects
python batch_segment.py /path/to/images --min-area 500 --class vegetation
```

### Export to Roboflow Format

```bash
# From batch processing output
python export_to_roboflow.py \
    --annotations ./dataset/all_annotations.json \
    --output ./roboflow_dataset \
    --classes "pine_sapling,weed,mature_tree"

# From single annotation file
python export_to_roboflow.py \
    --annotations image_annotations.json \
    --output ./dataset
```

### Upload to Roboflow

```bash
# Upload dataset
python upload_to_roboflow.py \
    --dataset ./roboflow_dataset \
    --workspace national-drones \
    --project sapling-detection \
    --split train
```

## AWS GPU Instance Setup

For processing hundreds of images, use an AWS GPU instance:

### Recommended Instance Types

| Instance | GPU | VRAM | Cost/hr | Use Case |
|----------|-----|------|---------|----------|
| g4dn.xlarge | T4 | 16GB | ~$0.50 | Small batches |
| g5.xlarge | A10G | 24GB | ~$1.00 | Production |
| p3.2xlarge | V100 | 16GB | ~$3.00 | Large scale |

### Quick Setup Script

```bash
#!/bin/bash
# Run on fresh AWS GPU instance (Ubuntu 22.04 + CUDA)

# Install Python and dependencies
sudo apt update
sudo apt install -y python3.10 python3.10-venv python3-pip

# Clone project
git clone https://github.com/nationaldronesau/agri-drone-ops.git
cd agri-drone-ops/tools/sam3-annotation

# Setup environment
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Authenticate HuggingFace
huggingface-cli login

# Test GPU detection
python -c "import torch; print(f'CUDA: {torch.cuda.is_available()}')"
```

## Workflow Examples

### Complete Pipeline: Pine Sapling Detection

```bash
# 1. Upload images to instance
scp -r ./drone_images/ ubuntu@instance:/data/

# 2. Run batch segmentation
python batch_segment.py /data/drone_images \
    --class pine_sapling \
    --device cuda \
    --output /data/annotations

# 3. Export to Roboflow format
python export_to_roboflow.py \
    --annotations /data/annotations/all_annotations.json \
    --output /data/roboflow_dataset \
    --classes "pine_sapling"

# 4. Upload to Roboflow
python upload_to_roboflow.py \
    --dataset /data/roboflow_dataset \
    --workspace national-drones \
    --project pine-sapling-detection

# 5. Train model in Roboflow UI
# Go to https://app.roboflow.com and start training
```

### Multiple Classes in One Session

```bash
# Annotate saplings
python click_segment.py image.tif --class pine_sapling
# ... annotate, export, clear ...

# Annotate weeds in same image
python click_segment.py image.tif --class weed
# ... annotate, export ...

# Combine annotations
python export_to_roboflow.py \
    --annotations "sapling_annotations.json,weed_annotations.json" \
    --output ./combined_dataset \
    --classes "pine_sapling,weed,tree"
```

## Output Format

### Annotation JSON

```json
{
  "image": "/path/to/image.tif",
  "image_size": [4000, 3000],
  "class": "pine_sapling",
  "boxes": [[x1, y1, x2, y2], ...],
  "annotations": [
    {
      "bbox": [100, 200, 300, 450],
      "class": "pine_sapling",
      "score": 0.95,
      "area": 50000
    }
  ]
}
```

### Dataset Structure (after export)

```
roboflow_dataset/
├── images/          # Copied source images
├── labels/          # YOLO format .txt files
├── annotations.json # COCO format
├── classes.txt      # Class names
└── data.yaml        # YOLO dataset config
```

## Performance Tips

1. **Use GPU**: CPU is 10-50x slower than GPU
2. **Batch size**: Process 50-100 images per session
3. **Image resolution**: Downscale very large images (>8000px) for speed
4. **Min area filter**: Use `--min-area 200+` to skip tiny detections
5. **Model caching**: First image is slow (model loading), subsequent are faster

## Troubleshooting

### "CUDA out of memory"

Reduce image resolution or use a larger GPU instance.

### "Access denied" on HuggingFace

1. Accept model license at https://huggingface.co/facebook/sam2-hiera-large
2. Re-run `huggingface-cli login`

### Slow first image

Normal - SAM3 model (~1.5GB) downloads on first use. Subsequent runs use cached model.

### No objects detected

- Increase sensitivity: lower `--min-area` threshold
- Check image format: ensure RGB/GeoTIFF is valid
- Try interactive mode to debug: `python click_segment.py image.tif`

## Integration with AgriDrone Ops

This tool is designed to work alongside the main AgriDrone Ops platform:

1. **Export drone images** from AgriDrone Ops projects
2. **Annotate with SAM3** using this pipeline
3. **Train models** in Roboflow
4. **Import trained models** back to AgriDrone Ops for inference

Future integration may include:
- Direct S3 bucket access for images
- Automated pipeline triggers
- Model version management

## License

Part of the AgriDrone Ops platform by National Drones Australia.
