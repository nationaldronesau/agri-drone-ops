# SAM3 GPU Processing Infrastructure - Outputs

output "s3_bucket_name" {
  description = "S3 bucket for image processing"
  value       = aws_s3_bucket.processing.id
}

output "s3_bucket_arn" {
  description = "S3 bucket ARN"
  value       = aws_s3_bucket.processing.arn
}

output "gpu_instance_id" {
  description = "EC2 GPU instance ID"
  value       = aws_instance.gpu_processor.id
}

output "gpu_instance_public_ip" {
  description = "EC2 GPU instance public IP (when running)"
  value       = aws_instance.gpu_processor.public_ip
}

output "sqs_queue_url" {
  description = "SQS queue URL for processing jobs"
  value       = aws_sqs_queue.processing_queue.url
}

output "lambda_function_name" {
  description = "Lambda trigger function name"
  value       = aws_lambda_function.sam3_trigger.function_name
}

output "upload_command" {
  description = "Command to upload images for processing"
  value       = "aws s3 cp /path/to/images/ s3://${aws_s3_bucket.processing.id}/incoming/my-project/ --recursive"
}

output "check_status_command" {
  description = "Command to check instance status"
  value       = "aws ec2 describe-instances --instance-ids ${aws_instance.gpu_processor.id} --query 'Reservations[0].Instances[0].State.Name' --output text"
}

output "view_results_command" {
  description = "Command to view processed results"
  value       = "aws s3 ls s3://${aws_s3_bucket.processing.id}/processed/"
}

output "manual_start_command" {
  description = "Command to manually start GPU instance"
  value       = "aws ec2 start-instances --instance-ids ${aws_instance.gpu_processor.id}"
}

output "manual_stop_command" {
  description = "Command to manually stop GPU instance"
  value       = "aws ec2 stop-instances --instance-ids ${aws_instance.gpu_processor.id}"
}
