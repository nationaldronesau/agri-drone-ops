# SAM Detection And YOLO Training Workflow

This note describes the production intent for AgriDrone SAM-assisted labelling and the equivalent pattern SmartData should copy for similar review-first detection workflows.

## Operating Goal

The system does not treat SAM output as final spray truth. SAM is used to accelerate labelling:

1. An operator labels a small number of examples on source imagery.
2. SAM3 generates candidate detections across the selected image set.
3. A reviewer accepts, rejects, or corrects the candidates.
4. Only accepted or corrected labels are eligible for spray export or YOLO training.
5. YOLO11 is trained from reviewed labels, then promoted only after model QA.

## SAM Detection Path

The supported multi-image path is SAM3 v2 batch processing. Legacy single-image SAM routes are kept only for debug/single-asset use and should not be used for Apply to Dataset.

For large datasets, one operator submission becomes one dataset run. The app can shard the batch internally so the operator still reviews one aggregate run rather than manually managing multiple batches.

The practical production behaviour is visual-crop candidate review:

- Source examples come from the object crops/boxes the operator labelled on the first image.
- The system searches target images for visually similar candidate regions.
- Candidates are persisted as pending review annotations with confidence values.
- The review queue controls how many candidates are visible; it does not automatically approve anything.

This is intentionally different from a pure text prompt such as `Pine Sapling`. Text prompts can be useful for diagnostics, but the operator workflow should rely on visual examples because the user is showing the system the exact object appearance they want.

## Review Sensitivity

The review page exposes a confidence threshold as a QA sensitivity control:

- `76% Conservative`: lower review load, lower false positives, higher chance of missed saplings.
- `74% Balanced`: default review pass for pine saplings.
- `72% High recall`: recommended when missing objects is more costly than rejecting false positives.
- `70% Exhaustive QA`: maximum candidate review load; use only when the reviewer expects noise.

Lowering the threshold reveals more pending candidates. It does not send lower-confidence detections to spray or YOLO by itself. The human review gate is still mandatory.

## Export Rules

Operational export is approved-only by default:

- Accepted or corrected SAM3 labels can be exported.
- Verified manual annotations can be exported.
- Reviewed AI/Roboflow detections can be exported.
- Pending SAM3 detections are excluded unless the operator explicitly chooses the QA export option.
- Rejected detections are excluded.

This keeps the spray path conservative even when the review queue is run in high-recall mode.

## YOLO11 Training Rules

Training datasets should include reviewed labels by default:

- Manual annotations: included only when verified.
- SAM3 annotations: included only when `PendingAnnotation.status = ACCEPTED`.
- Roboflow fallback detections: included only after review/verification or correction.
- Pending and rejected detections are excluded.

The review-to-YOLO action now asks the operator to choose the training intent:

- `Update existing model`: create a new YOLO dataset/version/checkpoint from accepted labels while keeping the current active model available for rollback.
- `Create new label/class`: bootstrap a new class or separate model path when the species/object is not already represented.

Activation should remain separate from training. A trained model version should be compared against the active model and only promoted when metrics and field QA are acceptable. If the new model worsens, keep or restore the prior active checkpoint.

## Roboflow Fallback

Roboflow remains an explicit fallback and benchmark, not a silent replacement:

- Use it when SAM readiness fails or when local model quality needs comparison.
- Keep results visibly source-tagged, for example `source = roboflow_batch_detection`.
- Route Roboflow detections through the same review gate.
- Do not auto-switch from SAM to Roboflow without operator action.

## SmartData Agent Guidance

For SmartData, copy the same pattern:

- Separate candidate generation from approval.
- Give reviewers a dataset-level confidence/sensitivity control.
- Make low-confidence/high-recall mode visibly a QA mode.
- Persist every candidate with source, confidence, prompt/example metadata, and review state.
- Make export/training consume only reviewed labels.
- Treat model training as versioned checkpoints with explicit activation and rollback, not an automatic overwrite.

