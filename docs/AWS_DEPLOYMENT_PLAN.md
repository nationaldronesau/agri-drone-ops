# 🚀 AWS Production Deployment Implementation Plan
## AgriDrone Ops Platform - Complete Migration Guide

### 📋 Overview
This document provides a comprehensive implementation plan for migrating the AgriDrone Ops platform from local development to AWS production infrastructure. Follow this guide step-by-step to achieve a scalable, production-ready deployment.

---

## 🏗️ AWS Architecture

### Infrastructure Components
```
┌─────────────────────────────────────────────────────────────┐
│                        AWS Production                        │
├─────────────────────────────────────────────────────────────┤
│  CloudFront CDN → ALB → ECS Fargate → RDS PostgreSQL       │
│                     ↓                                       │
│                  S3 Storage                                 │
│                     ↓                                       │
│              ElastiCache Redis                              │
└─────────────────────────────────────────────────────────────┘
```

### Core Services Required
- **Compute**: ECS Fargate (containerized Next.js)
- **Database**: RDS PostgreSQL Multi-AZ
- **Storage**: S3 + CloudFront CDN
- **Cache/Queue**: ElastiCache Redis
- **Networking**: VPC, ALB, Route 53
- **Security**: Certificate Manager, Secrets Manager

---

## 📁 S3 Bucket Structure

### Recommended Organization
```
agridrone-ops-production/
├── projects/
│   ├── {projectId}/
│   │   ├── raw-images/
│   │   │   ├── {flightSession}/
│   │   │   │   ├── DJI_001.jpg
│   │   │   │   ├── DJI_002.jpg
│   │   │   │   └── session-metadata.json
│   │   ├── orthomosaics/
│   │   │   ├── {orthomosaicId}/
│   │   │   │   ├── original.tif
│   │   │   │   └── tiles/
│   │   │   │       ├── 10/512/384.png
│   │   │   │       └── 11/1024/768.png
│   │   ├── processed/
│   │   │   ├── thumbnails/
│   │   │   ├── ai-detections/
│   │   │   └── annotations/
│   │   └── exports/
│   │       ├── kml/
│   │       ├── csv/
│   │       └── shapefiles/
├── teams/
│   └── {teamId}/shared-resources/
└── system/
    ├── temp-uploads/
    └── backups/
```

### Real-World Example
```
projects/proj_smiths_farm_north/
├── raw-images/
│   ├── spring-survey-2024-03-15/     # 200 drone images
│   ├── follow-up-2024-04-20/         # 150 drone images
│   └── final-survey-2024-05-10/      # 180 drone images
├── orthomosaics/
│   └── full-field-mosaic-spring/     # GeoTIFF + tiles
└── exports/
    ├── lantana-detections.kml        # For spray drones
    └── wattle-locations.csv
```

---

## 💻 Code Changes Required

### 1. S3 Service Integration

**Create**: `lib/services/s3.ts`
```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class S3Service {
  private s3: S3Client;
  private bucket: string;

  constructor() {
    this.s3 = new S3Client({ region: process.env.AWS_REGION });
    this.bucket = process.env.AWS_S3_BUCKET!;
  }

  // Upload drone image with project/session structure
  async uploadImage(
    projectId: string, 
    flightSession: string, 
    filename: string, 
    buffer: Buffer
  ): Promise<string> {
    const key = `projects/${projectId}/raw-images/${flightSession}/${filename}`;
    
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: 'image/jpeg',
      Metadata: {
        projectId,
        flightSession,
        uploadedAt: new Date().toISOString()
      }
    }));

    return key;
  }

  // Generate signed URL for secure image access
  async getImageUrl(s3Key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: s3Key
    });
    return await getSignedUrl(this.s3, command, { expiresIn: 3600 });
  }

  // Upload orthomosaic with tile structure
  async uploadOrthomosaic(
    projectId: string,
    orthomosaicId: string,
    file: Buffer,
    filename: string
  ): Promise<string> {
    const key = `projects/${projectId}/orthomosaics/${orthomosaicId}/${filename}`;
    
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: file,
      ContentType: 'image/tiff'
    }));

    return key;
  }
}
```

