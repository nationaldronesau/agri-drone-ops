# SAM3 Replay Harness

This harness replays one Apply-to-All scenario without using the app UI, BullMQ,
Redis, or the production database. Use it when SAM3 regressions need a fast
answer to: did the model return detections, did app orchestration pass the right
inputs, or did review UI hide valid results?

## What It Tests

- Builds visual exemplar crops from a known source image and operator-selected
  source boxes.
- Calls the SAM3 `/segment` endpoint directly.
- Runs the current baseline visual-crop strategy and an enhanced strategy that
  adds source-image SAM detections as extra crops when they overlap the
  operator-selected source boxes.
- Writes JSON plus overlay PNGs so image 1, image 2, and image 3 can be compared
  without deploying a code change.

## Fixture Format

Start from `scripts/sam3-replay.example.json`. Copy it beside the images you
want to replay, then replace the placeholder image paths and boxes:

```json
{
  "name": "ag3-apply-to-all-regression-slice",
  "className": "Pine Sapling",
  "source": {
    "id": "source-image-1",
    "image": "./fixtures/source.jpg",
    "boxes": [
      { "x1": 1240, "y1": 820, "x2": 1325, "y2": 910 }
    ]
  },
  "targets": [
    { "id": "target-image-2", "image": "./fixtures/target-02.jpg" },
    { "id": "target-image-3", "image": "./fixtures/target-03.jpg" }
  ]
}
```

Image paths are resolved relative to the fixture file. HTTP/HTTPS image URLs are
also supported.

## One-Click UI Bundle

For operators, use the app instead of manually building a fixture:

1. Run the normal SAM3 Apply to All workflow.
2. Wait for the batch to finish or fail.
3. Click **Export SAM3 replay bundle** in the batch progress card.
4. Send the downloaded ZIP to Codex/Williams.

The ZIP contains:

- `fixture.json`: ready for this replay command.
- `manifest.json`: batch ID, project, source/target asset metadata, and counts.
- `README.md`: exact command and decision rules.

The bundle intentionally uses signed or absolute image URLs instead of embedding
the full drone imagery, so it stays small enough to share. Run the replay before
the signed URLs expire.

## Run It

From the repo root, after preparing a real fixture:

```bash
npm run sam3:replay -- \
  --fixture ./tmp/ag3-replay/fixture.json \
  --sam3-url http://SAM3_HOST:8000 \
  --out ./tmp/sam3-replay/ag3
```

For a quick fixture validation without calling SAM3:

```bash
npm run sam3:replay -- \
  --fixture ./tmp/ag3-replay/fixture.json \
  --out ./tmp/sam3-replay/ag3 \
  --dry-run
```

Useful options:

- `--strategy baseline`: run only current visual crop behavior.
- `--strategy enhanced`: run only source-detection-enhanced crops.
- `--strategy both`: default; run both for A/B comparison.
- `--max-crops 10`: maximum crops sent to SAM3 per target.
- `--timeout-ms 120000`: request timeout for each SAM3 call.
- `--min-anchor-overlap 0.2`: required overlap between a source detection and an
  operator source box before that detection can become an enhanced crop.

## Outputs

The output directory contains:

- `manifest.json`: full replay summary, request parameters, counts, and paths.
- `crops/`: crop images used for each strategy.
- `source/source-box-match.json`: source-image SAM3 box-prompt result.
- `source/source-box-match.overlay.png`: source-image overlay.
- `<strategy>/<target-id>.json`: target result for each strategy.
- `<strategy>/<target-id>.overlay.png`: target overlay for visual review.

## How To Use For AG-3

1. Build a fixture from Manas' exact failing source image and two or three target
   images.
2. Use the same operator source boxes that were drawn before Apply to All.
3. Run `--strategy both`.
4. If baseline is zero but enhanced detects correctly, the app fix is to promote
   enhanced source crops into the production v2 visual path.
5. If both are zero, the problem is likely SAM3 service/model behavior or
   exemplar quality, not the app review UI.
6. If replay detects objects but the UI shows none, the problem is in persistence
   or review display filtering.

## Server-Side Diagnostics Endpoint

For faster production investigation, use the non-mutating diagnostics endpoint
when a real `BatchJob` already exists:

```bash
POST /api/sam3/v2/batch/{batchId}/diagnostics
```

It reads the batch, source boxes, source asset, and target assets from the
database; refreshes S3 image access internally; runs SAM3 strategy comparisons;
and returns JSON counts and sampled boxes. It does **not** create, update, or
delete `PendingAnnotation` records.

Example authenticated request body:

```json
{
  "startIfNeeded": true,
  "targetLimit": 3,
  "detectionLimit": 10,
  "strategies": [
    "box_prompt_match",
    "operator_visual_crops",
    "source_detection_crops",
    "concept_match",
    "concept_refined_box_prompt"
  ]
}
```

For automated loops, set `SAM3_DIAGNOSTICS_TOKEN` in the app environment and
send it as a header. This bypasses browser/session auth only for this
non-mutating diagnostics endpoint:

```bash
curl -sS \
  -X POST "https://agri.ndsmartdata.com/api/sam3/v2/batch/$BATCH_ID/diagnostics" \
  -H "Content-Type: application/json" \
  -H "x-sam3-diagnostics-token: $SAM3_DIAGNOSTICS_TOKEN" \
  --data '{
    "startIfNeeded": true,
    "targetLimit": 3,
    "detectionLimit": 10,
    "strategies": [
      "box_prompt_match",
      "operator_visual_crops",
      "source_detection_crops",
      "concept_match",
      "concept_refined_box_prompt"
    ]
  }'
```

Token-authenticated diagnostics are rate-limited separately at 30 requests per
minute per source IP. Normal browser/session diagnostics remain limited to 4
requests per minute.

Strategy meaning:

- `box_prompt_match`: current production v2 behavior; scales source boxes onto
  each target image and calls SAM3 box prompts.
- `operator_visual_crops`: builds crops directly from the operator's source
  boxes and asks SAM3 to find visually similar targets.
- `source_detection_crops`: first segments the source boxes, then uses those
  segmented detections as visual crops.
- `concept_match`: uses the concept/exemplar service directly.
- `concept_refined_box_prompt`: uses concept candidates, then refines candidate
  boxes through SAM3 box prompts.

Decision rules:

- If `box_prompt_match` is low but a visual/concept strategy is materially
  higher, the app orchestration should move away from scaled target boxes.
- If every strategy is low, the blocker is likely exemplar quality, model
  behavior, or SAM3 service tuning.
- If diagnostics return good counts but the UI still shows poor results, the
  issue is persistence, review filtering, or confidence thresholding.
