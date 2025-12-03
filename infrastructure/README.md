# AWS Infrastructure for SAM3 GPU Processing

Automated infrastructure for on-demand SAM3 annotation processing. Upload images to S3 and they're automatically processed by a GPU instance that starts on demand and stops when idle.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AWS Cloud                                       │
│                                                                             │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────────────┐  │
│  │    S3    │────▶│  Lambda  │────▶│   SQS    │────▶│  EC2 GPU (g4dn) │  │
│  │ (upload) │     │(trigger) │     │ (queue)  │     │   (processor)   │  │
│  └──────────┘     └──────────┘     └──────────┘     └────────┬─────────┘  │
│       │                                                       │           │
│       │                                   ┌───────────────────┘           │
│       │                                   ▼                               │
│       │                            ┌──────────┐                          │
│       └───────────────────────────▶│    S3    │                          │
│              (results)             │ (output) │                          │
│                                    └──────────┘                          │
│                                                                           │
│  ┌──────────────────┐      ┌──────────────────┐                          │
│  │ Secrets Manager  │      │ CloudWatch Alarm │                          │
│  │ (HF + Roboflow)  │      │  (auto-stop)     │                          │
│  └──────────────────┘      └──────────────────┘                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Cost Estimate

| Component | Cost | Notes |
|-----------|------|-------|
| EC2 g4dn.xlarge | $0.526/hr | Only when running |
| S3 Storage | ~$0.023/GB/month | Images + results |
| Lambda | Free tier | <1M requests/month |
| SQS | Free tier | <1M requests/month |
| Secrets Manager | $0.40/secret/month | 2 secrets |

**Typical monthly cost**: $5-50 depending on processing volume

**Per-batch cost example**:
- 500 images = ~2 hours processing = ~$1.05

## Prerequisites

1. **AWS Account** with appropriate permissions
2. **AWS CLI** configured with credentials
3. **Terraform** >= 1.0.0
4. **HuggingFace account** with SAM3 access
5. **Roboflow account** (optional, for uploads)

## Quick Start

### 1. Deploy Infrastructure

```bash
cd infrastructure

# Initialize and deploy
./scripts/deploy.sh init
./scripts/deploy.sh apply

# This will:
# - Create S3 bucket for images
# - Create SQS queue for job management
# - Create Lambda trigger function
# - Create EC2 GPU instance (stopped)
# - Setup CloudWatch alarms for auto-stop
```

### 2. Upload Images for Processing

```bash
# Upload a directory of images
./scripts/deploy.sh upload /path/to/drone/images my-project-name

# Or use AWS CLI directly
aws s3 sync /path/to/images s3://agridrone-sam3-processing-dev/incoming/my-project/
```

### 3. Monitor Processing

```bash
# Check status
./scripts/deploy.sh status

# Watch logs (when instance is running)
aws logs tail /aws/lambda/agridrone-sam3-dev-trigger --follow

# Check results
aws s3 ls s3://agridrone-sam3-processing-dev/processed/my-project/
```

### 4. Download Results

```bash
# Download all results
aws s3 sync s3://agridrone-sam3-processing-dev/processed/my-project/ ./results/

# Results include:
# - annotations.json (COCO format annotations)
# - masks/ (segmentation masks)
```

## Configuration

### Environment Variables (terraform.tfvars)

Create `infrastructure/terraform/terraform.tfvars`:

```hcl
# Required
aws_region = "ap-southeast-2"

# Optional customization
project_name      = "agridrone-sam3"
environment       = "prod"
gpu_instance_type = "g4dn.xlarge"  # or g5.xlarge for more power

# Processing settings
min_images_to_start  = 10   # Queue threshold to start instance
max_processing_hours = 4    # Safety timeout

# SSH access (optional)
key_pair_name     = "your-key-pair"
allowed_ssh_cidrs = ["203.0.113.0/24"]  # Your office IP
```

### Instance Types

| Type | GPU | VRAM | Price/hr | Use Case |
|------|-----|------|----------|----------|
| g4dn.xlarge | T4 | 16GB | $0.526 | Standard batches |
| g4dn.2xlarge | T4 | 16GB | $0.752 | Faster CPU |
| g5.xlarge | A10G | 24GB | $1.006 | Large images |
| g5.2xlarge | A10G | 24GB | $1.212 | Production |

