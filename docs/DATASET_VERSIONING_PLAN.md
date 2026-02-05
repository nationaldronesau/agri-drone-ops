# Dataset Versioning & Local YOLO Training Pipeline

## Overview

Implement Roboflow-style dataset versioning in AgriDrone Ops to enable reproducible model training, checkpoint-based improvements, and local YOLO training on our EC2 GPU instance.

**Goal:** Add more imagery to a project → Create frozen dataset version → Train YOLO locally (from checkpoint) → Deploy improved model

---

## ✅ CONFIRMED Architecture Decisions (User + Codex Review)

### Decision 1: Extend TrainingDataset (NOT new DatasetVersion model)
- **Why:** TrainingDataset already exists at lines 718-759 of schema, is wired to TrainingJob
- **Benefit:** No duplicate models, simpler migration, preserves existing training flows
- **Change:** Add versioning fields (`version`, `snapshotAt`, `status`, `idempotencyKey`, etc.)

### Decision 2: S3 Manifest + Checksum for Annotations (NOT join table)
- **Why:** Lighter DB, better for large datasets with thousands of annotations
- **Benefit:** Reproducibility via checksum, audit trail via manifest file
- **Storage:** `TrainingDatasetAsset` join table (queryable) + `annotationManifestS3Key` + `annotationManifestChecksum` (S3)

### Decision 3: Project-Level Feature Flags
- **Implementation:** `Project.features Json?` field
- **Flag:** `{ "datasetVersions": true }` to enable per-project
- **Fallback:** Environment variable `ENABLE_DATASET_VERSIONS=true` for global override

### Codex Safety Recommendations (All Adopted)

| Concern | Solution |
|---------|----------|
| Version concurrency | Transaction with `SELECT FOR UPDATE` on project |
| Snapshot consistency | `snapshotAt` timestamp + time-based filtering |
| GPU mutex | Redis lock with TTL + heartbeat + force-unlock on restart |
| Status reconciliation | Reconciliation job for stuck TRAINING states |
| API idempotency | `idempotencyKey` parameter on POST /versions |

---

## Architecture (Final)

```
PROJECT (= Dataset Container)
├── Assets (images, organized by upload batches)
├── Annotations (manual + SAM3 + AI detections)
├── TrainingDataset (EXTENDED as versions) ← MODIFIED
│   ├── v1: 500 images + preprocessing config + S3 manifest
│   ├── v2: 1000 images + trained from v1 checkpoint
│   └── v3: 1500 images + trained from v2 checkpoint
└── TrainedModel (trained outputs) ← EXISTS
    ├── v1.pt: 75% mAP
    ├── v2.pt: 85% mAP
    └── v3.pt: 92% mAP ← Currently deployed
```

**Key Insight:** We reuse `TrainingDataset` as the version entity - no new model needed.

---

## Infrastructure Overview

### Current EC2 Setup
- **Instance:** g4dn.xlarge (Tesla T4 16GB GPU)
- **Services:** SAM3 segmentation service
- **GPU Sharing:** SAM3 unloads when YOLO needs GPU (`/api/v1/unload` endpoint)

### Proposed Changes
| Component | Current | Proposed |
|-----------|---------|----------|
| SAM3 | Runs on EC2, unloads for training | No change |
| YOLO Training | Partially implemented (TrainingJob model) | Complete integration with versions |
| YOLO Inference | Roboflow API | **Local EC2 or Roboflow (configurable)** |
| Dataset Storage | S3 (TrainingDataset model exists) | Extend with version metadata |

---

## Phase 1: Database Schema - Extend TrainingDataset for Versioning

**GitHub Issue Title:** `feat(schema): Extend TrainingDataset with versioning and snapshot metadata`

### Changes

**File:** `prisma/schema.prisma`

#### 1. Add feature flags to Project
```prisma
model Project {
  // ... existing fields (lines 91-130) ...

  // ADD: Feature flags for gradual rollout
  features  Json?  // { "datasetVersions": true, ... }
}
```

