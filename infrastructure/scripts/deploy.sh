#!/bin/bash
# SAM3 GPU Processing Infrastructure - Deployment Script
# Usage: ./deploy.sh [plan|apply|destroy]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TERRAFORM_DIR="$SCRIPT_DIR/../terraform"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check Terraform
    if ! command -v terraform &> /dev/null; then
        log_error "Terraform not found. Install from https://terraform.io/downloads"
        exit 1
    fi
    log_info "Terraform: $(terraform version -json | jq -r '.terraform_version')"

    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI not found. Install from https://aws.amazon.com/cli/"
        exit 1
    fi
    log_info "AWS CLI: $(aws --version | cut -d' ' -f1)"

    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS credentials not configured. Run 'aws configure'"
        exit 1
    fi
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    log_info "AWS Account: $ACCOUNT_ID"

    # Check jq
    if ! command -v jq &> /dev/null; then
        log_warn "jq not found. Install for better output parsing."
    fi
}

setup_secrets() {
    log_info "Setting up AWS Secrets Manager secrets..."

    # Check if HuggingFace secret exists
    if ! aws secretsmanager describe-secret --secret-id "agridrone/huggingface-token" &> /dev/null; then
        log_warn "HuggingFace token secret not found."
        echo -n "Enter your HuggingFace token (or press Enter to skip): "
        read -s HF_TOKEN
        echo

        if [ -n "$HF_TOKEN" ]; then
            aws secretsmanager create-secret \
                --name "agridrone/huggingface-token" \
                --secret-string "$HF_TOKEN" \
                --description "HuggingFace token for SAM3 model access"
            log_info "Created HuggingFace token secret"
        else
            log_warn "Skipped HuggingFace token. SAM3 may fail if model not cached."
        fi
    else
        log_info "HuggingFace token secret exists"
    fi

    # Check if Roboflow secret exists
    if ! aws secretsmanager describe-secret --secret-id "agridrone/roboflow-api-key" &> /dev/null; then
        log_warn "Roboflow API key secret not found."
        echo -n "Enter your Roboflow API key (or press Enter to skip): "
        read -s RF_KEY
        echo

        if [ -n "$RF_KEY" ]; then
            aws secretsmanager create-secret \
                --name "agridrone/roboflow-api-key" \
                --secret-string "$RF_KEY" \
                --description "Roboflow API key for model training uploads"
            log_info "Created Roboflow API key secret"
        else
            log_warn "Skipped Roboflow API key. Upload to Roboflow will fail."
        fi
    else
        log_info "Roboflow API key secret exists"
    fi
}

terraform_init() {
    log_info "Initializing Terraform..."
    cd "$TERRAFORM_DIR"
    terraform init
}

terraform_plan() {
    log_info "Planning infrastructure changes..."
    cd "$TERRAFORM_DIR"
    terraform plan -out=tfplan
}

terraform_apply() {
    log_info "Applying infrastructure changes..."
    cd "$TERRAFORM_DIR"

    if [ -f "tfplan" ]; then
        terraform apply tfplan
        rm tfplan
    else
        terraform apply
    fi

    log_info ""
    log_info "=========================================="
    log_info "Deployment Complete!"
    log_info "=========================================="
    terraform output
}

terraform_destroy() {
    log_warn "This will destroy all SAM3 processing infrastructure!"
    echo -n "Are you sure? (type 'yes' to confirm): "
    read CONFIRM

    if [ "$CONFIRM" = "yes" ]; then
        cd "$TERRAFORM_DIR"
        terraform destroy
    else
        log_info "Destroy cancelled"
    fi
}