## How It Works

### Upload Flow

1. **You upload** images to `s3://bucket/incoming/project-name/`
2. **S3 triggers** Lambda function
3. **Lambda**:
   - Queues job to SQS
   - Checks queue depth
   - Starts EC2 if depth >= threshold (default: 10 images)

### Processing Flow

1. **EC2 starts** and runs startup script
2. **Pulls jobs** from SQS queue
3. **Downloads** image from S3
4. **Runs SAM3** segmentation
5. **Uploads** results to `s3://bucket/processed/project-name/`
6. **Deletes** job from SQS
7. **Repeats** until queue empty
8. **Auto-stops** when idle 15 minutes

### Cost Control

- Instance **only runs** when processing
- **Auto-stops** after 15 min idle (CloudWatch alarm)
- **Safety timeout** after max_processing_hours
- **Lifecycle rules** clean up old data automatically

## S3 Bucket Structure

```
agridrone-sam3-processing-dev/
├── incoming/              # Upload images here
│   └── project-name/
│       ├── image001.tif
│       ├── image002.tif
│       └── ...
├── processed/             # Results appear here
│   └── project-name/
│       └── image001/
│           ├── annotations.json
│           └── masks/
│               └── image001_masks.tif
└── logs/                  # Processing logs
    └── 2024-01-15/
        └── i-1234567890.log
```

## CLI Commands

```bash
# Deployment
./scripts/deploy.sh init       # Initialize Terraform
./scripts/deploy.sh plan       # Preview changes
./scripts/deploy.sh apply      # Deploy infrastructure
./scripts/deploy.sh destroy    # Tear down everything

# Operations
./scripts/deploy.sh status     # Show current status
./scripts/deploy.sh upload /path/to/images project-name
./scripts/deploy.sh secrets    # Configure API keys

# Manual instance control
aws ec2 start-instances --instance-ids i-xxx
aws ec2 stop-instances --instance-ids i-xxx
```

## Troubleshooting

### Instance won't start

```bash
# Check Lambda logs
aws logs tail /aws/lambda/agridrone-sam3-dev-trigger --since 1h

# Check instance state
aws ec2 describe-instances --instance-ids i-xxx --query 'Reservations[0].Instances[0].State'
```

### Processing errors

```bash
# SSH into instance (if key configured)
ssh -i your-key.pem ubuntu@<public-ip>

# View processing logs
tail -f /var/log/sam3-processing.log

# Check SAM3 setup
cd /home/ubuntu/sam3-processing/agri-drone-ops/tools/sam3-annotation
source venv/bin/activate
python -c "import torch; print(torch.cuda.is_available())"
```

### Queue not draining

```bash
# Check queue depth
aws sqs get-queue-attributes --queue-url <queue-url> \
    --attribute-names ApproximateNumberOfMessages

# Check for DLQ messages (failed jobs)
aws sqs get-queue-attributes --queue-url <dlq-url> \
    --attribute-names ApproximateNumberOfMessages
```

## Security

- **No public SSH** by default (configure `allowed_ssh_cidrs` if needed)
- **API keys in Secrets Manager** (not in code or environment)
- **IAM least privilege** for all roles
- **S3 bucket** is private
- **VPC security group** allows only outbound

## Cleanup

```bash
# Destroy all infrastructure
./scripts/deploy.sh destroy

# Also delete secrets if no longer needed
aws secretsmanager delete-secret --secret-id agridrone/huggingface-token --force-delete-without-recovery
aws secretsmanager delete-secret --secret-id agridrone/roboflow-api-key --force-delete-without-recovery
```

## Integration with AgriDrone Ops

Future integration options:

1. **Direct upload from web app** - Upload button triggers S3 upload
2. **Webhook notification** - Lambda posts to app when processing complete
3. **Results import** - API endpoint to pull annotations into main database

## Files

```
infrastructure/
├── terraform/
│   ├── main.tf           # Main infrastructure definition
│   ├── variables.tf      # Configuration variables
│   ├── outputs.tf        # Output values
│   └── templates/
│       └── ec2-startup.sh.tpl  # Instance startup script
├── lambda/
│   └── sam3-trigger/
│       └── handler.py    # S3 trigger Lambda function
├── scripts/
│   └── deploy.sh         # Deployment helper script
└── README.md             # This file
```
