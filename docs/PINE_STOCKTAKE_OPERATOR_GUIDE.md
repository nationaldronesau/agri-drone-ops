# Pine Stocktake operator guide

Open **Orthomosaics**, then select **Start Pine Stocktake**. Do not start it from the ordinary image upload page.

## 1. Upload and validate mission

Select the project and associate an immutable JSON mission manifest. The manifest contains the project asset identities or raw-object references for:

- native LV and RV images;
- the flight-specific CLC and CLI files;
- MRK plus RPOS, or an equivalent pose source;
- LAS or LAZ LiDAR;
- camera metadata, file SHA-256 values, camera serials, pose identity, timebase, latitude, longitude, and projected CRS.

The CLC metadata must list the exact LV/RV camera serials. The CLI metadata must contain its quaternion and translation identity. Each pose file must have the same non-empty pose identity and timebase. The selected CRS must be the UTM CRS for the mission location. Any ambiguity blocks the job.

Every required raw file must be associated with a project asset. The workers use short-lived read URLs and recheck the stored SHA-256 before processing.

Example file entry:

```json
{
  "kind": "IMAGE_LV",
  "assetId": "project-asset-id",
  "fileName": "DJI_20260817_001_LV.JPG",
  "sha256": "64-lowercase-hex-characters",
  "cameraSerial": "flight-camera-serial",
  "crs": "EPSG:32756"
}
```

## 2. Select exemplars and detect

Approve exactly three full-crown pine exemplars. Each exemplar must be on an image outside the target image. The exemplar bank shows its source-image and crop hash. Select **Detect** to queue the three independent runs. The screen shows processed target images and restart state.

Do not continue if the model revision, model weight hash, or backend identity differs from the pinned values shown in the audit panel.

## 3. Review and correct crowns

The union of the three runs is the review queue. Use the agreement filter to inspect one-of-three, two-of-three, and three-of-three candidates. Agreement is evidence only.

For each crown, the reviewer can:

- drag polygon vertices;
- delete a false candidate;
- mark it unsure;
- mark it edge-clipped;
- add a missed crown by clicking at least three polygon vertices;
- accept the final polygon.

Each save creates a review revision. It does not change the model polygon. The job can be closed and resumed. Only accepted crowns enter stock counting, mapping, or export.

## 4. Map, deduplicate and calculate heights

Select **Build rapid map** for the job-backed Flat Map preview. Treat every position on this preview as approximate.

Precise crown mapping uses the native polygon, CLC, CLI, pose, and LiDAR. Blue is the LiDAR upper-crown centre. Red is the highest valid crown point. The label is the P99 ground-normalized height. LV/RV and overlapping-frame matches merge into one stock record, but keep all crown, image, exemplar, review, and duplicate lineage.

Review the edge-clipped, unsure, new-cluster, conflict, and missing-LiDAR queues. An accepted crown must finish with a calibrated coordinate and height, or an explicit missing reason.

## Restart and export

Use **Refresh / resume** after a worker restart. Stage requests use the immutable manifest hash as their idempotency key. A retry does not overwrite reviews or create another completed stage.

CSV and GeoJSON exports are generated from stored accepted records. CSV includes LiDAR centre, P99 height, apex, ground, exception reason, and lineage. GeoJSON uses the stored project CRS and null geometry when there is no defensible LiDAR coordinate.

## Stop conditions

Stop the workflow and resolve the source evidence if any of these conditions occur:

- model revision or weight hash drift;
- camera serial mismatch;
- calibration does not belong to the flight;
- pose identity or timebase cannot be proven;
- CRS cannot be proven;
- Flat Map Runner checkout is dirty or unpinned;
- a paid service, new credentials, production write, deployment, or wider application redesign is required.
