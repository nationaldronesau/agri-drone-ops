# Changelog

All notable changes to the AgriDrone Ops platform are documented here.

## [Unreleased]

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