#### 2. Extend TrainingDataset with version/snapshot fields
```prisma
model TrainingDataset {
  // ... existing fields (lines 718-759) ...

  // ADD: Version identification
  version         Int?     // Auto-increment per project (v1, v2, v3...)
  displayName     String?  // Optional friendly name: "March 2025 Release"

  // ADD: Snapshot metadata (for reproducibility)
  snapshotAt      DateTime?  // Cutoff timestamp for data inclusion
  status          DatasetStatus @default(READY)  // CREATING, READY, TRAINING, FAILED, ARCHIVED

  // ADD: Preprocessing config (Roboflow-style)
  preprocessingConfig Json?  // { resize: "640x640", tile: "4x4", autoOrient: true }

  // ADD: Annotation manifest (S3-based freeze)
  annotationManifestS3Key  String?  // S3 path to JSON manifest
  annotationManifestChecksum String?  // SHA256 for reproducibility audit
  annotationCount Int?

  // ADD: Idempotency for safe API calls
  idempotencyKey  String?  @unique

  // ADD: Filters used at creation (for documentation)
  creationFilters Json?  // { weedTypes: [...], minConfidence: 0.5, verifiedOnly: true }

  @@unique([projectId, version])  // One version number per project
}

enum DatasetStatus {
  CREATING    // Snapshot in progress
  READY       // Available for training
  TRAINING    // Currently being trained
  FAILED      // Creation failed
  ARCHIVED    // No longer active
}
```

#### 3. Create TrainingDatasetAsset join table (for asset freeze)
```prisma
model TrainingDatasetAsset {
  id              String   @id @default(cuid())
  datasetId       String
  assetId         String

  // Snapshot of key asset data at freeze time
  s3Key           String?  // Frozen S3 path
  gpsLatitude     Float?
  gpsLongitude    Float?

  createdAt       DateTime @default(now())

  dataset         TrainingDataset @relation(fields: [datasetId], references: [id], onDelete: Cascade)
  asset           Asset @relation(fields: [assetId], references: [id], onDelete: Cascade)

  @@unique([datasetId, assetId])
  @@index([datasetId])
  @@index([assetId])
}
```

#### 4. Add Asset relation
```prisma
model Asset {
  // ... existing fields ...

  // ADD: Link to frozen datasets
  trainingDatasets  TrainingDatasetAsset[]
}
```

#### 5. Add checkpoint training to TrainingJob
```prisma
model TrainingJob {
  // ... existing fields (lines 761-821) ...

  // ADD: Checkpoint training
  checkpointModelId String?  // Previous TrainedModel to train from
  checkpointModel   TrainedModel? @relation("CheckpointFrom", fields: [checkpointModelId], references: [id])
}
```

#### 6. Add checkpoint tracking to TrainedModel
```prisma
model TrainedModel {
  // ... existing fields (lines 823-883) ...

  // ADD: Track models trained from this one
  trainedFromThis   TrainingJob[] @relation("CheckpointFrom")
}
```

### Migration Safety
- All new fields are optional or have defaults
- No breaking changes to existing TrainingDataset records
- Existing TrainingJob/TrainedModel records unaffected
- Feature gated behind `Project.features.datasetVersions`

### Acceptance Criteria
- [ ] Migration runs without errors on MySQL
- [ ] Existing TrainingDataset records unaffected
- [ ] Can query TrainingDatasetAsset join table
- [ ] Idempotency key unique constraint works
- [ ] `@@unique([projectId, version])` enforced

---

## Phase 2: Dataset Version Service Layer

**GitHub Issue Title:** `feat(service): TrainingDatasetVersionService for creating and managing versions`

### New File: `lib/services/training-dataset-version.ts`

