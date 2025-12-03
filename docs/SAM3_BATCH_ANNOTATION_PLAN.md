# SAM3 Batch Annotation Pipeline

## Overview

A human-in-the-loop ML training workflow that uses SAM3 few-shot detection to rapidly annotate hundreds of drone images for weed detection model training.

## Workflow

```
User labels 5-10 images → SAM3 processes 100s of images → User reviews → Push to Roboflow → Train model → Deploy
```

## Phase 1: Exemplar Collection UI

**Location:** `app/annotate/[assetId]/page.tsx` (extend existing)

### New UI Elements
- **Mode Toggle:** Click-to-Segment | Draw Exemplar Box | Manual Polygon
- **Exemplar Panel:** Shows collected boxes with weed type labels
- **Weed Type Selector:** Dropdown for labeling exemplars

### Box Drawing Tool
- Click and drag to draw bounding box
- Label with weed type (Lantana, Wattle, etc.)
- Store in session state
- Minimum 3 exemplars before "Find All" enabled

### Data Structure
```typescript
interface Exemplar {
  id: string;
  assetId: string;
  weedType: string;
  box: { x1: number; y1: number; x2: number; y2: number };
  imageUrl: string;  // For reference
}

interface ExemplarSession {
  id: string;
  weedType: string;
  exemplars: Exemplar[];
  targetProjectId: string;
  status: 'collecting' | 'processing' | 'reviewing' | 'completed';
}
```

## Phase 2: Batch Processing

**Location:** `app/api/sam3/batch/route.ts` (new)

### API Endpoint
```
POST /api/sam3/batch
{
  projectId: string,
  weedType: string,
  exemplars: Exemplar[],
  assetIds?: string[],  // Optional: specific images, or all in project
}
```

### Processing Flow
1. Fetch all target images from project
2. For each image:
   - Call SAM3 concept_segment with exemplar boxes + text prompt
   - Parse detections (polygons, bboxes, scores)
   - Create pending annotations in database
3. Track progress (processed/total)
4. Return summary when complete

### Database Schema Addition
```prisma
model PendingAnnotation {
  id            String   @id @default(cuid())
  assetId       String
  asset         Asset    @relation(fields: [assetId], references: [id])
  weedType      String
  confidence    Float
  polygon       Json     // [[x,y], ...]
  bbox          Json     // [x1, y1, x2, y2]
  status        String   @default("pending")  // pending, accepted, rejected
  batchId       String   // Links to batch job
  createdAt     DateTime @default(now())
}

model BatchJob {
  id            String   @id @default(cuid())
  projectId     String
  weedType      String
  exemplars     Json     // Stored exemplar boxes
  status        String   @default("queued")  // queued, processing, completed, failed
  totalImages   Int
  processedImages Int    @default(0)
  detectionsFound Int    @default(0)
  createdAt     DateTime @default(now())
  completedAt   DateTime?
}
```

## Phase 3: Review Interface

**Location:** `app/review/[batchId]/page.tsx` (new)

### Features
- **Grid View:** Thumbnails of all images with detections
- **Detection Count:** Badge showing # detections per image
- **Confidence Filter:** Slider to filter by confidence threshold
- **Bulk Actions:** Accept All, Reject All (filtered)
- **Image Detail View:** Click to see full image with annotations
- **Quick Actions:** Accept/Reject individual detections

### UI Layout
```
┌──────────────────────────────────────────────────────────────┐
│ Review: Lantana Detection Batch                    [Complete] │
│ 156 detections across 45 images | Confidence: ≥0.5          │
├──────────────────────────────────────────────────────────────┤
│ [Accept All Visible] [Reject All Visible] [Filter ▾]        │
├──────────────────────────────────────────────────────────────┤
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐            │
│ │ 📷  │ │ 📷  │ │ 📷  │ │ 📷  │ │ 📷  │ │ 📷  │            │
│ │ (3) │ │ (7) │ │ (2) │ │ (5) │ │ (1) │ │ (4) │            │
│ │ ✓✓✗ │ │ ✓✓✓ │ │ ✓✗  │ │ ✓✓✓ │ │ ✓   │ │ ✓✓✗ │            │
│ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘            │
│                                                              │
│ ... more images ...                                          │
└──────────────────────────────────────────────────────────────┘
```

### Image Detail Modal
- Full-size image with detection overlays
- Per-detection accept/reject buttons
- Edit detection (adjust polygon/box)
- Add notes

## Phase 4: Training Push

**Location:** `app/api/roboflow/training/batch/route.ts` (new)

### Batch Upload Flow
1. Fetch all accepted PendingAnnotations for batch
2. Group by asset (image)
3. For each image:
   - Upload image to Roboflow (if not already)
   - Add annotations with proper format
4. Track upload progress
5. Update PendingAnnotation status to "pushed"

### Integration with Existing
- Leverage existing `pushToTraining` function
- Add batch capability
- Handle rate limiting (Roboflow API limits)

## Phase 5: Dashboard Integration

### New Dashboard Sections
- **Active Batch Jobs:** Show processing status
- **Pending Reviews:** Link to review pages
- **Training Progress:** Show Roboflow training status

### Project Page Updates
- "Start Few-Shot Annotation" button
- Batch job history
- Detection statistics

## API Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sam3/predict` | POST | Single image click/box segmentation |
| `/api/sam3/batch` | POST | Start batch processing job |
| `/api/sam3/batch/[id]` | GET | Get batch job status |
| `/api/sam3/batch/[id]/cancel` | POST | Cancel running job |
| `/api/annotations/pending` | GET | List pending annotations |
| `/api/annotations/pending/[id]` | PATCH | Accept/reject annotation |
| `/api/annotations/pending/batch` | POST | Bulk accept/reject |
| `/api/roboflow/training/batch` | POST | Push accepted annotations |

## Implementation Order

1. **Phase 1a:** Box drawing tool in annotation UI
2. **Phase 1b:** Exemplar collection panel
3. **Phase 2a:** Database schema for pending annotations
4. **Phase 2b:** Batch processing API (synchronous first)
5. **Phase 3a:** Basic review page (grid + accept/reject)
6. **Phase 3b:** Image detail modal
7. **Phase 4:** Batch training push
8. **Phase 5:** Dashboard integration

## Estimated Effort

| Phase | Complexity | Priority |
|-------|------------|----------|
| Phase 1 | Medium | High |
| Phase 2 | High | High |
| Phase 3 | Medium | High |
| Phase 4 | Low | Medium |
| Phase 5 | Low | Low |

## Success Metrics

- Time to annotate 100 images: < 30 minutes (vs hours manually)
- False positive rate after review: < 10%
- Model accuracy after training: > 85% mAP
