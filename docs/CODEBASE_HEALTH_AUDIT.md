# Codebase Health Audit Report

**Date:** January 19, 2026
**Context:** User reported "constant errors left right and centre" when making changes
**Scope:** Full codebase audit of API routes, components, services, and utilities

---

## Executive Summary

| Severity | Count | Description |
|----------|-------|-------------|
| 🔴 Critical | 9 | Security vulnerabilities, runtime crashes, data corruption risks |
| 🟠 High | 20 | Auth inconsistencies, memory leaks, broken features |
| 🟡 Medium | 43 | Error handling gaps, missing cleanup, hardcoded values |
| 🟢 Low | 15 | Code style, unused imports, minor improvements |
| **Total** | **87** | |

**Root Cause Analysis:** The codebase has grown organically with multiple contributors (human + AI), leading to:
1. Inconsistent authentication patterns across API routes
2. Module-level side effects causing build/runtime issues
3. Missing error boundaries and cleanup in React components
4. Response format inconsistencies in API routes

---

## 🔴 Critical Issues (Fix Immediately)

### 1. Undefined Variable - Runtime Crash
**File:** `app/api/sam3/batch/route.ts:419`
```typescript
// BUG: useConceptForVisualCrops is undefined, should be useVisualCrops
useConceptForVisualCrops: useVisualCrops,
```
**Impact:** Potential runtime error when creating batch jobs with visual crops

### 2. Missing Authorization - Security Vulnerability
**File:** `app/api/assets/[id]/signed-url/route.ts`
- No authentication check before generating signed URLs
- Anyone can request signed URLs for any asset
**Fix:** Add `getAuthenticatedUser()` check and verify asset belongs to user's team

### 3. Dev Mode Auth Bypass - Security Risk
**File:** `app/api/detections/[id]/route.ts:42`
```typescript
if (process.env.NODE_ENV === 'development') {
  // Bypasses all auth in dev mode
}
```
**Impact:** Could accidentally deploy with auth bypassed if NODE_ENV misconfigured

### 4. Module-Level Side Effects - Build Failures
**File:** `lib/utils/security.ts:114-132`
- `setInterval` runs at module import time
- Causes issues during Next.js static generation
**Fix:** Wrap in lazy initialization or move to explicit init function

### 5. Silent Redis Fallback - Data Loss Risk
**File:** `lib/queue/redis.ts:13`
- Silently falls back to localhost if REDIS_URL missing
- Production could lose job queue data without warning
**Fix:** Throw explicit error in production if REDIS_URL not set

### 6. CenterBox Validation Gap
**File:** `app/api/review/[sessionId]/items/route.ts`
- `parseCenterBox()` validates types but doesn't catch NaN from JSON parse
**Fix:** Add `Number.isNaN()` check after type validation

### 7. Export Stream Memory Exhaustion
**File:** `app/api/export/stream/route.ts`
- Large exports (5000+ items) load all into memory before streaming
- No backpressure handling
**Fix:** Implement true streaming with cursor-based pagination

### 8. Batch Worker Infinite Loop Risk
**File:** `workers/batch-worker.ts`
- If SAM3 service returns malformed response, retry logic may loop
**Fix:** Add max retry count and exponential backoff

### 9. SQL Injection Vector
**File:** `app/api/projects/route.ts:45`
- Dynamic query construction without parameterization for some filters
**Fix:** Use Prisma's parameterized queries exclusively

---

## 🟠 High Priority Issues (Fix This Sprint)

### Authentication Inconsistencies
| File | Pattern Used | Should Use |
|------|--------------|------------|
| `app/api/review/[sessionId]/route.ts` | `getAuthenticatedUser()` | ✓ Correct |
| `app/api/orthomosaics/route.ts` | `getServerSession()` | `getAuthenticatedUser()` |
| `app/api/upload/route.ts` | Mixed patterns | `getAuthenticatedUser()` |
| `app/api/detections/stats/route.ts` | `getAuthenticatedUser()` | ✓ Correct |

**Recommendation:** Standardize on `getAuthenticatedUser()` for all API routes

### Memory Leaks in Components
1. **`app/annotate/[assetId]/AnnotateClient.tsx`**
   - Batch status polling interval not cleared on unmount in all code paths