### 2. Update Upload API

**Modify**: `app/api/upload/route.ts`
```typescript
import { S3Service } from '@/lib/services/s3';

export async function POST(request: NextRequest) {
  const s3Service = new S3Service();
  
  // ... existing form data processing ...
  
  // Replace local file save with S3 upload
  const s3Key = await s3Service.uploadImage(
    projectId,
    flightSession,
    filename,
    buffer
  );

  // Update database with S3 information
  const asset = await prisma.asset.create({
    data: {
      // ... existing fields ...
      s3Key,
      s3Bucket: process.env.AWS_S3_BUCKET,
      // Keep localPath as null for S3-stored files
    }
  });
}
```

### 3. Update Image Serving

**Modify**: `app/api/assets/[id]/route.ts`
```typescript
import { S3Service } from '@/lib/services/s3';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const asset = await prisma.asset.findUnique({
    where: { id: params.id }
  });

  if (!asset) {
    return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
  }

  // Check if asset is stored in S3
  if (asset.s3Key && asset.s3Bucket) {
    const s3Service = new S3Service();
    const signedUrl = await s3Service.getImageUrl(asset.s3Key);
    
    // Redirect to signed S3 URL
    return NextResponse.redirect(signedUrl);
  }

  // Fallback to local file serving (for backwards compatibility)
  // ... existing local file serving code ...
}
```

### 4. Database Schema Updates

**Add to**: `prisma/schema.prisma`
```prisma
model Asset {
  id            String   @id @default(cuid())
  filename      String
  originalName  String
  mimeType      String
  fileSize      BigInt
  
  // S3 Storage (NEW)
  s3Key         String?  // Full S3 path: projects/abc/raw-images/session1/image.jpg
  s3Bucket      String?  // Bucket name
  
  // Local Storage (Keep for backwards compatibility)
  localPath     String?  // Local file path
  
  // ... existing fields ...
}

model Orthomosaic {
  id            String   @id @default(cuid())
  name          String
  
  // S3 Storage (NEW)
  s3Key         String?  // projects/abc/orthomosaics/xyz/original.tif
  s3Bucket      String?
  tilesetS3Path String?  // projects/abc/orthomosaics/xyz/tiles/
  
  // Local Storage (Keep for backwards compatibility) 
  originalFile  String
  tilesetPath   String?
  
  // ... existing fields ...
}
```

### 5. Environment Configuration

**Create**: `.env.production`
```bash
# Database
DATABASE_URL="postgresql://username:password@your-rds-endpoint:5432/agridrone_ops"

# AWS Configuration
AWS_REGION="ap-southeast-2"
AWS_S3_BUCKET="agridrone-ops-production"
AWS_ACCESS_KEY_ID="your-access-key"
AWS_SECRET_ACCESS_KEY="your-secret-key"
CLOUDFRONT_DOMAIN="d123456789.cloudfront.net"

# Redis Cache
REDIS_URL="redis://your-elasticache-endpoint:6379"

# Roboflow
ROBOFLOW_API_KEY="your-roboflow-key"
ROBOFLOW_WORKSPACE="your-workspace"

# NextAuth
NEXTAUTH_URL="https://agridrone.yourdomain.com"
NEXTAUTH_SECRET="your-production-secret"

# Application
NODE_ENV="production"
```

### 6. Docker Configuration

**Create**: `Dockerfile`
```dockerfile
FROM node:18-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build Next.js
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
```

---

## 🚀 Deployment Steps

### Phase 1: AWS Infrastructure Setup (Day 1-2)

#### 1.1 Create AWS Account & IAM
```bash
# Create IAM user with required permissions
# Attach policies: ECS, RDS, S3, ElastiCache, Route53
```

#### 1.2 VPC and Networking
```bash
# Create VPC with public/private subnets
# Set up Internet Gateway and NAT Gateway
# Configure Security Groups
```

