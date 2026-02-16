# Changelog

All notable changes to the AgriDrone Ops platform are documented here.

## [Unreleased]

### Added
- **Compliance-Aware Mission Planning** - Boundary-constrained zone generation for safer spray operations
  - New compliance data model: `ComplianceLayer` with project/team ownership and geometry storage
  - Supports layer types for `ALLOWED_AREA`, `EXCLUSION_AREA`, and reference boundaries
  - New compliance APIs:
    - `GET/POST /api/compliance-layers`
    - `GET/PATCH/DELETE /api/compliance-layers/[id]`
  - Mission planner now imports compliance boundaries from:
    - GeoJSON (`.geojson`/`.json`)
    - KML (`.kml`)
    - Zipped Shapefile (`.zip`)
  - Planning engine applies compliance logic before mission splitting:
    - Clips zones to allowed areas
    - Applies exclusion buffers in meters
    - Splits partially intersecting zones and drops fully excluded zones
  - Compliance report included in plan summary + mission pack manifest
  - Map preview overlays active compliance layers with mission zones/routes

- **Auto-Spray Mission Planner** - Converts detections/annotations into executable spray sorties
  - New mission planning data models: `SprayPlan`, `SprayMission`, `SprayZone`
  - Clusters detections by species into geospatial treatment zones with polygon geometry
  - Computes zone area, recommended dose, and chemical liters per zone
  - Splits zones into battery/tank-aware missions with route and duration estimates
  - New APIs:
    - `POST /api/spray-plans` (queue generation)
    - `GET /api/spray-plans` (list plans)
    - `GET /api/spray-plans/[id]` (plan detail)
    - `GET /api/spray-plans/[id]/export` (mission pack ZIP: CSV + KML + manifest)
  - New UI page: `/mission-planner` with plan controls, status polling, map preview, and export
  - Navigation links added in sidebar + dashboard quick actions

- **Shapefile Export** - ESRI-compatible shapefile generation for DJI Terra and GIS software
  - Generates `.shp`, `.dbf`, `.prj` files in a ZIP archive
  - WGS84 projection (EPSG:4326) for universal compatibility
  - Includes detection class, confidence scores, project metadata
  - Confidence level enum conversion (CERTAIN→100, LIKELY→75, UNCERTAIN→50)
  - Coordinate validation to prevent invalid spray drone waypoints
  - Location: `lib/services/shapefile.ts`, `app/api/export/stream/route.ts`

- **E2E Testing Framework** - Playwright-based end-to-end testing suite
  - Smoke tests for all core pages (dashboard, export, upload, map)
  - Export page tests (format selection, data source toggles, downloads)
  - API endpoint tests with authentication handling
  - Radix UI component compatibility (checkbox state assertions)
  - Run with: `npx playwright test`
  - Location: `e2e/smoke.spec.ts`, `e2e/export.spec.ts`

### Fixed
- **Training Hub Source Images Dropdown** - Projects now load correctly in the dropdown
  - Standardized `/api/projects` to return `{ projects: [...] }` format
  - Updated all consumer components to use the new format

- **SAM3 Few-Shot Mode** - Fixed 500 error when using Few-Shot detection
  - Removed non-existent `filePath` field from Prisma query
  - Production database only has `storageUrl`, `s3Key`, `s3Bucket`

- **SAM3 Health Check** - Fixed connectivity issues with AWS EC2 instance
  - Corrected health endpoint URL from `/api/v1/health` to `/health`
  - Fixed response field parsing (`model_loaded` instead of `available`)

- **Roboflow Projects Sync** - Fixed 404 error with doubled workspace in URL
  - Strip workspace prefix from projectId before API call

- **Image Size Limits** - Increased from 10MB to 100MB for drone imagery
  - DJI drone images are typically 20-50MB
  - SAM3 orchestrator resizes images before processing anyway

### Changed
- `/api/projects` now returns `{ projects: [...] }` instead of raw array

## [2025-12-03]

### Added
- SAM3 Bulk Annotation Pipeline with batch processing
- Assisted labeling UI with AI review controls

## [2025-12-02]

### Added
- Roboflow training integration for human-in-the-loop ML
- Training Hub for managing AI model training workflows

---

## API Changes

### `/api/projects` (GET)

**Before:**
```json
[
  { "id": "...", "name": "Project 1" },
  { "id": "...", "name": "Project 2" }
]
```

**After:**
```json
{
  "projects": [
    { "id": "...", "name": "Project 1" },
    { "id": "...", "name": "Project 2" }
  ]
}
```

---

## Configuration Requirements

### AWS SAM3 EC2 Instance

IAM user requires these permissions:
- `ec2:DescribeInstances`
- `ec2:StartInstances`
- `ec2:StopInstances`
- S3 read/write for image storage

Security group must allow:
- Inbound TCP port 8000 from Elastic Beanstalk security group
- CORS configured to allow production domain

### Image Processing Limits

| Setting | Value | Location |
|---------|-------|----------|
| MAX_IMAGE_SIZE | 100MB | `lib/utils/security.ts`, `workers/batch-worker.ts`, `app/api/sam3/predict/route.ts` |
| MAX_IMAGE_DIMENSION | 2048px | SAM3 orchestrator (auto-resize) |
| IMAGE_TIMEOUT | 30s | All image fetch operations |