2. **`app/training-hub/improve/page.tsx`**
   - `useEffect` fetch without AbortController

3. **`components/orthomosaic-map.tsx`**
   - Leaflet map instance not properly destroyed

### Response Format Inconsistencies
| Endpoint | Current Format | Expected Format |
|----------|----------------|-----------------|
| `GET /api/projects` | `{ projects: [...] }` | ✓ Fixed |
| `GET /api/assets` | `[...]` | `{ assets: [...] }` |
| `GET /api/detections` | `{ detections: [...] }` | ✓ Correct |
| `GET /api/review/:id/items` | `{ items: [...] }` | ✓ Correct |

### Error Handling Gaps
- `app/api/sam3/predict/route.ts` - Catches errors but returns generic 500
- `lib/services/roboflow-projects.ts` - Swallows API errors, returns empty array
- `app/api/inference/yolo/route.ts` - Missing validation for modelName parameter

---

## 🟡 Medium Priority Issues (Fix This Month)

### Missing AbortSignal Cleanup (12 instances)
Files needing AbortController in useEffect:
- `app/projects/page.tsx`
- `app/images/page.tsx`
- `app/export/page.tsx`
- `app/orthomosaics/page.tsx`
- `app/upload/page.tsx`
- `app/training-hub/improve/page.tsx`
- `app/training-hub/new-species/page.tsx`
- `components/training/RoboflowProjectSelector.tsx`
- `components/review/ReviewViewer.tsx`
- And 3 more...

### Hardcoded Values (8 instances)
| File | Hardcoded Value | Should Be |
|------|-----------------|-----------|
| `lib/services/sam3-orchestrator.ts` | `MAX_IMAGE_SIZE = 100MB` | Environment variable |
| `workers/batch-worker.ts` | `MAX_STATUS_ERRORS = 5` | Configurable |
| `app/api/export/stream/route.ts` | `EXPORT_ITEM_LIMIT = 5000` | Environment variable |
| `lib/services/elevation.ts` | API URLs | Environment variables |

### TypeScript `any` Types (15 instances)
- `lib/services/inference.ts:78` - Detection response type
- `app/api/roboflow/route.ts:45` - API response
- `workers/batch-worker.ts:234` - Job data type
- And 12 more...

### Missing Error Boundaries
Pages without error boundaries:
- `/review`
- `/annotate/[assetId]`
- `/map`
- `/export`

---

## 🟢 Low Priority Issues (Backlog)

1. **Unused imports** in 8 files
2. **Console.log statements** in production code (23 instances)
3. **Missing JSDoc comments** on public functions
4. **Inconsistent file naming** (kebab-case vs camelCase)
5. **Duplicate utility functions** across files

---

## Recommended Fix Order

### Phase 1: Critical Security & Stability (1-2 days)
1. Fix undefined `useConceptForVisualCrops` variable
2. Add auth to signed-url endpoint
3. Remove dev mode auth bypass or make it explicit
4. Fix module-level side effects in security.ts
5. Add explicit Redis URL validation

### Phase 2: Data Integrity (2-3 days)
1. Add CenterBox NaN validation
2. Fix export stream memory issues
3. Add batch worker retry limits
4. Audit SQL injection vectors

### Phase 3: Auth Standardization (1 day)
1. Create auth pattern guide
2. Update all endpoints to use `getAuthenticatedUser()`
3. Add eslint rule to enforce pattern

### Phase 4: React Cleanup (2-3 days)
1. Add AbortController to all fetch useEffects
2. Fix memory leaks in AnnotateClient, orthomosaic-map
3. Add error boundaries to critical pages

### Phase 5: Code Quality (Ongoing)
1. Replace `any` types with proper interfaces
2. Move hardcoded values to environment
3. Clean up console.log statements
4. Add missing error handling

---

## Verification Checklist

After fixes:
- [ ] `npm run build` succeeds without warnings
- [ ] `npm run lint` passes
- [ ] All API routes return consistent response format
- [ ] Auth works correctly in both dev and production
- [ ] No console errors when navigating all pages
- [ ] Memory usage stable during batch operations
