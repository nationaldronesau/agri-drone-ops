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
