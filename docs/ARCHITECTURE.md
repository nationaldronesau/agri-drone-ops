# AgriDroneOps Architecture (R2 Reference)

_Last updated: 2026-02-28_

## 1) High-level system

AgriDroneOps is a Next.js monolith (UI + API routes) backed by:

- **MySQL (Prisma)** for app/state data
- **Redis + BullMQ** for async queues (batch SAM3, inference, temporal jobs)
- **S3/CloudFront** for asset storage and model/dataset artifacts
- External model services:
  - **SAM3 segmentation service** (AWS-hosted)
  - **SAM3 concept service** (visual exemplar propagation)
  - **YOLO training/inference service** (EC2-hosted)
  - **Roboflow** fallback / external training integration

Primary app host: Elastic Beanstalk env `AgriDrone`.

---

## 2) Core app layers

### Frontend pages/components
- Annotation and review UX: `app/annotate/[assetId]/AnnotateClient.tsx`, `app/review/*`, `components/review/*`
- Training workflows: `app/training-hub/*`
- Projects/assets/maps/uploads in `app/projects`, `app/images`, `app/map`, `app/upload`

### API layer (Next.js route handlers)
- SAM3 status/predict/batch/concept: `app/api/sam3/*`
- Inference run orchestration: `app/api/inference/run/route.ts`
- Training jobs and push: `app/api/training/*`, `app/api/review/[sessionId]/push/route.ts`
- Annotation classes/data: `app/api/annotation-classes/*`, `app/api/annotations/*`

### Service layer (`lib/services/*`)
- `sam3-orchestrator.ts` → backend selection/fallback between AWS SAM3 and Roboflow
- `sam3-concept.ts` → concept-service calls for visual exemplar propagation
- `yolo.ts` → YOLO EC2 service client (training + detection + discovery)
- `yolo-inference.ts` → local-first (YOLO) with Roboflow fallback
- `s3.ts` → signed URLs/download/upload/copy

### Queue layer (`lib/queue/*`, `workers/*`)
- BullMQ queues and Redis connections in `lib/queue/*`
- Batch processing worker in `workers/batch-worker.ts`

### Data layer
- Prisma schema/models in `prisma/schema.prisma`
- Important entities: `Project`, `Asset`, `Detection`, `ProcessingJob`, `BatchJob`, `AnnotationClass`, `TrainingJob`, etc.

---

## 3) How YOLO works in this app

There are two main YOLO paths:

### A) YOLO inference on project assets
1. UI/API triggers `POST /api/inference/run`
2. Route validates auth/project/model and chooses eligible assets
3. Creates a `ProcessingJob`
4. If few images (`MAX_SYNC_IMAGES`), can process synchronously via `processInferenceJob`
5. Otherwise enqueues async inference via BullMQ (`enqueueInferenceJob`)
6. Inference client (`lib/services/yolo-inference.ts`) tries:
   - local YOLO service first (`YOLOService`)
   - Roboflow fallback on failure (in `auto` mode)
7. Detections are persisted and reflected in review/annotation flows

Key files:
- `app/api/inference/run/route.ts`
- `lib/services/yolo-inference.ts`
- `lib/services/yolo.ts`

### B) YOLO training pipeline
1. Reviewed/verified labels are pushed from review/training flows
2. Dataset prepared and uploaded to S3
3. `POST /api/training/jobs` (or review push route) starts training on EC2 YOLO service
4. Training status/metrics polled via training job APIs
5. Trained model can be activated and used for inference

Key files:
- `app/api/training/jobs/route.ts`
- `app/api/review/[sessionId]/push/route.ts`
- `lib/services/yolo.ts`

### GPU coordination
- Training routes call `sam3Orchestrator.ensureGPUAvailable()`
- App uses GPU locks (`lib/services/gpu-lock`) to avoid SAM3/YOLO contention

---

## 4) SAM3 pipeline summary

### Single-image annotation
- UI places clicks/boxes in `AnnotateClient`
- Calls `/api/sam3/predict`
- Orchestrator picks AWS SAM3 first, fallback to Roboflow when needed

### Apply to all images (batch)
- UI calls `/api/sam3/batch`
- Batch job enqueued (`sam3-batch-processing` queue)
- Worker processes images, creates pending detections/annotations
- UI polls `/api/sam3/batch/[id]` for progress

### Visual exemplar mode
- Uses exemplar crops and concept service (if configured/ready)
- Requires concept endpoint auth key (`SAM3_CONCEPT_API_KEY`) and successful warmup

---

## 5) Critical runtime config (env)

Observed important variables:
- `SAM3_SERVICE_URL`
- `SAM3_CONCEPT_API_URL`
- `SAM3_CONCEPT_API_KEY` (required for concept endpoints)
- `YOLO_SERVICE_URL`
- `YOLO_SERVICE_API_KEY` (if service enforces auth)
- `REDIS_URL` / queue config
- DB connection (`DATABASE_URL`)

Config drift in these values can break core flows even when app is HTTP 200.

---

## 6) Known failure hotspots (recent)

1. **Annotation classes unavailable**
   - Root cause seen: missing `AnnotationClass` table in prod DB
2. **Visual-crops failures**
   - Concept service auth/warmup not ready (`401` / not loaded)
   - browser-side crop extraction fragility when source image/canvas constraints mismatch
3. **Queue-related degradation**
   - Redis persistence failures can stall async processing
4. **Env drift**
   - URL present but missing API key (`SAM3_CONCEPT_API_KEY`) created partial functionality

---

## 7) Operational notes

- Validate `/api/sam3/concept/status` before testing visual propagation
- Keep DB schema + code synchronized (migration discipline)
- Treat `main -> production` with explicit release readiness checks
- Prefer server-side crop/segment prep for robustness where practical
