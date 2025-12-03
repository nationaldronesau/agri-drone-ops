#!/bin/bash
# SAM3 GPU Processing - EC2 Startup Script
# This script runs when the instance starts and processes images from SQS queue

set -e

# Configuration (injected by Terraform)
S3_BUCKET="${s3_bucket}"
SQS_QUEUE_URL="${sqs_queue_url}"
AWS_REGION="${aws_region}"
HUGGINGFACE_SECRET="${huggingface_secret_name}"
ROBOFLOW_SECRET="${roboflow_secret_name}"
MAX_PROCESSING_HOURS=${max_processing_hours}

# Directories
WORK_DIR="/home/ubuntu/sam3-processing"
LOG_FILE="/var/log/sam3-processing.log"

# Get instance ID from metadata
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a $LOG_FILE
}

# Cleanup and stop instance
cleanup_and_stop() {
    log "Processing complete or timeout reached. Stopping instance..."

    # Upload logs to S3
    aws s3 cp $LOG_FILE s3://$S3_BUCKET/logs/$(date +%Y-%m-%d)/$INSTANCE_ID.log || true

    # Stop this instance
    aws ec2 stop-instances --instance-ids $INSTANCE_ID --region $AWS_REGION

    exit 0
}

# Set trap for cleanup
trap cleanup_and_stop EXIT

log "=========================================="
log "SAM3 GPU Processing Started"
log "Instance: $INSTANCE_ID"
log "S3 Bucket: $S3_BUCKET"
log "SQS Queue: $SQS_QUEUE_URL"
log "=========================================="

# Set maximum runtime alarm
MAX_SECONDS=$((MAX_PROCESSING_HOURS * 3600))
log "Maximum runtime: $MAX_PROCESSING_HOURS hours ($MAX_SECONDS seconds)"

# Start timeout watchdog in background
(sleep $MAX_SECONDS && log "TIMEOUT: Maximum runtime exceeded" && kill $$) &
WATCHDOG_PID=$!

# Setup working directory
mkdir -p $WORK_DIR/{incoming,processed,annotations}
cd $WORK_DIR

# Get secrets from AWS Secrets Manager
log "Retrieving secrets..."
export HF_TOKEN=$(aws secretsmanager get-secret-value \
    --secret-id $HUGGINGFACE_SECRET \
    --region $AWS_REGION \
    --query 'SecretString' --output text 2>/dev/null || echo "")

export ROBOFLOW_API_KEY=$(aws secretsmanager get-secret-value \
    --secret-id $ROBOFLOW_SECRET \
    --region $AWS_REGION \
    --query 'SecretString' --output text 2>/dev/null || echo "")

if [ -z "$HF_TOKEN" ]; then
    log "WARNING: HuggingFace token not found. SAM3 may fail if not cached."
fi

# Clone/update SAM3 tools
log "Setting up SAM3 annotation tools..."
if [ ! -d "agri-drone-ops" ]; then
    git clone --depth 1 https://github.com/nationaldronesau/agri-drone-ops.git
fi
cd agri-drone-ops/tools/sam3-annotation

# Setup Python environment
log "Setting up Python environment..."
python3 -m venv venv 2>/dev/null || true
source venv/bin/activate
pip install -q -r requirements.txt

# HuggingFace authentication
if [ -n "$HF_TOKEN" ]; then
    log "Authenticating with HuggingFace..."
    huggingface-cli login --token $HF_TOKEN --add-to-git-credential 2>/dev/null || true
fi

# Process messages from SQS queue
EMPTY_RECEIVES=0
MAX_EMPTY_RECEIVES=3  # Stop after 3 consecutive empty receives
PROCESSED_COUNT=0

log "Starting to process messages from queue..."

while [ $EMPTY_RECEIVES -lt $MAX_EMPTY_RECEIVES ]; do
    # Receive message from SQS
    MESSAGE=$(aws sqs receive-message \
        --queue-url $SQS_QUEUE_URL \
        --max-number-of-messages 1 \
        --wait-time-seconds 20 \
        --region $AWS_REGION)

    # Check if message received
    RECEIPT_HANDLE=$(echo $MESSAGE | jq -r '.Messages[0].ReceiptHandle // empty')

    if [ -z "$RECEIPT_HANDLE" ]; then
        EMPTY_RECEIVES=$((EMPTY_RECEIVES + 1))
        log "No messages in queue (attempt $EMPTY_RECEIVES/$MAX_EMPTY_RECEIVES)"
        continue
    fi

    # Reset empty counter
    EMPTY_RECEIVES=0

    # Parse message
    BODY=$(echo $MESSAGE | jq -r '.Messages[0].Body')
    S3_KEY=$(echo $BODY | jq -r '.s3_key')
    PROJECT_NAME=$(echo $BODY | jq -r '.project_name // "default"')
    CLASS_NAME=$(echo $BODY | jq -r '.class_name // "sapling"')

    log "Processing: $S3_KEY (project: $PROJECT_NAME, class: $CLASS_NAME)"

    # Download image from S3
    LOCAL_IMAGE="$WORK_DIR/incoming/$(basename $S3_KEY)"
    aws s3 cp "s3://$S3_BUCKET/$S3_KEY" "$LOCAL_IMAGE" --region $AWS_REGION

    if [ ! -f "$LOCAL_IMAGE" ]; then
        log "ERROR: Failed to download $S3_KEY"
        # Delete message to prevent infinite retry
        aws sqs delete-message --queue-url $SQS_QUEUE_URL --receipt-handle "$RECEIPT_HANDLE" --region $AWS_REGION
        continue
    fi

    # Run SAM3 batch processing on single image
    OUTPUT_DIR="$WORK_DIR/processed/$PROJECT_NAME"
    mkdir -p "$OUTPUT_DIR"

    log "Running SAM3 segmentation..."
    python batch_segment.py "$LOCAL_IMAGE" \
        --class "$CLASS_NAME" \
        --device cuda \
        --output "$OUTPUT_DIR" \
        --min-area 100 2>&1 | tee -a $LOG_FILE

    # Upload results to S3
    RESULT_PREFIX="processed/$PROJECT_NAME/$(basename $S3_KEY .tif)"

    if [ -f "$OUTPUT_DIR/all_annotations.json" ]; then
        aws s3 cp "$OUTPUT_DIR/all_annotations.json" \
            "s3://$S3_BUCKET/$RESULT_PREFIX/annotations.json" \
            --region $AWS_REGION
        log "Uploaded annotations to s3://$S3_BUCKET/$RESULT_PREFIX/annotations.json"
    fi

    if [ -d "$OUTPUT_DIR/masks" ]; then
        aws s3 sync "$OUTPUT_DIR/masks/" \
            "s3://$S3_BUCKET/$RESULT_PREFIX/masks/" \
            --region $AWS_REGION
        log "Uploaded masks to s3://$S3_BUCKET/$RESULT_PREFIX/masks/"
    fi

    # Delete message from queue (mark as processed)
    aws sqs delete-message \
        --queue-url $SQS_QUEUE_URL \
        --receipt-handle "$RECEIPT_HANDLE" \
        --region $AWS_REGION

    # Cleanup local files
    rm -f "$LOCAL_IMAGE"
    rm -rf "$OUTPUT_DIR"

    PROCESSED_COUNT=$((PROCESSED_COUNT + 1))
    log "Completed processing $S3_KEY (total: $PROCESSED_COUNT)"
done

# Kill watchdog
kill $WATCHDOG_PID 2>/dev/null || true

log "=========================================="
log "Processing complete!"
log "Total images processed: $PROCESSED_COUNT"
log "=========================================="

# Cleanup will happen via trap
