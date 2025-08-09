# AWS S3 Migration Guide for AgriDrone Ops

This guide explains how to migrate from local file storage to AWS S3 for the AgriDrone Ops platform.

## 🚀 Overview

The platform now supports both local file storage and AWS S3, with automatic fallback to local storage if S3 is not configured or fails.

### File Structure in S3

Files are organized hierarchically in S3:

```
{NODE_ENV}/
├── {projectId}/
│   ├── raw-images/
│   │   └── {flightSession}/
│   │       └── {filename}.jpg
│   └── orthomosaics/
│       └── {orthomosaicId}/
│           ├── {filename}.tif
│           └── tiles/
│               └── {z}/{x}/{y}.png
```

## 📋 Prerequisites

1. **AWS Account** with S3 access
2. **S3 Bucket** created in your preferred region
3. **IAM User** with S3 permissions (or use IAM roles in production)

## 🔧 Configuration

### 1. Environment Variables

Add these to your `.env` file:

```env
# AWS S3 Configuration
AWS_ACCESS_KEY_ID=your-access-key-id
AWS_SECRET_ACCESS_KEY=your-secret-access-key
AWS_REGION=ap-southeast-2  # Sydney region (change as needed)
AWS_S3_BUCKET=agridrone-ops

# Environment (affects S3 path structure)
NODE_ENV=production  # or staging, development
```

### 2. IAM Permissions

Your IAM user/role needs these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:HeadObject"
      ],
      "Resource": [
        "arn:aws:s3:::agridrone-ops/*",
        "arn:aws:s3:::agridrone-ops"
      ]
    }
  ]
}
```

### 3. S3 Bucket Configuration

#### CORS Configuration (if accessing directly from browser):

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedOrigins": ["http://localhost:3000", "https://yourdomain.com"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

#### Bucket Policy (optional - for public read access):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::agridrone-ops/*"
    }
  ]
}
```

**Note**: For production, use signed URLs instead of public access.

## 🚀 Migration Steps

### 1. Test S3 Configuration

```bash
# Test upload functionality
curl -X POST http://localhost:3000/api/upload \
  -F "files=@test-image.jpg" \
  -F "projectId=test-project" \
  -F "flightSession=test-flight"
```

### 2. Migrate Existing Files

Create a migration script (`scripts/migrate-to-s3.ts`):

```typescript
import { S3Service } from '@/lib/services/s3';
import prisma from '@/lib/db';
import fs from 'fs/promises';
import path from 'path';

async function migrateToS3() {
  // Fetch all assets with local storage
  const assets = await prisma.asset.findMany({
    where: { storageType: 'local' }
  });

  for (const asset of assets) {
    try {
      // Read local file
      const filePath = path.join(process.cwd(), 'public', asset.storageUrl);
      const buffer = await fs.readFile(filePath);

      // Upload to S3
      const s3Result = await S3Service.uploadFile(buffer, {
        projectId: asset.projectId,
        flightSession: asset.flightSession || 'migrated',
        filename: asset.fileName,
        contentType: asset.mimeType,
      });

      // Update database
      await prisma.asset.update({
        where: { id: asset.id },
        data: {
          s3Key: s3Result.key,
          s3Bucket: s3Result.bucket,
          storageType: 's3',
        }
      });

      console.log(`Migrated: ${asset.fileName}`);
    } catch (error) {
      console.error(`Failed to migrate ${asset.fileName}:`, error);
    }
  }
}

migrateToS3();
```

Run the migration:

```bash
npx ts-node scripts/migrate-to-s3.ts
```

### 3. Update Frontend Components

Use the provided `useSignedUrl` hook or `S3Image` component:

```tsx
import { S3Image } from '@/lib/hooks/useSignedUrl';

// Before
<img src={asset.storageUrl} alt="Drone image" />

// After
<S3Image assetId={asset.id} src={asset.storageUrl} alt="Drone image" />
```

## 🔄 API Changes