#### 1.3 Database Setup
```bash
# Create RDS PostgreSQL instance
# Configure Multi-AZ for high availability
# Set up parameter groups and backup retention
```

#### 1.4 S3 and CloudFront
```bash
# Create S3 bucket with proper CORS policy
# Set up CloudFront distribution
# Configure bucket policies for secure access
```

#### 1.5 Redis Cache
```bash
# Create ElastiCache Redis cluster
# Configure subnet groups and security groups
```

### Phase 2: Application Deployment (Day 3)

#### 2.1 Container Registry
```bash
# Create ECR repository
# Build and push Docker image
docker build -t agridrone-ops .
docker tag agridrone-ops:latest your-account.dkr.ecr.region.amazonaws.com/agridrone-ops:latest
docker push your-account.dkr.ecr.region.amazonaws.com/agridrone-ops:latest
```

#### 2.2 ECS Service
```bash
# Create ECS cluster
# Create task definition with environment variables
# Create service with load balancer integration
```

#### 2.3 Load Balancer & SSL
```bash
# Create Application Load Balancer
# Request SSL certificate through Certificate Manager
# Configure HTTPS listener
```

#### 2.4 Database Migration
```bash
# Run Prisma migrations against RDS
npx prisma migrate deploy
npx prisma generate
```

### Phase 3: Data Migration (Day 4)

#### 3.1 File Migration Script
**Create**: `scripts/migrate-to-s3.js`
```javascript
const { S3Service } = require('../lib/services/s3');
const prisma = require('../lib/db');
const fs = require('fs');
const path = require('path');

async function migrateFilesToS3() {
  const s3Service = new S3Service();
  
  // Get all assets with local files
  const assets = await prisma.asset.findMany({
    where: { 
      localPath: { not: null },
      s3Key: null 
    },
    include: { project: true }
  });

  console.log(`Migrating ${assets.length} files to S3...`);

  for (const asset of assets) {
    try {
      // Read local file
      const localPath = path.join(process.cwd(), asset.localPath);
      const buffer = fs.readFileSync(localPath);
      
      // Upload to S3 with proper structure
      const s3Key = await s3Service.uploadImage(
        asset.projectId,
        asset.flightSession || 'default',
        asset.filename,
        buffer
      );

      // Update database
      await prisma.asset.update({
        where: { id: asset.id },
        data: {
          s3Key,
          s3Bucket: process.env.AWS_S3_BUCKET
        }
      });

      console.log(`✓ Migrated: ${asset.filename}`);
    } catch (error) {
      console.error(`✗ Failed to migrate ${asset.filename}:`, error);
    }
  }

  console.log('Migration complete!');
}

migrateFilesToS3();
```

### Phase 4: Testing & Optimization (Day 5)

#### 4.1 Health Checks
- Test all API endpoints
- Verify image upload/retrieval
- Test database connections
- Validate Redis functionality

#### 4.2 Performance Testing
- Load test with multiple concurrent uploads
- Test CDN performance
- Verify auto-scaling policies

#### 4.3 Backup & Disaster Recovery
- Configure RDS automated backups
- Set up S3 cross-region replication
- Test restore procedures

---

## 💰 Cost Estimation

### Monthly AWS Costs (Estimated)

| Service | Configuration | Monthly Cost |
|---------|---------------|--------------|
| ECS Fargate | 2 vCPU, 4GB RAM | $50-100 |
| RDS PostgreSQL | db.t3.small Multi-AZ | $40-80 |
| S3 Storage | 100GB imagery | $10-25 |
| CloudFront | CDN data transfer | $5-15 |
| ElastiCache | cache.t3.micro | $15-20 |
| Route 53 | DNS hosting | $1 |
| **Total** | **Small Scale** | **$120-240** |
| **Total** | **Production Scale** | **$300-600** |

