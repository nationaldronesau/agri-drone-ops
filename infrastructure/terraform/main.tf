# SAM3 GPU Processing Infrastructure
# Automatically processes drone images when uploaded to S3

terraform {
  required_version = ">= 1.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment to use S3 backend for state management
  # backend "s3" {
  #   bucket = "your-terraform-state-bucket"
  #   key    = "agridrone-sam3/terraform.tfstate"
  #   region = "ap-southeast-2"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.tags
  }
}

# Data sources
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Get latest Deep Learning AMI (Ubuntu with CUDA pre-installed)
data "aws_ami" "deep_learning" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["Deep Learning AMI GPU PyTorch *-Ubuntu 22.04-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

locals {
  ami_id = var.gpu_ami_id != "" ? var.gpu_ami_id : data.aws_ami.deep_learning.id

  resource_prefix = "${var.project_name}-${var.environment}"
}

#------------------------------------------------------------------------------
# S3 Bucket for Image Processing
#------------------------------------------------------------------------------

resource "aws_s3_bucket" "processing" {
  bucket = "${var.s3_bucket_name}-${var.environment}"

  tags = {
    Name = "SAM3 Processing Bucket"
  }
}

resource "aws_s3_bucket_versioning" "processing" {
  bucket = aws_s3_bucket.processing.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "processing" {
  bucket = aws_s3_bucket.processing.id

  rule {
    id     = "cleanup-processed"
    status = "Enabled"

    filter {
      prefix = "processed/"
    }

    # Move to Glacier after 30 days
    transition {
      days          = 30
      storage_class = "GLACIER"
    }

    # Delete after 1 year
    expiration {
      days = 365
    }
  }

  rule {
    id     = "cleanup-incoming"
    status = "Enabled"

    filter {
      prefix = "incoming/"
    }

    # Delete processed originals after 7 days
    expiration {
      days = 7
    }
  }
}

# S3 notification to Lambda
resource "aws_s3_bucket_notification" "processing_notification" {
  bucket = aws_s3_bucket.processing.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.sam3_trigger.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "incoming/"
    filter_suffix       = ".tif"
  }

  lambda_function {
    lambda_function_arn = aws_lambda_function.sam3_trigger.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "incoming/"
    filter_suffix       = ".jpg"
  }

  lambda_function {
    lambda_function_arn = aws_lambda_function.sam3_trigger.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "incoming/"
    filter_suffix       = ".png"
  }

  depends_on = [aws_lambda_permission.allow_s3]
}

#------------------------------------------------------------------------------
# IAM Role for EC2 GPU Instance
#------------------------------------------------------------------------------

resource "aws_iam_role" "gpu_instance" {
  name = "${local.resource_prefix}-gpu-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "gpu_instance_policy" {
  name = "${local.resource_prefix}-gpu-instance-policy"
  role = aws_iam_role.gpu_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket",
          "s3:DeleteObject"
        ]
        Resource = [
          aws_s3_bucket.processing.arn,
          "${aws_s3_bucket.processing.arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.huggingface_token_secret_name}*",
          "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.roboflow_api_key_secret_name}*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:StopInstances"
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "ec2:ResourceTag/Name" = "${local.resource_prefix}-gpu-processor"
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.processing_queue.arn
      }
    ]
  })
}

resource "aws_iam_instance_profile" "gpu_instance" {
  name = "${local.resource_prefix}-gpu-instance-profile"
  role = aws_iam_role.gpu_instance.name
}

#------------------------------------------------------------------------------
# SQS Queue for Job Management
#------------------------------------------------------------------------------

resource "aws_sqs_queue" "processing_queue" {
  name                       = "${local.resource_prefix}-processing-queue"
  visibility_timeout_seconds = 3600 # 1 hour per image
  message_retention_seconds  = 86400 # 24 hours
  receive_wait_time_seconds  = 20 # Long polling

  tags = {
    Name = "SAM3 Processing Queue"
  }
}

resource "aws_sqs_queue" "processing_dlq" {
  name = "${local.resource_prefix}-processing-dlq"

  tags = {
    Name = "SAM3 Processing Dead Letter Queue"
  }
}

#------------------------------------------------------------------------------
# Security Group for GPU Instance
#------------------------------------------------------------------------------

resource "aws_security_group" "gpu_instance" {
  name        = "${local.resource_prefix}-gpu-sg"
  description = "Security group for SAM3 GPU processing instance"

  # Outbound: Allow all (needed for S3, package downloads, etc.)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Inbound SSH (optional - only if key_pair provided)
  dynamic "ingress" {
    for_each = length(var.allowed_ssh_cidrs) > 0 ? [1] : []
    content {
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.allowed_ssh_cidrs
    }
  }

  tags = {
    Name = "${local.resource_prefix}-gpu-sg"
  }
}