```typescript
import prisma from '@/lib/db';
import { s3Service } from '@/lib/services/s3';
import crypto from 'crypto';

class TrainingDatasetVersionService {
  /**
   * Create new version with project-scoped lock for safe concurrency
   */
  async createVersion(config: CreateVersionConfig): Promise<TrainingDataset> {
    // Check idempotency key first
    if (config.idempotencyKey) {
      const existing = await prisma.trainingDataset.findUnique({
        where: { idempotencyKey: config.idempotencyKey }
      });
      if (existing) return existing;
    }

    // Transaction with project lock for version number safety
    return prisma.$transaction(async (tx) => {
      // Lock project row to prevent concurrent version creation
      await tx.$executeRaw`SELECT id FROM Project WHERE id = ${config.projectId} FOR UPDATE`;

      // Get next version number
      const maxVersion = await tx.trainingDataset.aggregate({
        where: { projectId: config.projectId, version: { not: null } },
        _max: { version: true }
      });
      const nextVersion = (maxVersion._max.version || 0) + 1;

      // Create snapshot timestamp
      const snapshotAt = new Date();

      // Snapshot assets (via join table)
      const assets = await this.snapshotAssets(tx, config.projectId, snapshotAt, config.filters);

      // Create annotation manifest and upload to S3
      const { manifestKey, checksum, annotationCount } = await this.createAnnotationManifest(
        tx, config.projectId, snapshotAt, config.filters
      );

      // Create the versioned dataset
      const dataset = await tx.trainingDataset.create({
        data: {
          name: config.name || `${config.projectId}-v${nextVersion}`,
          displayName: config.displayName,
          version: nextVersion,
          snapshotAt,
          status: 'CREATING',
          projectId: config.projectId,
          teamId: config.teamId,
          imageCount: assets.length,
          labelCount: annotationCount,
          classes: JSON.stringify(config.classes || []),
          trainCount: Math.floor(assets.length * (config.splits?.train || 0.8)),
          valCount: Math.floor(assets.length * (config.splits?.val || 0.15)),
          testCount: Math.floor(assets.length * (config.splits?.test || 0.05)),
          preprocessingConfig: config.preprocessing,
          augmentationPreset: config.augmentation?.preset,
          augmentationConfig: JSON.stringify(config.augmentation),
          annotationManifestS3Key: manifestKey,
          annotationManifestChecksum: checksum,
          annotationCount,
          idempotencyKey: config.idempotencyKey,
          creationFilters: config.filters,
          s3Bucket: process.env.S3_BUCKET || '',
          s3Path: `datasets/${config.projectId}/v${nextVersion}/`,
        }
      });

      // Create asset join records
      await tx.trainingDatasetAsset.createMany({
        data: assets.map(a => ({
          datasetId: dataset.id,
          assetId: a.id,
          s3Key: a.s3Key,
          gpsLatitude: a.gpsLatitude,
          gpsLongitude: a.gpsLongitude,
        }))
      });

      return dataset;
    }, {
      timeout: 30000,  // 30 second timeout for large datasets
      isolationLevel: 'Serializable'
    });
  }

  /**
   * Create annotation manifest file and upload to S3
   */
  private async createAnnotationManifest(
    tx: PrismaTransaction,
    projectId: string,
    snapshotAt: Date,
    filters?: SnapshotFilters
  ): Promise<{ manifestKey: string; checksum: string; annotationCount: number }> {
    // Query annotations with time-based snapshot
    const annotations = await tx.manualAnnotation.findMany({
      where: {
        session: { asset: { projectId } },
        createdAt: { lte: snapshotAt },
        ...(filters?.verifiedOnly && { verified: true }),
        ...(filters?.weedTypes && { weedType: { in: filters.weedTypes } }),
      },
      select: {
        id: true,
        weedType: true,
        coordinates: true,
        geoCoordinates: true,
        confidence: true,
        sessionId: true,
      }
    });

    // Build manifest
    const manifest = {
      snapshotAt: snapshotAt.toISOString(),
      projectId,
      filters,
      annotationCount: annotations.length,
      annotations: annotations.map(a => ({
        id: a.id,
        weedType: a.weedType,
        coordinates: a.coordinates,
        geoCoordinates: a.geoCoordinates,
        confidence: a.confidence,
      }))
    };

    const manifestJson = JSON.stringify(manifest, null, 2);
    const checksum = crypto.createHash('sha256').update(manifestJson).digest('hex');
    const manifestKey = `datasets/${projectId}/manifests/${snapshotAt.toISOString()}.json`;

    // Upload to S3
    await s3Service.uploadBuffer(Buffer.from(manifestJson), manifestKey, 'application/json');

    return { manifestKey, checksum, annotationCount: annotations.length };
  }

  /**
   * Get next version number (for UI preview)
   */
  async getNextVersionNumber(projectId: string): Promise<number> {
    const max = await prisma.trainingDataset.aggregate({
      where: { projectId, version: { not: null } },
      _max: { version: true }
    });
    return (max._max.version || 0) + 1;
  }

  /**
   * List all versions for a project
   */
  async listVersions(projectId: string): Promise<TrainingDataset[]> {
    return prisma.trainingDataset.findMany({
      where: { projectId, version: { not: null } },
      orderBy: { version: 'desc' },
      include: {
        trainingJobs: {
          include: { trainedModel: true },
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });
  }

  /**
   * Reconciliation job: fix stuck TRAINING states
   */
  async reconcileStuckVersions(): Promise<number> {
    const stuckThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours

    const result = await prisma.trainingDataset.updateMany({
      where: {
        status: 'TRAINING',
        updatedAt: { lt: stuckThreshold }
      },
      data: { status: 'READY' }
    });

    return result.count;
  }
}

interface CreateVersionConfig {
  projectId: string
  teamId: string
  name?: string
  displayName?: string
  idempotencyKey?: string
  classes?: string[]
  preprocessing?: PreprocessingConfig
  augmentation?: AugmentationConfig
  splits?: { train: number; val: number; test: number }
  filters?: SnapshotFilters
}

interface SnapshotFilters {
  weedTypes?: string[]
  minConfidence?: number
  verifiedOnly?: boolean
  includeAIDetections?: boolean
  includeSAM3?: boolean
  includeManual?: boolean
}

export const trainingDatasetVersionService = new TrainingDatasetVersionService();
```

