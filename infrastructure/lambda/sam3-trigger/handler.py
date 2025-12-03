"""
SAM3 Processing Trigger Lambda

Triggered when images are uploaded to S3. Queues processing jobs and
starts the GPU instance if needed.

Environment Variables:
    GPU_INSTANCE_ID: EC2 instance ID for GPU processor
    SQS_QUEUE_URL: SQS queue URL for processing jobs
    MIN_IMAGES_TO_START: Minimum images before starting instance
    S3_BUCKET: S3 bucket name
"""

import json
import os
import logging
import boto3
from urllib.parse import unquote_plus

# Setup logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# AWS clients
ec2 = boto3.client('ec2')
sqs = boto3.client('sqs')
s3 = boto3.client('s3')

# Configuration from environment
GPU_INSTANCE_ID = os.environ.get('GPU_INSTANCE_ID')
SQS_QUEUE_URL = os.environ.get('SQS_QUEUE_URL')
MIN_IMAGES_TO_START = int(os.environ.get('MIN_IMAGES_TO_START', '10'))
S3_BUCKET = os.environ.get('S3_BUCKET')


def get_instance_state(instance_id: str) -> str:
    """Get current state of EC2 instance."""
    try:
        response = ec2.describe_instances(InstanceIds=[instance_id])
        state = response['Reservations'][0]['Instances'][0]['State']['Name']
        return state
    except Exception as e:
        logger.error(f"Error getting instance state: {e}")
        return 'unknown'


def start_instance(instance_id: str) -> bool:
    """Start EC2 instance if stopped."""
    try:
        state = get_instance_state(instance_id)
        logger.info(f"Instance {instance_id} current state: {state}")

        if state == 'stopped':
            logger.info(f"Starting instance {instance_id}")
            ec2.start_instances(InstanceIds=[instance_id])
            return True
        elif state in ['pending', 'running']:
            logger.info(f"Instance {instance_id} already starting/running")
            return True
        else:
            logger.warning(f"Instance {instance_id} in unexpected state: {state}")
            return False
    except Exception as e:
        logger.error(f"Error starting instance: {e}")
        return False


def get_queue_depth() -> int:
    """Get approximate number of messages in queue."""
    try:
        response = sqs.get_queue_attributes(
            QueueUrl=SQS_QUEUE_URL,
            AttributeNames=['ApproximateNumberOfMessages']
        )
        return int(response['Attributes'].get('ApproximateNumberOfMessages', 0))
    except Exception as e:
        logger.error(f"Error getting queue depth: {e}")
        return 0


def queue_processing_job(s3_key: str, bucket: str) -> bool:
    """Add processing job to SQS queue."""
    try:
        # Extract project name from path (incoming/project-name/image.tif)
        parts = s3_key.split('/')
        project_name = parts[1] if len(parts) > 2 else 'default'

        message = {
            's3_key': s3_key,
            's3_bucket': bucket,
            'project_name': project_name,
            'class_name': 'sapling',  # Default class, can be customized
        }

        response = sqs.send_message(
            QueueUrl=SQS_QUEUE_URL,
            MessageBody=json.dumps(message),
            MessageAttributes={
                'project': {
                    'DataType': 'String',
                    'StringValue': project_name
                }
            }
        )

        logger.info(f"Queued job for {s3_key}, MessageId: {response['MessageId']}")
        return True

    except Exception as e:
        logger.error(f"Error queuing job: {e}")
        return False


def is_valid_image(key: str) -> bool:
    """Check if file is a valid image for processing."""
    valid_extensions = {'.tif', '.tiff', '.jpg', '.jpeg', '.png'}
    ext = os.path.splitext(key.lower())[1]
    return ext in valid_extensions


def lambda_handler(event, context):
    """
    Main Lambda handler - processes S3 events.

    Event structure (S3 notification):
    {
        "Records": [
            {
                "s3": {
                    "bucket": {"name": "bucket-name"},
                    "object": {"key": "incoming/project/image.tif"}
                }
            }
        ]
    }
    """
    logger.info(f"Received event: {json.dumps(event)}")

    queued_count = 0
    errors = []

    # Process each S3 event record
    for record in event.get('Records', []):
        try:
            # Extract S3 details
            bucket = record['s3']['bucket']['name']
            key = unquote_plus(record['s3']['object']['key'])

            logger.info(f"Processing S3 event: s3://{bucket}/{key}")

            # Validate it's an image
            if not is_valid_image(key):
                logger.info(f"Skipping non-image file: {key}")
                continue

            # Skip if not in incoming folder
            if not key.startswith('incoming/'):
                logger.info(f"Skipping file not in incoming/: {key}")
                continue

            # Queue the processing job
            if queue_processing_job(key, bucket):
                queued_count += 1
            else:
                errors.append(f"Failed to queue: {key}")

        except Exception as e:
            logger.error(f"Error processing record: {e}")
            errors.append(str(e))

    # Check if we should start the GPU instance
    if queued_count > 0:
        queue_depth = get_queue_depth()
        logger.info(f"Queue depth: {queue_depth}, threshold: {MIN_IMAGES_TO_START}")

        instance_state = get_instance_state(GPU_INSTANCE_ID)

        # Start instance if queue has enough items OR instance is already running
        if queue_depth >= MIN_IMAGES_TO_START or instance_state == 'running':
            if start_instance(GPU_INSTANCE_ID):
                logger.info("GPU instance started/confirmed running")
            else:
                logger.error("Failed to start GPU instance")
        else:
            logger.info(
                f"Queue depth ({queue_depth}) below threshold ({MIN_IMAGES_TO_START}). "
                f"Instance will start when threshold is reached."
            )

    response = {
        'statusCode': 200,
        'body': json.dumps({
            'queued': queued_count,
            'errors': errors,
            'queue_depth': get_queue_depth(),
            'instance_state': get_instance_state(GPU_INSTANCE_ID)
        })
    }

    logger.info(f"Response: {response}")
    return response