#------------------------------------------------------------------------------
# EC2 GPU Instance (Stopped by default - started by Lambda)
#------------------------------------------------------------------------------

resource "aws_instance" "gpu_processor" {
  ami                    = local.ami_id
  instance_type          = var.gpu_instance_type
  iam_instance_profile   = aws_iam_instance_profile.gpu_instance.name
  vpc_security_group_ids = [aws_security_group.gpu_instance.id]
  key_name               = var.key_pair_name != "" ? var.key_pair_name : null

  root_block_device {
    volume_size = 100 # GB - enough for model + images
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = base64encode(templatefile("${path.module}/templates/ec2-startup.sh.tpl", {
    s3_bucket               = aws_s3_bucket.processing.id
    sqs_queue_url           = aws_sqs_queue.processing_queue.url
    aws_region              = var.aws_region
    huggingface_secret_name = var.huggingface_token_secret_name
    roboflow_secret_name    = var.roboflow_api_key_secret_name
    max_processing_hours    = var.max_processing_hours
    instance_id             = "" # Will be filled at runtime via metadata
  }))

  # Start in stopped state - Lambda will start when needed
  # Note: Terraform creates it running, we stop it after creation

  tags = {
    Name        = "${local.resource_prefix}-gpu-processor"
    AutoStop    = "true"
    Environment = var.environment
  }

  lifecycle {
    ignore_changes = [
      ami, # Don't recreate on AMI updates
    ]
  }
}

# Stop instance after creation (it starts running by default)
resource "null_resource" "stop_instance" {
  depends_on = [aws_instance.gpu_processor]

  provisioner "local-exec" {
    command = "aws ec2 stop-instances --instance-ids ${aws_instance.gpu_processor.id} --region ${var.aws_region} || true"
  }
}

#------------------------------------------------------------------------------
# Lambda Function - S3 Trigger
#------------------------------------------------------------------------------

resource "aws_iam_role" "lambda_trigger" {
  name = "${local.resource_prefix}-lambda-trigger-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda_trigger_policy" {
  name = "${local.resource_prefix}-lambda-trigger-policy"
  role = aws_iam_role.lambda_trigger.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances",
          "ec2:StartInstances"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.processing_queue.arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.processing.arn,
          "${aws_s3_bucket.processing.arn}/*"
        ]
      }
    ]
  })
}

data "archive_file" "lambda_trigger" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/sam3-trigger"
  output_path = "${path.module}/lambda_trigger.zip"
}

resource "aws_lambda_function" "sam3_trigger" {
  filename         = data.archive_file.lambda_trigger.output_path
  function_name    = "${local.resource_prefix}-trigger"
  role             = aws_iam_role.lambda_trigger.arn
  handler          = "handler.lambda_handler"
  source_code_hash = data.archive_file.lambda_trigger.output_base64sha256
  runtime          = "python3.11"
  timeout          = 30
  memory_size      = 128

  environment {
    variables = {
      GPU_INSTANCE_ID     = aws_instance.gpu_processor.id
      SQS_QUEUE_URL       = aws_sqs_queue.processing_queue.url
      MIN_IMAGES_TO_START = tostring(var.min_images_to_start)
      S3_BUCKET           = aws_s3_bucket.processing.id
    }
  }

  tags = {
    Name = "SAM3 S3 Trigger"
  }
}

resource "aws_lambda_permission" "allow_s3" {
  statement_id  = "AllowExecutionFromS3"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sam3_trigger.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.processing.arn
}

resource "aws_cloudwatch_log_group" "lambda_trigger" {
  name              = "/aws/lambda/${aws_lambda_function.sam3_trigger.function_name}"
  retention_in_days = 14
}

#------------------------------------------------------------------------------
# CloudWatch Alarm - Auto-stop stuck instances
#------------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "gpu_idle" {
  alarm_name          = "${local.resource_prefix}-gpu-idle-alarm"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300 # 5 minutes
  statistic           = "Average"
  threshold           = 5
  alarm_description   = "Stop GPU instance if idle for 15 minutes"

  dimensions = {
    InstanceId = aws_instance.gpu_processor.id
  }

  alarm_actions = [
    "arn:aws:automate:${var.aws_region}:ec2:stop"
  ]

  tags = {
    Name = "GPU Idle Monitor"
  }
}