### Integration Points
- Uses existing `lib/services/s3.ts` for manifest storage
- Uses existing `lib/services/dataset-preparation.ts` for YOLO format export
- Queries ManualAnnotation, PendingAnnotation tables with time-based filtering

### Acceptance Criteria
- [ ] Version creation uses transaction with project lock
- [ ] Idempotency key prevents duplicate versions
- [ ] snapshotAt timestamp captures correct moment
- [ ] Annotation manifest uploads to S3 with checksum
- [ ] TrainingDatasetAsset join records created correctly
- [ ] Reconciliation job fixes stuck TRAINING states

---

## Phase 3: Version Creation API

**GitHub Issue Title:** `feat(api): POST /api/projects/[id]/versions endpoint`

### New File: `app/api/projects/[id]/versions/route.ts`

**POST** - Create new version (with idempotency)
```typescript
// Request
{
  idempotencyKey?: string,  // Prevent duplicate creates
  displayName?: string,
  preprocessing?: { resize: string, tile?: string, autoOrient?: boolean },
  augmentation?: { flip?: boolean, rotation?: number, preset?: string },
  splits?: { train: number, val: number, test: number },
  filters?: {
    weedTypes?: string[],
    minConfidence?: number,
    verifiedOnly?: boolean,
  }
}

// Response
{
  dataset: TrainingDataset,  // Extended with version fields
  stats: { imageCount, annotationCount, classCounts, nextVersion }
}
```

**GET** - List versions for project
```typescript
// Response
{
  versions: TrainingDataset[],  // Only records with version != null
  project: { id, name, totalImages, totalAnnotations },
  featureEnabled: boolean  // Whether datasetVersions feature is on
}
```

### New File: `app/api/projects/[id]/versions/[versionId]/route.ts`

**GET** - Get version details with training history
**PATCH** - Update status (for reconciliation)
**DELETE** - Archive version (soft delete, sets status: ARCHIVED)