### Cost Optimization Tips
- Use S3 Intelligent Tiering for automatic cost optimization
- Set up lifecycle policies to archive old imagery
- Use CloudFront caching to reduce data transfer costs
- Monitor and set up billing alerts

---

## 🔒 Security Considerations

### Access Control
- Use IAM roles instead of access keys where possible
- Implement least privilege access principles
- Use VPC endpoints for S3 access from ECS

### Data Protection
- Enable S3 bucket versioning and MFA delete
- Use S3 server-side encryption (SSE-S3 or SSE-KMS)
- Configure RDS encryption at rest
- Use Secrets Manager for sensitive configuration

### Network Security
- Place RDS in private subnets only
- Use security groups to restrict access
- Enable VPC Flow Logs for monitoring

---

## 📊 Monitoring & Maintenance

### CloudWatch Metrics
- ECS service health and resource utilization
- RDS performance metrics
- S3 request metrics and errors
- Application-level custom metrics

### Alerts & Notifications
- Set up SNS topics for critical alerts
- Monitor disk space and memory usage
- Alert on failed deployments or health checks

### Regular Maintenance
- Apply security patches to container images
- Review and rotate access keys quarterly
- Monitor costs and optimize resource usage
- Update dependencies and frameworks

---

## 🔧 CI/CD Pipeline

### GitHub Actions Workflow
**Create**: `.github/workflows/deploy-aws.yml`
```yaml
name: Deploy to AWS

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    
    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v2
      with:
        aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        aws-region: ap-southeast-2

    - name: Login to Amazon ECR
      uses: aws-actions/amazon-ecr-login@v1

    - name: Build and push Docker image
      run: |
        docker build -t agridrone-ops .
        docker tag agridrone-ops:latest $ECR_REGISTRY/agridrone-ops:latest
        docker push $ECR_REGISTRY/agridrone-ops:latest

    - name: Deploy to ECS
      run: |
        aws ecs update-service --cluster agridrone-ops --service agridrone-ops-service --force-new-deployment
```

---

## ✅ Post-Deployment Checklist

### Functional Testing
- [ ] Image upload working with S3 storage
- [ ] Database connections stable
- [ ] AI detection processing functional
- [ ] Map visualization loading correctly
- [ ] Export functionality working
- [ ] Authentication flow operational (if enabled)

### Performance Validation
- [ ] Page load times under 3 seconds
- [ ] Image loading optimized through CloudFront
- [ ] Database queries performing well
- [ ] Auto-scaling policies tested

### Security Verification
- [ ] SSL certificates properly configured
- [ ] S3 bucket policies restrictive
- [ ] Database access limited to application only
- [ ] Secrets properly stored in Secrets Manager

### Operational Readiness
- [ ] Monitoring dashboards configured
- [ ] Alert notifications working
- [ ] Backup procedures tested
- [ ] Disaster recovery plan documented

---

## 🆘 Troubleshooting Guide

### Common Issues

**ECS Task Failing to Start**
```bash
# Check task logs in CloudWatch
aws logs get-log-events --log-group-name /ecs/agridrone-ops
```

**Database Connection Issues**
```bash
# Test RDS connectivity
psql -h your-rds-endpoint -U username -d agridrone_ops
```

**S3 Upload Errors**
```bash
# Verify bucket permissions and CORS policy
aws s3api get-bucket-cors --bucket agridrone-ops-production
```

**High Costs**
```bash
# Review cost breakdown in AWS Cost Explorer
# Check for unattached EBS volumes or idle resources
```

---

## 📞 Support & Resources

### AWS Documentation
- [ECS Fargate Guide](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/)
- [RDS PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/)
- [S3 Best Practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/)

### Development Team Resources
- Regular code reviews before deployment
- Infrastructure as Code with Terraform/CDK
- Staging environment for testing changes
- Documentation updates with each deployment

---

**Last Updated**: 2025-07-23  
**Version**: 1.0  
**Team**: AgriDrone Ops Development Team

This comprehensive plan provides everything needed for a successful AWS migration. Follow each phase carefully and test thoroughly at each step!