### Upload Response

The upload API now returns additional S3 information:

```json
{
  "id": "asset-id",
  "storageUrl": "https://bucket.s3.region.amazonaws.com/path/to/file",
  "storageType": "s3",
  "s3Key": "production/project-id/raw-images/flight-1/image.jpg",
  "s3Bucket": "agridrone-ops"
}
```

### Signed URL Endpoint

New endpoint for getting signed URLs:

```
GET /api/assets/{id}/signed-url
GET /api/orthomosaics/{id}/signed-url
```

Response:
```json
{
  "url": "https://signed-url...",
  "storageType": "s3",
  "expiresIn": 3600
}
```

## 🏗️ Production Considerations

### 1. Use IAM Roles

Instead of access keys, use IAM roles for EC2/ECS:

```typescript
// S3 client will automatically use IAM role
const s3Client = new S3Client({
  region: process.env.AWS_REGION || "ap-southeast-2",
  // No credentials needed - uses IAM role
});
```

### 2. CloudFront CDN

For better performance, set up CloudFront:

1. Create CloudFront distribution
2. Set S3 bucket as origin
3. Configure cache behaviors
4. Update `storageUrl` to use CloudFront domain

### 3. Lifecycle Policies

Configure S3 lifecycle policies for cost optimization:

```json
{
  "Rules": [
    {
      "Id": "ArchiveOldImages",
      "Status": "Enabled",
      "Transitions": [
        {
          "Days": 90,
          "StorageClass": "STANDARD_IA"
        },
        {
          "Days": 365,
          "StorageClass": "GLACIER"
        }
      ]
    }
  ]
}
```

### 4. Monitoring

Set up CloudWatch alarms for:
- S3 bucket size
- Request errors
- Data transfer costs

## 🐛 Troubleshooting

### Common Issues

1. **Access Denied**
   - Check IAM permissions
   - Verify bucket name and region
   - Ensure credentials are loaded

2. **CORS Errors**
   - Update S3 bucket CORS configuration
   - Use signed URLs instead of direct access

3. **Slow Uploads**
   - Consider multipart upload for large files
   - Use transfer acceleration for remote regions

4. **Missing Files**
   - Check `storageType` field in database
   - Verify S3 key structure
   - Ensure migration completed successfully

### Debug Mode

Enable S3 debug logging:

```typescript
// In lib/services/s3.ts
import { Logger } from "@aws-sdk/types";

const logger: Logger = {
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

const s3Client = new S3Client({
  logger,
  // ... other config
});
```

## 📊 Cost Estimation

### S3 Pricing (Sydney region)

- **Storage**: $0.025 per GB/month
- **Requests**: 
  - PUT/POST: $0.0055 per 1,000 requests
  - GET: $0.00044 per 1,000 requests
- **Data Transfer**: $0.114 per GB (to internet)

### Example Monthly Costs

For 10,000 images (10GB) with 100,000 views:
- Storage: $0.25
- Upload requests: $0.06
- View requests: $0.04
- Data transfer (assuming 50GB): $5.70
- **Total**: ~$6.05/month

## 🔐 Security Best Practices

1. **Never commit AWS credentials**
2. **Use least-privilege IAM policies**
3. **Enable S3 bucket versioning**
4. **Set up bucket encryption**
5. **Monitor access logs**
6. **Use signed URLs with short expiration**
7. **Implement request throttling**

## 📝 Checklist

- [ ] Create S3 bucket
- [ ] Configure IAM user/role
- [ ] Update environment variables
- [ ] Test upload functionality
- [ ] Migrate existing files
- [ ] Update frontend components
- [ ] Set up monitoring
- [ ] Configure backups
- [ ] Document S3 structure for team

## 🆘 Support

For issues or questions:
1. Check AWS CloudTrail logs
2. Review application logs
3. Test with AWS CLI: `aws s3 ls s3://agridrone-ops/`
4. Contact your DevOps team