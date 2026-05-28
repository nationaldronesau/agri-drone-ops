# Pine Sapling YOLO Inference

## Purpose

The deployed pine sapling YOLO11n-seg model is exposed through AgriDrone server
routes for v1 pine sapling detection and counting. The v1 app integration uses
bounding boxes and georeferenced box centres only. Segmentation masks and review
polygons are a follow-up.

## Runtime Configuration

Set these server-side environment variables in production:

```env
YOLO_SERVICE_URL=http://13.54.121.111:8001
YOLO_INFERENCE_URL=http://13.54.121.111:8001
PINE_SAPLING_YOLO_MODEL_ID=cmpp43ahk0001n5wgzn77vjrf
PINE_SAPLING_PROJECT_ID=cmo6ng4fp0001pm2zbo3341te
PINE_SAPLING_YOLO_MODEL_NAME=pine-saplings-yolo11n-seg-glasshouse-v1
```

Do not call the EC2 service directly from browser code. Browser/UI code should
call AgriDrone API routes only.

## Health Check

```http
GET /api/inference/health
```

This checks the configured local YOLO inference service through the server. The
EC2 raw health endpoint is `GET http://13.54.121.111:8001/health`.

## Preview A Project Run

```http
POST /api/inference/run
Content-Type: application/json
```

```json
{
  "projectId": "cmo6ng4fp0001pm2zbo3341te",
  "modelId": "cmpp43ahk0001n5wgzn77vjrf",
  "confidence": 0.25,
  "saveDetections": true,
  "preview": true
}
```

Preview returns eligible image counts without creating detections.

## Run A Small Selected Asset Test

```json
{
  "projectId": "cmo6ng4fp0001pm2zbo3341te",
  "modelId": "cmpp43ahk0001n5wgzn77vjrf",
  "assetIds": ["asset-id-1"],
  "confidence": 0.25,
  "saveDetections": true,
  "preview": false
}
```

For selected tests, use one to five assets first. Successful runs create
`Detection` rows with `customModelId = cmpp43ahk0001n5wgzn77vjrf`,
`className = Pine Sapling`, a bounding box, and `centerLat`/`centerLon` where
the asset has sufficient georeferencing metadata.

## Count Stored Pine Saplings

```http
GET /api/inference/pine-saplings/count?projectId=cmo6ng4fp0001pm2zbo3341te
```

Optional parameters:

- `modelId`: defaults to `cmpp43ahk0001n5wgzn77vjrf`.
- `reviewedOnly=true`: count only verified or user-corrected detections.
- `clusterRadiusMeters=1.5`: cluster nearby georeferenced centres to reduce
  double-counting across overlapping drone images.

With `clusterRadiusMeters=0`, each stored georeferenced detection counts as one
sapling candidate.

## Follow-Up: Segmentation Masks

The deployed model is segmentation-capable, but the current YOLO FastAPI service
returns only `bbox`. To expose masks later, patch `/opt/sam3-api/yolo_service.py`
to include `polygon?: number[][]` on each detection and return
`result.masks.xy[i]`. Then update AgriDrone persistence/review overlays to store
and render polygons.
