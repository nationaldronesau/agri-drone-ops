# SAM3 Visual Crops Batch Status

## Current EC2 Services
- Port 8000: Legacy SAM3 (`sam3_api_ec2.py`) with `/segment` and **boxes only**
- Port 8001: YOLO training/inference
- Port 8002: Concept propagation (`sam3_api.py`) with `/api/v1/exemplars/*`

## App Behavior (Latest)
- **Visual crops batch** now routes to the **concept service** on port 8002 when configured.
- If concept service is **not** configured, visual crops fall back to `/segment` crops only on **modern** SAM3; legacy 8000 will return **unsupported**.
- Silent fallbacks are disabled for visual crops: batch jobs fail fast with explicit errors.
- Exemplars must come from a **single source image**; source dimensions are stored with exemplars.

## Key Environment Variables
- `SAM3_CONCEPT_API_URL` or `SAM3_CONCEPT_URL` (optional, full base URL to port 8002)
- `SAM3_CONCEPT_PORT` (default `8002`)
- `SAM3_SERVICE_URL` or `SAM3_API_URL` (used to derive concept URL when not explicitly set)
- `SAM3_CONCEPT_API_KEY` or `SAM3_API_KEY` (used as `X-API-Key`)
- `SAM3_EC2_INSTANCE_ID`, `SAM3_EC2_REGION`, `SAM3_EC2_PORT` (AWS instance config)
- `SAM3_IDLE_TIMEOUT_MS` (auto-shutdown idle timer for AWS instance)

## Failure Modes Now Surfaced
- Visual crops requested but **source image** could not be loaded.
- Visual crops requested but **exemplar creation** failed.
- Backend does **not** support exemplar crops (legacy API).

## UI Notes
- “Use visual crops only (skip concept propagation)” toggle defaults to **on**.
- Training Hub now pre-warms the SAM3 instance on page load.

## Next Steps / Open Items
- Option A (recommended): Keep port 8002 as visual-crops backend (current app behavior).
- Option B: Deploy `services/sam3-service` to port 8000 if you want `/segment` with `exemplar_crops`.
- Decide on **Elastic IP**:
  - Optional if AWS IP discovery is used.
  - Recommended if any endpoints are hardcoded to a fixed IP.
- Run a new batch with “visual crops only” and confirm detections.
