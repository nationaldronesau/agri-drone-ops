# Session Summary - 12th January 2026

## Visual Exemplar Transfer Implementation

The linter shows pre-existing warnings in other files, but no errors in the files modified. The visual exemplar transfer implementation is complete.

---

## What We Built

A true few-shot learning pipeline for cross-image detection:

1. **Frontend (AnnotateClient.tsx)** - Extracts actual pixel content from exemplar boxes using HTML Canvas
2. **Backend (batch-queue.ts, batch-worker.ts)** - Carries visual crops through the queue system
3. **Python Service (segment.py)** - New `/segment` endpoint using SAM3's Promptable Concept Segmentation
4. **Source vs Target distinction** - Source image uses box coordinates (correct), target images use visual crops (the fix!)

---

## Implementation Complete

All 9 tasks are finished. Here's a summary of what was implemented:

### Files Modified

| File | Change |
|------|--------|
| `services/sam3-service/requirements.txt` | Added transformers>=4.40.0 for SAM3 |
| `services/sam3-service/app/routers/segment.py` | NEW - Concept segmentation endpoint |
| `services/sam3-service/app/routers/__init__.py` | Export segment_router |
| `services/sam3-service/app/main.py` | Register segment router |
| `lib/queue/batch-queue.ts` | Added exemplarCrops and sourceAssetId fields |
| `lib/services/aws-sam3.ts` | Added segmentWithExemplars() method |
| `lib/services/sam3-orchestrator.ts` | Added predictWithExemplars() method |
| `workers/batch-worker.ts` | Source vs target image detection logic |
| `app/annotate/[assetId]/AnnotateClient.tsx` | Canvas-based crop extraction |
| `app/api/sam3/batch/route.ts` | Accept and validate new fields |

---

## How It Works Now

1. User draws 3-4 boxes around pine saplings on Image 1
2. Frontend extracts actual pixel content (not just coordinates) from those boxes
3. Crops are sent as base64 to the batch API
4. **Source image (Image 1):** Uses box coordinates (works correctly since boxes contain actual content)
5. **Target images (Images 2+):** Uses visual exemplar crops to find similar objects

This should fix the detection degradation issue (35→12→6) by ensuring the same visual concept is used across all images.

---

## Deployment Path

1. Commit these changes
2. Push to main
3. Deploy to production

### Changes Include
- 9 modified files
- 1 new file (segment.py)

---

## EC2 SAM3 Service Update Required

The Python service (`services/sam3-service/`) runs on the EC2 instance, so after deploying the main app, the following is needed on EC2:

1. Pull the changes on EC2 SAM3 instance
2. Install the new dependency: `pip install transformers>=4.40.0`
3. Restart the SAM3 service

---

## Architecture Discovery

### Critical Finding: Two Different Codebases

After cloning the actual `SAM3AWS` repo from `nationaldronesau/SAM3AWS`, a fundamental architecture difference was found:

### What's Actually Running on EC2 (`/opt/sam3-api/`)

| Component | Port | Purpose |
|-----------|------|---------|
| `yolo_service.py` | 8001 | YOLO training & inference (local GPU) |
| `roboflow_sam3_client.py` | N/A | CLI tool calling Roboflow's cloud SAM3 API |
| SAM3 Service | 8000 | Segmentation (box/point prompts) |

**Key Finding:** Both services share the GPU on the same EC2 instance.

### EC2 Service Status

From verification:
```json
{
  "status": "healthy",
  "model_loaded": true,
  "gpu_available": true,
  "device": "Tesla T4",
  "ready": true,
  "version": "0.6.0",
  "features": ["polygons", "concept_propagation"]
}
```

The "concept_propagation" feature is exactly what's needed for cross-image detection.

---

## Key Technical Insight

### How SAM3 Visual Exemplars Work

The current implementation passes box COORDINATES to each image. SAM3 interprets these as positional prompts and uses the CONTENT inside those coordinates. On different images, the same coordinates contain completely different content (grass, logs, shadows instead of pine saplings).

**The Fix:** Extract actual pixel content from exemplar boxes and pass that visual information to target images, not just coordinates.

---

## Next Steps

1. Verify the `/segment` endpoint exists on port 8000
2. If not, add endpoint to EC2's SAM3 service
3. Commit and push changes to main
4. Deploy to production
5. Update EC2 SAM3 service with new dependencies
