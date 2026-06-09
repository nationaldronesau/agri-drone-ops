# AG-3 DINO Candidate Mining Loop

This is a review-first loop for finding pine saplings the current YOLO model misses.
DINO is used only to propose extra candidates. It does not auto-accept labels.

## Why This Exists

The latest AG-3 YOLO run is useful, but Manas still sees missed saplings. If we train
YOLO with images that contain unlabelled saplings, those missed positives become noisy
background. The safest next step is to mine missed positives, review them, and then use
accepted labels for a `pine-saplings-v2` dataset.

## Workflow

1. Export the latest or selected review session:

```bash
npm run ag3:dino-export -- --sessionId <review-session-id> --out /tmp/ag3-dino-hqp-10
```

For a quick local smoke test:

```bash
npm run ag3:dino-export -- --sample --out /tmp/ag3-dino-sample
```

2. Manas reviews `/tmp/ag3-dino-hqp-10/overlays` and marks missed saplings on the
source images.

3. Convert the missed saplings into exemplar boxes in:

```text
/tmp/ag3-dino-hqp-10/exemplars/missed-saplings.template.json
```

4. Run the DINO mining experiment outside the production app using those missed
positive exemplars. Save output as:

```text
/tmp/ag3-dino-hqp-10/candidates/dino-candidates.json
```

5. Import the generated candidates as pending review items:

```bash
npm run ag3:dino-import -- \
  --candidates /tmp/ag3-dino-hqp-10/candidates/dino-candidates.json \
  --create-review-session
```

6. Manas opens the generated review URL, accepts true saplings, rejects false
positives, and adds any remaining missed positives manually.

## Candidate JSON Shape

```json
{
  "schemaVersion": "ag3-dino-candidates/v1",
  "sourceSessionId": "cmp...",
  "projectId": "cmo6ng4fp0001pm2zbo3341te",
  "className": "Pine Sapling",
  "generator": {
    "name": "DINO candidate mining",
    "version": "experiment-001"
  },
  "candidates": [
    {
      "assetId": "asset-id",
      "confidence": 0.52,
      "similarity": 0.81,
      "bbox": [100, 120, 160, 190],
      "polygon": [[100, 120], [160, 120], [160, 190], [100, 190]]
    }
  ]
}
```

`bbox` uses source-image pixel coordinates: `[x1, y1, x2, y2]`. If the DINO
experiment only returns a point, it may use `point: [x, y]` plus `boxSize`.

## Guardrails

- Imported DINO candidates are always `PENDING`.
- No candidate enters YOLO training until a reviewer accepts or corrects it.
- The importer creates a synthetic completed `BatchJob` with
  `mode=DINO_CANDIDATE_MINING`, then creates a normal review session for that batch.
- This keeps candidate mining outside the critical app path while preserving the
  normal accepted-only training flow.

