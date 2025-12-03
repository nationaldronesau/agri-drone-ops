# SAM3 GPU Processing Infrastructure - Variables
# Configure these for your environment

variable "aws_region" {
  description = "AWS region for resources"
  type        = string
  default     = "ap-southeast-2" # Sydney - closest to Australia
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "agridrone-sam3"
}

variable "environment" {
  description = "Environment (dev, staging, prod)"
  type        = string
  default     = "dev"
}

# S3 Configuration
variable "s3_bucket_name" {
  description = "S3 bucket for image processing"
  type        = string
  default     = "agridrone-sam3-processing"
}

# EC2 GPU Instance Configuration
variable "gpu_instance_type" {
  description = "EC2 GPU instance type"
  type        = string
  default     = "g4dn.xlarge" # 1x T4 GPU, 16GB VRAM, ~$0.50/hr
}

variable "gpu_ami_id" {
  description = "AMI ID for GPU instance (Deep Learning AMI recommended)"
  type        = string
  default     = "" # Will use latest Deep Learning AMI if empty
}

variable "key_pair_name" {
  description = "EC2 key pair for SSH access"
  type        = string
  default     = ""
}

variable "allowed_ssh_cidrs" {
  description = "CIDR blocks allowed for SSH access"
  type        = list(string)
  default     = [] # Empty = no SSH access (more secure)
}

# Processing Configuration
variable "max_processing_hours" {
  description = "Maximum hours before auto-shutdown (safety limit)"
  type        = number
  default     = 4
}

variable "min_images_to_start" {
  description = "Minimum images in queue before starting instance"
  type        = number
  default     = 10
}

variable "huggingface_token_secret_name" {
  description = "AWS Secrets Manager secret name for HuggingFace token"
  type        = string
  default     = "agridrone/huggingface-token"
}

variable "roboflow_api_key_secret_name" {
  description = "AWS Secrets Manager secret name for Roboflow API key"
  type        = string
  default     = "agridrone/roboflow-api-key"
}

# Tags
variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default = {
    Project     = "AgriDrone-Ops"
    Component   = "SAM3-Processing"
    ManagedBy   = "Terraform"
  }
}