upload_artifact() {
    log_info "Packaging and uploading SAM3 tools artifact..."

    cd "$TERRAFORM_DIR"

    S3_BUCKET=$(terraform output -raw s3_bucket_name 2>/dev/null)
    if [ -z "$S3_BUCKET" ] || [ "$S3_BUCKET" = "N/A" ]; then
        log_error "S3 bucket not found. Deploy infrastructure first."
        exit 1
    fi

    # Find the SAM3 tools directory
    SAM3_TOOLS_DIR="$SCRIPT_DIR/../../tools/sam3-annotation"
    if [ ! -d "$SAM3_TOOLS_DIR" ]; then
        log_error "SAM3 tools not found at $SAM3_TOOLS_DIR"
        exit 1
    fi

    # Create temporary directory for artifact
    TEMP_DIR=$(mktemp -d)
    ARTIFACT_DIR="$TEMP_DIR/sam3-annotation"
    mkdir -p "$ARTIFACT_DIR"

    # Copy SAM3 tools (excluding venv, __pycache__, etc.)
    log_info "Copying SAM3 tools..."
    rsync -av --exclude='venv' --exclude='__pycache__' --exclude='*.pyc' \
        --exclude='.eggs' --exclude='*.egg-info' --exclude='sam3_output' \
        --exclude='roboflow_export' --exclude='*_annotations.json' \
        --exclude='*_masks.tif' \
        "$SAM3_TOOLS_DIR/" "$ARTIFACT_DIR/"

    # Create versioned artifact
    VERSION=$(date +%Y%m%d-%H%M%S)
    COMMIT_HASH=$(git -C "$SAM3_TOOLS_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
    ARTIFACT_NAME="sam3-tools-${VERSION}-${COMMIT_HASH}.tar.gz"

    log_info "Creating artifact: $ARTIFACT_NAME"
    tar -czf "$TEMP_DIR/$ARTIFACT_NAME" -C "$TEMP_DIR" sam3-annotation

    # Upload versioned artifact
    log_info "Uploading to s3://$S3_BUCKET/artifacts/$ARTIFACT_NAME"
    aws s3 cp "$TEMP_DIR/$ARTIFACT_NAME" "s3://$S3_BUCKET/artifacts/$ARTIFACT_NAME"

    # Also upload as latest
    log_info "Updating latest artifact..."
    aws s3 cp "$TEMP_DIR/$ARTIFACT_NAME" "s3://$S3_BUCKET/artifacts/sam3-tools-latest.tar.gz"

    # Cleanup
    rm -rf "$TEMP_DIR"

    log_info "Artifact upload complete!"
    log_info "  Versioned: s3://$S3_BUCKET/artifacts/$ARTIFACT_NAME"
    log_info "  Latest:    s3://$S3_BUCKET/artifacts/sam3-tools-latest.tar.gz"
    log_info ""
    log_info "EC2 instances will now use this reviewed artifact instead of git clone."
}

show_usage() {
    echo "SAM3 GPU Processing Infrastructure Deployment"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  init            Initialize Terraform and check prerequisites"
    echo "  plan            Show planned infrastructure changes"
    echo "  apply           Apply infrastructure changes"
    echo "  destroy         Destroy all infrastructure"
    echo "  secrets         Setup AWS Secrets Manager secrets"
    echo "  status          Show current infrastructure status"
    echo "  upload          Upload images for processing"
    echo "  upload-artifact Package and upload SAM3 tools to S3 (recommended)"
    echo ""
    echo "Examples:"
    echo "  $0 init && $0 plan && $0 apply   # Full deployment"
    echo "  $0 upload-artifact               # Upload reviewed SAM3 tools"
    echo "  $0 status                        # Check status"
    echo "  $0 upload /path/to/images        # Upload images"
}

show_status() {
    cd "$TERRAFORM_DIR"

    if [ ! -f "terraform.tfstate" ]; then
        log_warn "No Terraform state found. Run 'deploy.sh apply' first."
        return
    fi

    log_info "Current Infrastructure Status:"
    echo ""

    # Get outputs
    S3_BUCKET=$(terraform output -raw s3_bucket_name 2>/dev/null || echo "N/A")
    INSTANCE_ID=$(terraform output -raw gpu_instance_id 2>/dev/null || echo "N/A")
    QUEUE_URL=$(terraform output -raw sqs_queue_url 2>/dev/null || echo "N/A")

    echo "S3 Bucket:    $S3_BUCKET"
    echo "Instance ID:  $INSTANCE_ID"
    echo "Queue URL:    $QUEUE_URL"

    if [ "$INSTANCE_ID" != "N/A" ]; then
        STATE=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
            --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo "unknown")
        echo "Instance State: $STATE"
    fi

    if [ "$QUEUE_URL" != "N/A" ]; then
        QUEUE_DEPTH=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" \
            --attribute-names ApproximateNumberOfMessages \
            --query 'Attributes.ApproximateNumberOfMessages' --output text 2>/dev/null || echo "0")
        echo "Queue Depth:  $QUEUE_DEPTH messages"
    fi
}

upload_images() {
    cd "$TERRAFORM_DIR"

    if [ -z "$1" ]; then
        log_error "Usage: $0 upload /path/to/images [project-name]"
        exit 1
    fi

    SOURCE_PATH="$1"
    PROJECT_NAME="${2:-$(date +%Y%m%d-%H%M%S)}"

    if [ ! -d "$SOURCE_PATH" ] && [ ! -f "$SOURCE_PATH" ]; then
        log_error "Source path not found: $SOURCE_PATH"
        exit 1
    fi

    S3_BUCKET=$(terraform output -raw s3_bucket_name 2>/dev/null)
    if [ -z "$S3_BUCKET" ] || [ "$S3_BUCKET" = "N/A" ]; then
        log_error "S3 bucket not found. Deploy infrastructure first."
        exit 1
    fi

    log_info "Uploading to s3://$S3_BUCKET/incoming/$PROJECT_NAME/"

    if [ -d "$SOURCE_PATH" ]; then
        aws s3 sync "$SOURCE_PATH" "s3://$S3_BUCKET/incoming/$PROJECT_NAME/" \
            --exclude "*" \
            --include "*.tif" --include "*.tiff" \
            --include "*.jpg" --include "*.jpeg" \
            --include "*.png"
    else
        aws s3 cp "$SOURCE_PATH" "s3://$S3_BUCKET/incoming/$PROJECT_NAME/"
    fi

    log_info "Upload complete! Lambda will trigger processing."
    log_info "Check status with: $0 status"
}

# Main
case "${1:-}" in
    init)
        check_prerequisites
        terraform_init
        ;;
    plan)
        check_prerequisites
        terraform_plan
        ;;
    apply)
        check_prerequisites
        setup_secrets
        terraform_init
        terraform_apply
        ;;
    destroy)
        check_prerequisites
        terraform_destroy
        ;;
    secrets)
        check_prerequisites
        setup_secrets
        ;;
    status)
        show_status
        ;;
    upload)
        upload_images "$2" "$3"
        ;;
    upload-artifact)
        check_prerequisites
        upload_artifact
        ;;
    *)
        show_usage
        ;;
esac