### Feature Gate Check
```typescript
// In route handler
const project = await prisma.project.findUnique({ where: { id } });
const features = project?.features as { datasetVersions?: boolean } | null;

if (!features?.datasetVersions && !process.env.ENABLE_DATASET_VERSIONS) {
  return NextResponse.json({ error: 'Feature not enabled' }, { status: 403 });
}
```

### Acceptance Criteria
- [ ] Auth required (team membership via `canManageTeam`)
- [ ] Feature gate checked before allowing version creation
- [ ] Idempotency key returns existing version if duplicate
- [ ] Version creation validates project has annotated images
- [ ] Returns 400 if no images match filters
- [ ] Lists versions in descending order (newest first)
- [ ] Archive (DELETE) sets status to ARCHIVED, doesn't hard delete

---

## Phase 4: Version Management UI

**GitHub Issue Title:** `feat(ui): Dataset Versions tab in Project view`

### New Component: `components/features/dataset-versions.tsx`

**Version List View:**
```
┌─────────────────────────────────────────────────────────────┐
│ Dataset Versions                        [+ New Version]     │
├─────────────────────────────────────────────────────────────┤
│ v3 - March 2025 Release          1,632 images  4 classes   │
│ ├─ Created: Mar 15, 2025 by Ben                            │
│ ├─ Model: pine-sapling-v3.pt (91.9% mAP) ✓ Deployed        │
│ └─ [Train New Model] [Download] [Compare]                  │
├─────────────────────────────────────────────────────────────┤
│ v2 - Initial Training            1,000 images  3 classes   │
│ ├─ Created: Mar 10, 2025 by Manas                          │
│ ├─ Model: pine-sapling-v2.pt (84.1% mAP)                   │
│ └─ [Train New Model] [Download] [Compare]                  │
└─────────────────────────────────────────────────────────────┘
```

**Create Version Dialog:**
```
┌─────────────────────────────────────────────────────────────┐
│ Create Dataset Version                               [×]    │
├─────────────────────────────────────────────────────────────┤
│ Name: [March 2025 Release________________]                  │
│                                                             │
│ Source Data                                                 │
│ ├─ Total Images: 1,632                                     │
│ ├─ Total Annotations: 4,521                                │
│ └─ Classes: pine_sapling (3,200), wattle (1,100), ...      │
│                                                             │
│ Preprocessing                                               │
│ ├─ [×] Resize to: [640×640 ▼]                              │
│ ├─ [×] Auto-Orient                                         │
│ └─ [ ] Tile: [4×4 ▼]                                       │
│                                                             │
│ Augmentation                                                │
│ ├─ Multiplier: [3× ▼] (4,896 training images)              │
│ ├─ [×] Horizontal Flip                                     │
│ ├─ [×] Rotation: ±15°                                      │
│ └─ [ ] Brightness: ±10%                                    │
│                                                             │
│ Data Split                                                  │
│ ├─ Train: [80%] Val: [15%] Test: [5%]                      │
│ └─ Preview: 1,305 / 245 / 82 images                        │
│                                                             │
│                              [Cancel] [Create Version]      │
└─────────────────────────────────────────────────────────────┘
```

### Page Changes

**Modify:** `app/projects/[id]/page.tsx`
- Add "Versions" tab alongside existing content
- Show version count badge

### Acceptance Criteria
- [ ] Version list shows all versions with stats
- [ ] Create dialog validates inputs
- [ ] Shows preview of data split
- [ ] Loading states during creation
- [ ] Success redirects to version detail

---

## Phase 5: Training from Version (Checkpoint Support)

**GitHub Issue Title:** `feat(training): Train YOLO from dataset version with checkpoint support`

### Modify: `app/api/training/start/route.ts`

```typescript
// Request
{
  datasetVersionId: string,
  config: {
    baseModel: 'yolov11n' | 'yolov11s' | 'yolov11m' | 'yolov11l' | 'yolov11x',
    epochs: number,
    batchSize: number,
    imageSize: number,
    learningRate?: number,
  },
  checkpointModelId?: string,  // Train from previous model
}
```

