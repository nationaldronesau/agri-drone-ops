# Pre-Production Fixes Tracking

**Created**: 2024-12-12
**Status**: IN PROGRESS

## Critical Blockers (Week 1) - COMPLETED

### 1. [x] Fix `buildUserUploadKey()` Missing Method
- **File**: `lib/services/s3.ts:287`
- **Issue**: Method called but not defined - causes runtime crash
- **Fix**: Replaced with existing `generateKey()` method
- **Status**: ✅ COMPLETED (2024-12-12)

### 2. [x] Fix S3 `copyObject()` Wrong Command
- **File**: `lib/services/s3.ts:447`
- **Issue**: Uses `PutObjectCommand` with `CopySource` (should be `CopyObjectCommand`)
- **Fix**: Imported and used correct `CopyObjectCommand`
- **Status**: ✅ COMPLETED (2024-12-12)

### 3. [x] Fix Session API Response Format Mismatch
- **File**: `app/training-hub/review/[batchId]/page.tsx:186, 256`
- **Issue**: Frontend expects `sessionData.session?.id` but API returns `sessionData.id`
- **Fix**: Changed to `sessionData.id` to match API response
- **Status**: ✅ COMPLETED (2024-12-12)

### 4. [x] Add CSV Export Escaping
- **File**: `app/export/page.tsx:125-162`
- **Issue**: No RFC 4180 CSV escaping - breaks spray drone imports
- **Fix**: Added `escapeCSV()` function applied to all field values
- **Status**: ✅ COMPLETED (2024-12-12)

### 5. [x] Add KML/XML Export Escaping
- **File**: `app/export/page.tsx:164-229`
- **Issue**: No XML entity encoding - creates invalid KML
- **Fix**: Added `escapeXML()` function applied to all interpolated values
- **Status**: ✅ COMPLETED (2024-12-12)

### 6. [x] Add GPS Coordinate Validation
- **File**: `app/api/upload/route.ts:171-173`
- **Issue**: No validation of lat/lon ranges - SAFETY CRITICAL for spray drones
- **Fix**: Added `isValidGPSCoordinate()` and `isValidAltitude()` validators
- **Status**: ✅ COMPLETED (2024-12-12)

### 7. [x] Add Export Coordinate Validation
- **File**: `app/export/page.tsx:110-135`
- **Issue**: NaN, Infinity, out-of-bounds values exported
- **Fix**: Added `isValidCoordinate()` filter function
- **Status**: ✅ COMPLETED (2024-12-12)

---

## High Priority - Roboflow Branding (Week 2)

### 8. [ ] Remove Roboflow References from Annotation Page
- **File**: `app/annotate/[assetId]/page.tsx`
- **Lines**: 649, 653, 657
- **Status**: PENDING

### 9. [ ] Remove Roboflow References from AnnotationList
- **File**: `components/annotation/AnnotationList.tsx`
- **Lines**: 233, 244
- **Status**: PENDING

### 10. [ ] Remove Roboflow References from Training Pages
- **Files**:
  - `app/training/page.tsx` (lines 132, 197-211)
  - `app/training-hub/new-species/page.tsx` (lines 251-293)
  - `app/training-hub/new-species/push/page.tsx` (lines 159-367)
  - `app/training-hub/improve/page.tsx` (lines 285-312)
- **Status**: PENDING

### 11. [ ] Remove Roboflow References from Components
- **Files**:
  - `components/training/RoboflowProjectSelector.tsx`
  - `components/training/CreateProjectDialog.tsx`
  - `components/training/ClassSelector.tsx`
  - `components/detection/ModelSelector.tsx`
- **Status**: PENDING

### 12. [ ] Remove Roboflow Reference from Landing Page
- **File**: `app/page.tsx:170`
- **Status**: PENDING

---

## Security Fixes (Week 2)

### 13. [ ] Sanitize API Error Messages
- **Files**: 27+ API routes expose internal error details
- **Status**: PENDING

### 14. [ ] Add Project Ownership Verification
- **File**: `app/api/upload/route.ts:90`
- **Status**: PENDING

### 15. [ ] Move Hardcoded Workspace ID to Environment
- **File**: `lib/services/roboflow.ts:8`
- **Status**: PENDING

---

## Data Integrity Fixes (Week 3)

### 16. [ ] Add Polygon Coordinate Validation
- **File**: `app/export/page.tsx:204-217`
- **Status**: PENDING

### 17. [ ] Fix Detection Type Normalization
- **Files**: `app/api/detections/route.ts`, `app/export/page.tsx:83`
- **Status**: PENDING

### 18. [ ] Add API Pagination
- **Files**: `app/api/detections/route.ts`, `app/api/annotations/export/route.ts`
- **Status**: PENDING

---

## Progress Log

| Date | Item | Status | Notes |
|------|------|--------|-------|
| 2024-12-12 | Investigation complete | DONE | 63+ issues identified |
| 2024-12-12 | Critical fixes started | DONE | 4 parallel agents launched |
| 2024-12-12 | S3 service fixes | DONE | buildUserUploadKey + CopyObjectCommand |
| 2024-12-12 | Session API fix | DONE | Response format mismatch resolved |
| 2024-12-12 | Export security | DONE | CSV/KML escaping + coordinate validation |
| 2024-12-12 | GPS validation | DONE | Safety-critical coordinate validation |
| 2024-12-12 | Build verified | DONE | All fixes compile successfully |

---

## Terminology Replacements (for Roboflow removal)

| Current | Replace With |
|---------|--------------|
| "Push to Roboflow" | "Upload for Training" |
| "Roboflow Project" | "Training Project" |
| "Roboflow Dashboard" | "Training Dashboard" |
| "Open Roboflow" | "View Training Status" |
| "Sent to Roboflow" | "Uploaded for Training" |
| "Sync from Roboflow" | "Sync Training Data" |
