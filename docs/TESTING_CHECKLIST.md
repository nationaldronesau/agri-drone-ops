# SAM3 + YOLO Training Pipeline Test Checklist

**Date:** January 2026
**Purpose:** Verify SAM3 zero-shot detection and YOLO training push workflow

---

## Prerequisites

- Access to production app: https://agri.ndsmartdata.com
- SSH access to YOLO EC2 instance (13.54.121.111)
- A project with ~10 test images uploaded

---

## Test 1: SAM3 Zero-Shot Detection

### Steps

1. Go to **Training Hub** → **Improve Existing Model** (or appropriate workflow)
2. Select a project with test images (e.g., "10 images project")
3. Select a species/class to detect (e.g., "Pine Sapling")
4. Click **Apply to This Image** (zero-shot detection)

### Expected Result

- [ ] SAM3 service should start (may take 30-60 seconds on first use)
- [ ] Detections should appear on the image as colored polygons
- [ ] Console should NOT show 401 errors or "falling back to Roboflow"

### Verification

In browser DevTools (Network tab), check the `/api/sam3/predict` request:
- Status should be `200`
- Response should contain `detections` array

---

## Test 2: Review and Accept Detections

### Steps

1. After SAM3 detections appear, review them
2. Accept good detections, reject false positives
3. Proceed through multiple images if needed

### Expected Result

- [ ] Detections can be accepted/rejected
- [ ] Accepted detections are saved

---

## Test 3: Push to YOLO Training

### Steps

1. After reviewing detections, click **Push to YOLO** (or similar)
2. Note the dataset name and job ID created
3. Go to `/training` page to monitor progress

### Expected Result

- [ ] Training job appears in "Active Training Jobs"
- [ ] Status changes from "Queued" → "Preparing" → "Running"
- [ ] Progress bar updates as epochs complete

---

## Test 4: Verify Local Dataset Path (SSH)

**Run these commands on the YOLO EC2 instance:**

```bash
# SSH into the YOLO instance
ssh ubuntu@13.54.121.111

# Replace with actual values from the training job
JOB_ID=<job_id_from_training_page>
DATASET_ID=<dataset_id_from_job_details>

# Check dataset was downloaded locally
ls -la /opt/dlami/nvme/datasets/$DATASET_ID

# Check training job directory exists
ls -la /opt/dlami/nvme/training/$JOB_ID

# Verify data.yaml uses local path (NOT s3://)
grep -n 'path:' /opt/dlami/nvme/training/$JOB_ID/data.yaml
```

### Expected Result

- [ ] Dataset directory exists with images
- [ ] Training job directory exists
- [ ] `data.yaml` shows local path like `/opt/dlami/nvme/datasets/...` (NOT `s3://...`)

---

## Test 5: Training Completion

### Steps

1. Wait for training to complete (check `/training` page)
2. Verify metrics appear (mAP50, Precision, Recall)

### Expected Result

- [ ] Training completes without errors
- [ ] Final metrics are displayed
- [ ] Trained model appears in "Available Models" section

---

## Quick Health Checks

### From your machine (terminal):

```bash
# SAM3 Service (port 8000)
curl -s http://13.54.121.111:8000/api/v1/health

# YOLO Service (port 8001)
curl -s http://13.54.121.111:8001/health

# SAM3 Concept Service (port 8002)
curl -s http://13.54.121.111:8002/health
```

All should return `{"status": "healthy", ...}` or similar.

---

## Troubleshooting

### SAM3 returns 401 or falls back to Roboflow
- Check `SAM3_SERVICE_URL` env var in Elastic Beanstalk
- Verify EC2 security group allows traffic on port 8000

### Training job stuck in "Queued"
- Check `YOLO_SERVICE_URL` env var in Elastic Beanstalk
- Verify YOLO service is running: `curl http://13.54.121.111:8001/health`

### Training fails with "images not found"
- Dataset wasn't downloaded from S3
- Check YOLO EC2 has AWS credentials configured
- Check `/opt/dlami/nvme/datasets/` for downloaded datasets

### Job shows error in training page
- Get job ID from UI
- Check detailed error: `curl http://13.54.121.111:8001/api/v1/train/<job_id>`

---

## Sign-Off

| Test | Pass/Fail | Tester | Date |
|------|-----------|--------|------|
| SAM3 Zero-Shot | | | |
| Review Detections | | | |
| Push to YOLO | | | |
| Local Dataset Path | | | |
| Training Completion | | | |

**Notes:**
_________________________________
_________________________________
_________________________________