### Training Flow
```
1. Validate version exists and is READY
2. If checkpointModelId provided:
   - Download checkpoint weights from S3
   - Use as starting point for training
3. Update version status to TRAINING
4. Call existing YOLO training service
5. On completion:
   - Create TrainedModel linked to version
   - Update version status back to READY
```

### UI: Train from Version Dialog
```
┌─────────────────────────────────────────────────────────────┐
│ Train Model from v3                                  [×]    │
├─────────────────────────────────────────────────────────────┤
│ Dataset: v3 - March 2025 Release (1,632 images)            │
│                                                             │
│ Training Configuration                                      │
│ ├─ Base Model: [YOLOv11-Medium ▼]                          │
│ ├─ Epochs: [100___]                                        │
│ ├─ Batch Size: [16__]                                      │
│ └─ Image Size: [640_]                                      │
│                                                             │
│ Checkpoint (Recommended)                                    │
│ ├─ (●) Train from: [pine-sapling-v2.pt (84.1% mAP) ▼]     │
│ ├─ ( ) Train from COCO pretrained                          │
│ └─ ( ) Train from scratch (not recommended)                │
│                                                             │
│ Estimated: ~2 hours on T4 GPU                              │
│                                                             │
│                              [Cancel] [Start Training]      │
└─────────────────────────────────────────────────────────────┘
```

### Acceptance Criteria
- [ ] Training job links to dataset version
- [ ] Checkpoint download works from S3
- [ ] Training uses checkpoint as starting weights
- [ ] Model links back to version after completion

---

## Phase 6: Inference Configuration

**GitHub Issue Title:** `feat(inference): Configurable inference backend (Local vs Roboflow)`

### Decision: Where Should Inference Run?

| Option | Pros | Cons |
|--------|------|------|
| **Roboflow API** | No infra management, scalable | Cost per inference, latency, API key in URLs |
| **Local EC2** | No per-inference cost, faster, custom models | GPU memory sharing with SAM3, single instance |
| **Hybrid** | Best of both | Complexity |

**Recommendation:** Hybrid approach with configuration
- Default: Local EC2 for YOLO inference (shares T4 with SAM3)
- Fallback: Roboflow if local unavailable
- User configurable per-project

### New Service: `lib/services/yolo-inference.ts`

```typescript
class YOLOInferenceService {
  // Run inference on image
  async detect(request: DetectionRequest): Promise<Detection[]>

  // Get available models (local + Roboflow)
  async listModels(): Promise<InferenceModel[]>

  // Load model into GPU memory
  async loadModel(modelId: string): Promise<void>

  // Unload to free GPU for SAM3
  async unloadModel(): Promise<void>

  // Health check
  async getStatus(): Promise<InferenceStatus>
}

interface DetectionRequest {
  imageBuffer: Buffer
  modelId: string        // TrainedModel.id or Roboflow model ID
  backend?: 'local' | 'roboflow' | 'auto'
  confidence?: number
  iou?: number
}
```

### EC2 Changes Required

**New endpoint on SAM3 service (or separate YOLO service):**
```
POST /api/v1/yolo/detect
  - Load model if not loaded
  - Run inference
  - Return detections

POST /api/v1/yolo/load
  - Load specific model weights

POST /api/v1/yolo/unload
  - Free GPU memory

GET /api/v1/yolo/status
  - Current model loaded
  - GPU memory usage
```

**GPU Memory Management:**
```
SAM3 (~14GB) + YOLO inference (~2GB) > T4 (16GB)

Solution: Mutual exclusion
- Before SAM3: Unload YOLO
- Before YOLO inference: Unload SAM3
- Use Redis lock to prevent race conditions
```

### Acceptance Criteria
- [ ] Can run inference on local YOLO model
- [ ] Fallback to Roboflow works
- [ ] GPU memory managed correctly
- [ ] Model switching doesn't cause OOM

---

