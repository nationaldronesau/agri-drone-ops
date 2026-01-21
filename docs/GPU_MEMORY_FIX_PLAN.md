# Plan: Fix GPU Memory Conflict Between SAM3 and YOLO Training

## Status: ✅ IMPLEMENTED

**Build Status:** ✓ Compiled successfully

---

## Problem
SAM3 model holds 14GB GPU memory, leaving no room for YOLO training on the shared T4 GPU (16GB total). Training jobs fail with "CUDA out of memory".

## Root Cause
No coordination between services - YOLO training starts without checking/releasing SAM3 memory.

## Solution
Add SAM3 instance cleanup before YOLO training starts in all three affected API routes.

---

## Implementation

### 1. ✅ Add cleanup method to SAM3 orchestrator
**File:** `lib/services/sam3-orchestrator.ts`

Added `ensureGPUAvailable()` method that:
- Checks if SAM3 instance is running
- If running, calls `stopInstance()` and polls until fully stopped
- Returns success/failure with descriptive message
- 2-minute timeout with 5-second polling interval
- Handles all states: stopped, running, ready, warming, starting, stopping

```typescript
async ensureGPUAvailable(timeoutMs: number = 120000): Promise<{ success: boolean; message: string }>
```

### 2. ✅ Update Push to YOLO route
**File:** `app/api/review/[sessionId]/push/route.ts`

- Added import for `sam3Orchestrator`
- Before `yoloService.startTraining()`: calls `ensureGPUAvailable()`
- If fails: updates job to FAILED status and returns 503 error
- If succeeds: proceeds with training

### 3. ✅ Update Training Jobs route
**File:** `app/api/training/jobs/route.ts`

- Added import for `sam3Orchestrator`
- Before `yoloService.startTraining()`: calls `ensureGPUAvailable()`
- If fails: updates job to FAILED status and returns 503 error
- If succeeds: proceeds with training

### 4. ✅ Update Training Job Start route
**File:** `app/api/training/jobs/[id]/start/route.ts`

- Added import for `sam3Orchestrator`
- Before `yoloService.startTraining()`: calls `ensureGPUAvailable()`
- If fails: updates job to FAILED status and returns 503 error
- If succeeds: proceeds with training

---

## Files Modified

| File | Change | Status |
|------|--------|--------|
| `lib/services/sam3-orchestrator.ts` | Add `ensureGPUAvailable()` method | ✅ Done |
| `app/api/review/[sessionId]/push/route.ts` | Call cleanup before YOLO training | ✅ Done |
| `app/api/training/jobs/route.ts` | Call cleanup before YOLO training | ✅ Done |
| `app/api/training/jobs/[id]/start/route.ts` | Call cleanup before YOLO training | ✅ Done |

---

## Verification

1. Start SAM3 detection on an image (to load model)
2. Verify GPU is occupied: `curl http://13.54.121.111:8001/health` shows memory used
3. Push to YOLO training
4. Verify SAM3 instance stops before training starts
5. Training job should progress: Queued → Preparing → Running → Completed
6. Check final metrics appear

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| User wants SAM3 while training runs | Document that SAM3 unavailable during training |
| Instance stop takes too long | Add timeout (2 min max wait) |
| Stop fails | Return clear error to user, don't start training |
