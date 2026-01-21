# Plan: Fix GPU Memory Conflict - Unload SAM3 Model for YOLO Training

## Status: 🔄 REVISED APPROACH NEEDED

---

## Problem
SAM3 model holds 14GB GPU memory, leaving no room for YOLO training on the shared T4 GPU (16GB total).

## Critical Issue with Current Implementation
The existing `ensureGPUAvailable()` stops the EC2 instance, but **SAM3 and YOLO run on the same EC2 instance**. Stopping the instance kills YOLO too!

## User Decision
**Keep SAM3 available** - Add "unload model" endpoint instead of stopping the instance.

---

## Implementation Plan

### Part 1: Python SAM3 Service Changes (Codex/SAM3 team)

Add endpoint: `POST /api/v1/unload`

```python
@app.post("/api/v1/unload")
async def unload_model():
    """Unload SAM3 model from GPU to free memory for YOLO training."""
    global model
    if model is not None:
        del model
        model = None
        torch.cuda.empty_cache()
        return {"success": True, "message": "Model unloaded", "gpu_freed_mb": 14000}
    return {"success": True, "message": "Model not loaded"}
```

### Part 2: TypeScript Changes

#### File 1: `lib/services/aws-sam3.ts`

Add new method:

```typescript
async unloadModel(): Promise<{ success: boolean; message: string }> {
  if (!this.configured) {
    return { success: true, message: 'SAM3 not configured' };
  }

  const ip = await this.discoverInstanceIp();
  if (!ip) {
    return { success: true, message: 'SAM3 instance not running' };
  }

  try {
    const response = await fetch(`http://${ip}:${SAM3_PORT}/api/v1/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return { success: false, message: `Unload failed: ${response.status}` };
    }

    const result = await response.json();
    this.modelLoaded = false;
    return { success: true, message: result.message || 'Model unloaded' };
  } catch (error) {
    return { success: false, message: `Unload error: ${error}` };
  }
}
```

#### File 2: `lib/services/sam3-orchestrator.ts`

Update `ensureGPUAvailable()` to call unload instead of stop:

```typescript
async ensureGPUAvailable(timeoutMs: number = 30000): Promise<{ success: boolean; message: string }> {
  if (!awsSam3Service.isConfigured()) {
    return { success: true, message: 'SAM3 not configured' };
  }

  // Unload model instead of stopping instance
  const result = await awsSam3Service.unloadModel();
  if (result.success) {
    console.log('[Orchestrator] SAM3 model unloaded, GPU available for YOLO');
  }
  return result;
}
```

---

## Files to Modify

| File | Change |
|------|--------|
| Python SAM3 service | Add `POST /api/v1/unload` endpoint |
| `lib/services/aws-sam3.ts` | Add `unloadModel()` method |
| `lib/services/sam3-orchestrator.ts` | Update `ensureGPUAvailable()` to use unload |

---

## Verification

1. Start SAM3 detection on an image (loads model)
2. Verify model loaded: `curl http://13.54.121.111:8000/health` shows `model_loaded: true`
3. Push to YOLO training
4. Verify model unloaded: `curl http://13.54.121.111:8000/health` shows `model_loaded: false`
5. YOLO training should proceed without CUDA OOM
6. SAM3 service still responds to health checks (instance not stopped)

---

## Dependency

**Requires SAM3 Python service update first** - the `/api/v1/unload` endpoint must exist before the TypeScript changes can work.

Next step: Coordinate with Codex to add the unload endpoint to the SAM3 service.