## Phase 7: EC2 Service Updates

**GitHub Issue Title:** `infra(ec2): Add YOLO inference endpoints to GPU service`

### Changes to SAM3 Service (Python FastAPI)

**File:** `services/sam3-service/app/routers/yolo.py` (NEW)

```python
from fastapi import APIRouter
from ultralytics import YOLO
import boto3

router = APIRouter(prefix="/api/v1/yolo", tags=["yolo"])

# Global model state
current_model: YOLO | None = None
current_model_id: str | None = None

@router.post("/detect")
async def detect(request: DetectRequest):
    """Run YOLO detection on image"""
    global current_model

    # Load model if needed
    if current_model is None or current_model_id != request.model_id:
        await load_model(request.model_id)

    # Run inference
    results = current_model(request.image, conf=request.confidence)
    return format_detections(results)

@router.post("/load")
async def load_model(model_id: str):
    """Load model weights from S3"""
    global current_model, current_model_id

    # Unload SAM3 first if needed
    if sam3_loaded():
        await unload_sam3()

    # Download weights from S3
    weights_path = download_weights(model_id)
    current_model = YOLO(weights_path)
    current_model_id = model_id

    return {"status": "loaded", "model_id": model_id}

@router.post("/unload")
async def unload_model():
    """Free GPU memory"""
    global current_model, current_model_id

    if current_model:
        del current_model
        torch.cuda.empty_cache()
        current_model = None
        current_model_id = None

    return {"status": "unloaded"}

@router.get("/status")
async def get_status():
    """Get current inference status"""
    return {
        "model_loaded": current_model is not None,
        "model_id": current_model_id,
        "gpu_memory": get_gpu_memory_usage()
    }
```

### Deployment Changes
- Update SAM3 service Docker image
- Add YOLO router to FastAPI app
- Ensure ultralytics installed in container

### Acceptance Criteria
- [ ] `/api/v1/yolo/detect` returns detections
- [ ] Model loading from S3 works
- [ ] GPU memory properly managed
- [ ] SAM3 and YOLO don't conflict

---

## Phase 8: Model Deployment UI

**GitHub Issue Title:** `feat(ui): Deploy trained model for inference`

### Project Settings: Active Model Selection

```
┌─────────────────────────────────────────────────────────────┐
│ Detection Model Settings                                    │
├─────────────────────────────────────────────────────────────┤
│ Active Model for AI Detection:                              │
│                                                             │
│ (●) pine-sapling-v3.pt (Local)                             │
│     91.9% mAP | Trained Mar 15, 2025 | From v3             │
│                                                             │
│ ( ) pine-sapling-v2.pt (Local)                             │
│     84.1% mAP | Trained Mar 10, 2025 | From v2             │
│                                                             │
│ ( ) Roboflow: pine-sapling-hqp-test/6                      │
│     91.9% mAP | Roboflow hosted                            │
│                                                             │
│ Inference Backend:                                          │
│ [Local EC2 (Recommended) ▼]                                │
│                                                             │
│                                        [Save Changes]       │
└─────────────────────────────────────────────────────────────┘
```

### API Changes

**Modify:** `app/api/projects/[id]/route.ts` PATCH
```typescript
// Add to existing PATCH
{
  activeModelId?: string,      // TrainedModel.id
  inferenceBackend?: 'local' | 'roboflow' | 'auto'
}
```

### Acceptance Criteria
- [ ] Can select active model for project
- [ ] Upload flow uses selected model
- [ ] Backend preference respected

---

## Implementation Order & Dependencies

```
Phase 1: Schema ──────────────────────────────────────────────┐
    │                                                         │
    ▼                                                         │
Phase 2: Service Layer ───────────────────────────────────────┤
    │                                                         │
    ▼                                                         │
Phase 3: API Routes ──────────────────────────────────────────┤
    │                                                         │ Can ship
    ▼                                                         │ incrementally
Phase 4: Version UI ──────────────────────────────────────────┤
    │                                                         │
    ▼                                                         │
Phase 5: Training from Version ───────────────────────────────┘
    │
    │ ← Requires EC2 changes
    ▼
Phase 6: Inference Service ───────────────────────────────────┐
    │                                                         │
    ▼                                                         │ Parallel
Phase 7: EC2 Updates ─────────────────────────────────────────┤ development
    │                                                         │
    ▼                                                         │
Phase 8: Deployment UI ───────────────────────────────────────┘
```

