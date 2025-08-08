# AWS S3 Migration Summary

## ✅ Completed Tasks

### 1. **S3 Service Module** (`/lib/services/s3.ts`)
- Complete S3 operations: upload, download, delete, signed URLs
- Hierarchical file structure: `{NODE_ENV}/{projectId}/raw-images/{flightSession}/{filename}`
- Error handling and fallback to local storage

### 2. **Database Schema Updated**
```sql
-- Added to Asset model:
s3Key         String?
s3Bucket      String?
storageType   String @default("local")

-- Added to Orthomosaic model:
s3Key         String?
s3TilesetKey  String?
s3Bucket      String?
storageType   String @default("local")
```

### 3. **Upload APIs Updated**
- `/api/upload/route.ts` - Supports S3 with automatic fallback
- `/api/orthomosaics/upload/route.ts` - Supports S3 for GeoTIFF files

### 4. **Retrieval APIs Created**
- `/api/assets/[id]/signed-url/route.ts` - Generate signed URLs for assets
- `/api/orthomosaics/[id]/signed-url/route.ts` - Generate signed URLs for orthomosaics

### 5. **React Integration**
- `useSignedUrl` hook - Automatically fetches and refreshes signed URLs
- `S3Image` component - Drop-in replacement for `<img>` tags

## 🚀 Quick Start

### Enable S3 Storage

Add to your `.env` file:
```env
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=ap-southeast-2
AWS_S3_BUCKET=agridrone-ops
```

### Use in Components

Replace image tags:
```tsx
// Before
<img src={asset.storageUrl} alt="..." />

// After
import { S3Image } from '@/lib/hooks/useSignedUrl';
<S3Image assetId={asset.id} src={asset.storageUrl} alt="..." />
```

## 📊 How It Works

1. **Upload Flow**:
   - Check if S3 credentials exist
   - Upload to S3 with structured path
   - Store S3 key in database
   - Fall back to local storage on failure

2. **Display Flow**:
   - Check if asset uses S3 (`storageType === 's3'`)
   - Generate signed URL (1 hour expiry)
   - Auto-refresh before expiry
   - Fall back to local URL if needed

## 🔒 Security

- Private S3 bucket with signed URLs
- 1-hour URL expiry
- IAM permissions required
- No public bucket access needed

## 📁 File Structure

```
S3 Bucket/
├── development/
│   └── project-123/
│       ├── raw-images/
│       │   └── flight-1/
│       │       └── DJI_0001.jpg
│       └── orthomosaics/
│           └── ortho-456/
│               └── field.tif
├── staging/
└── production/
```

## ⚡ Benefits

- **Scalable**: No server disk space limits
- **Global**: CloudFront CDN ready
- **Secure**: Signed URLs prevent unauthorized access
- **Reliable**: S3 99.999999999% durability
- **Cost-effective**: Pay only for what you use

## 🎯 Next Steps

1. Test upload with S3 enabled
2. Update all frontend image displays to use `S3Image`
3. Migrate existing files (see `/docs/S3_MIGRATION_GUIDE.md`)
4. Set up CloudFront CDN for better performance
5. Configure S3 lifecycle policies for cost optimization