# Commercial Labelling Workflow Contract

AgriDrone production should optimize for one reliable operator workflow:

1. Use SAM3 to identify objects of interest from operator examples.
2. Apply those examples across a dataset to speed up labelling.
3. Review labels, approve the good ones, then train YOLO 11 on AWS with the selected augmentation preset.

## Supported Production Path

- Multi-image SAM runs must use `/api/sam3/v2/batch` with visual matching.
- Legacy `/api/sam3/batch` is for one explicit debug image only.
- SAM3 outputs enter review as pending labels.
- Only accepted SAM3 labels can enter YOLO training datasets.
- Roboflow is an explicit fallback/benchmark source, not a silent replacement.
- Only reviewed Roboflow detections can enter YOLO training datasets.

## Operator Safety

- Do not train from unreviewed labels.
- Do not silently route multi-image runs through legacy SAM.
- Do not hide SAM, YOLO, or Roboflow readiness failures behind generic errors.