---

## EC2 Changes Summary

| Change | File/Location | Description |
|--------|---------------|-------------|
| YOLO inference router | `services/sam3-service/app/routers/yolo.py` | New FastAPI router |
| Model loading | Same | Download weights from S3 |
| GPU mutex | `services/sam3-service/app/gpu_manager.py` | Prevent SAM3/YOLO conflicts |
| Docker update | `services/sam3-service/Dockerfile` | Add ultralytics dependency |
| Terraform (optional) | `infrastructure/terraform/` | If separate YOLO service needed |

---

## Inference Location Decision Matrix

| Scenario | Recommended Backend | Reason |
|----------|---------------------|--------|
| Upload with AI detection | Local EC2 | Batch processing, no per-image cost |
| Single image detection | Local EC2 | Fast, model already loaded |
| SAM3 + detection same session | Roboflow | Avoid GPU switching overhead |
| High volume batch job | Local EC2 | Cost savings at scale |
| EC2 unavailable | Roboflow | Automatic fallback |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Schema migration breaks existing data | All new fields optional with defaults |
| GPU OOM errors | Mutex lock, memory monitoring |
| Training job fails | Existing error handling, retry logic |
| S3 dataset corruption | Checksums, validation before training |
| EC2 service crashes | Health checks, auto-restart, Roboflow fallback |

---

## Verification Plan

### Phase 1-4 (Database + UI)
1. Run migration on dev database
2. Create version via UI
3. Verify frozen asset/annotation IDs
4. Download exported dataset, validate YOLO format

### Phase 5 (Training)
1. Train model from version
2. Verify checkpoint loading works
3. Compare metrics: from-scratch vs from-checkpoint
4. Confirm model saved to S3

### Phase 6-8 (Inference)
1. Load local model, run detection
2. Verify GPU memory management
3. Test SAM3 → YOLO → SAM3 switching
4. Confirm fallback to Roboflow works
5. End-to-end: Upload → Detect with local model → Export

---

## GitHub Issues Checklist

- [ ] #1: `feat(schema): Extend TrainingDataset with versioning and snapshot metadata`
- [ ] #2: `feat(service): TrainingDatasetVersionService for creating and managing versions`
- [ ] #3: `feat(api): POST /api/projects/[id]/versions endpoint`
- [ ] #4: `feat(ui): Dataset Versions tab in Project view`
- [ ] #5: `feat(training): Train YOLO from dataset version with checkpoint support`
- [ ] #6: `feat(inference): Configurable inference backend (Local vs Roboflow)`
- [ ] #7: `infra(ec2): Add YOLO inference endpoints to GPU service`
- [ ] #8: `feat(ui): Deploy trained model for inference`

---

## Rollout Strategy (Codex-Recommended)

### Safe Deployment Order
1. **Expand-only schema first** - Deploy schema changes with no code using them
2. **Service + API behind feature flag** - Gate with `Project.features.datasetVersions`
3. **Shadow-mode validation** - Create versions in staging, compare to current pipeline
4. **UI rollout in parallel** - New tab/route, behind same feature flag
5. **Training from version (limited beta)** - Internal projects first
6. **Inference backend changes last** - Keep Roboflow default until local stable

### Testing/Verification Matrix
| Test Type | What to Test |
|-----------|--------------|
| Unit | Snapshot logic, augmentation math, split calculations |
| Integration | POST/GET /versions, training start, checkpoint loading |
| E2E | Create version → Train → Model appears → Select active |
| Load | Version with 10k+ assets (simulated) |
| Failure | GPU lock contention, S3 download failure, SAM3 crash |
