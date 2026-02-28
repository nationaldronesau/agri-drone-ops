# AgriDroneOps User Flows (R2 Reference)

_Last updated: 2026-02-28_

## 1) Project + asset onboarding

1. User creates/opens project
2. Uploads imagery
3. Assets are stored (S3/CloudFront) and indexed in DB
4. Project appears in Images/Map/Review workflows

Primary surfaces:
- `app/upload`
- `app/projects`
- `app/images`

---

## 2) Single-image annotation flow (SAM3/manual)

1. Open `annotate/[assetId]`
2. Load project classes + existing annotations
3. Choose mode:
   - SAM3 segment clicks
   - manual polygon/box
4. Save accepted annotations
5. Optional: run Label Assist for model proposals

APIs used:
- `/api/annotation-classes`
- `/api/sam3/status`
- `/api/sam3/predict`
- `/api/inference/run` (Label Assist)

Failure indicators:
- class panel warning (fallback defaults)
- SAM3 unavailable badge
- prediction/rate-limit error banners

---

## 3) Apply-to-all flow (batch SAM3)

1. On source image, user draws exemplars
2. Clicks Apply to All Images
3. Client submits batch job
4. Worker processes project images asynchronously
5. UI shows progress and errors/warnings

APIs/queues:
- `/api/sam3/batch` (create)
- BullMQ queue `sam3-batch-processing`
- `/api/sam3/batch/[id]` (poll status)

Success criteria:
- processed image count advances
- detections/pending annotations created

Warning state:
- job may complete with warnings (degraded path/fallback)

---

## 4) Review and push flow

1. User reviews AI detections (approve/reject/correct)
2. Finalized session pushed to:
   - Roboflow
   - YOLO pipeline
   - or both
3. Dataset artifacts created/uploaded
4. Training/inference jobs updated

APIs:
- `/api/review/*`
- `/api/review/[sessionId]/push`
- `/api/training/*`

---

## 5) YOLO training flow

1. User opens Training Hub / YOLO dashboard
2. Starts training job with config (base model, epochs, etc.)
3. App ensures GPU availability and lock
4. YOLO EC2 service runs training
5. Progress/metrics shown in job views
6. Model can be activated for inference

APIs:
- `/api/training/jobs`
- `/api/training/jobs/[id]/*`
- `/api/training/models/[id]/activate`

---

## 6) Inference-on-project flow

1. User selects model + project scope
2. Requests preview and/or run
3. App validates asset eligibility
4. Runs sync (small) or queued async inference
5. Detections appear in review/annotation/map

API:
- `/api/inference/run`

Backends:
- Local YOLO first
- Roboflow fallback if configured/needed

---

## 7) Mission planning / temporal insights (high-level)

1. User initiates temporal comparison or spray-plan generation
2. Jobs queued
3. Results surfaced in mission planning/insights views

APIs involve:
- `/api/projects/[id]/temporal-runs/*`
- `/api/spray-plans`

---

## 8) Fast triage checklist when users say “it’s broken”

1. **Image load?** (asset URLs/signed URL path)
2. **Classes load?** (`/api/annotation-classes`)
3. **SAM3 status healthy?** (`/api/sam3/status`)
4. **Concept ready?** (`/api/sam3/concept/status`)
5. **Queue healthy?** Redis + worker + batch job progression
6. **Model/inference path healthy?** `/api/inference/run` preview + run

This order usually isolates breakpoints quickly.
