# S3 Integration Usage Examples

## Quick Start - Using S3 in Your Components

### 1. Display Images with Automatic S3 Support

Instead of using regular `<img>` tags, use the `S3Image` component:

```tsx
// app/images/page.tsx or any component displaying images

import { S3Image } from '@/lib/hooks/useSignedUrl';

// Before (direct URL - won't work with private S3):
<img 
  src={asset.storageUrl} 
  alt={asset.fileName}
  className="w-full h-48 object-cover"
/>

// After (works with both S3 and local storage):
<S3Image 
  assetId={asset.id}
  src={asset.storageUrl}  // fallback for local files
  alt={asset.fileName}
  className="w-full h-48 object-cover"
/>
```

### 2. Using the Hook Directly

For more control, use the `useSignedUrl` hook:

```tsx
import { useSignedUrl } from '@/lib/hooks/useSignedUrl';

function ImageModal({ asset }) {
  const { url, loading, error } = useSignedUrl(asset.id, 'asset');

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error loading image</div>;

  return (
    <div className="modal">
      <img src={url} alt={asset.fileName} />
      <a href={url} download>Download</a>
    </div>
  );
}
```

### 3. Orthomosaic Viewer

For orthomosaics, specify the type:

```tsx
function OrthomosaicViewer({ orthomosaic }) {
  const { url, loading } = useSignedUrl(orthomosaic.id, 'orthomosaic');

  if (loading) return <div>Loading orthomosaic...</div>;

  return (
    <div className="orthomosaic-container">
      <img src={url} alt={orthomosaic.name} />
    </div>
  );
}
```

### 4. Batch Updates for Existing Pages

To quickly update existing pages, you can do a find-and-replace:

**Find:**
```tsx
<img src={asset.storageUrl}
```

**Replace with:**
```tsx
<S3Image assetId={asset.id} src={asset.storageUrl}
```

### 5. Upload Form with Flight Session

When uploading, include the flight session for proper S3 organization:

```tsx
const formData = new FormData();
formData.append('files', file);
formData.append('projectId', projectId);
formData.append('flightSession', 'Morning Survey'); // Important for S3 path

const response = await fetch('/api/upload', {
  method: 'POST',
  body: formData,
});
```

## Testing S3 Integration

1. **Enable S3** - Add to your `.env`:
   ```
   AWS_ACCESS_KEY_ID=your-key
   AWS_SECRET_ACCESS_KEY=your-secret
   AWS_REGION=ap-southeast-2
   AWS_S3_BUCKET=your-bucket-name
   ```

2. **Upload a test image** and check the database:
   ```sql
   SELECT id, fileName, storageType, s3Key, s3Bucket 
   FROM Asset 
   ORDER BY createdAt DESC 
   LIMIT 5;
   ```

3. **Verify S3 upload** in AWS Console or CLI:
   ```bash
   aws s3 ls s3://your-bucket-name/development/
   ```

## Common Patterns

### Loading State with Skeleton
```tsx
<S3Image 
  assetId={asset.id}
  src={asset.storageUrl}
  alt={asset.fileName}
  className="w-full h-48 object-cover"
  loading={
    <div className="w-full h-48 bg-gray-200 animate-pulse" />
  }
/>
```

### Error Handling
```tsx
const { url, error, refresh } = useSignedUrl(asset.id);

if (error) {
  return (
    <div className="error-state">
      <p>Failed to load image</p>
      <button onClick={refresh}>Retry</button>
    </div>
  );
}
```

### Prefetching URLs
```tsx
// Prefetch signed URLs for a gallery
const assets = await fetchAssets();
const urlPromises = assets.map(asset => 
  fetch(`/api/assets/${asset.id}/signed-url`).then(r => r.json())
);
const signedUrls = await Promise.all(urlPromises);
```

## Fallback Strategy

The system automatically falls back to local storage if:
- S3 credentials are not configured
- S3 upload fails
- Asset was uploaded before S3 integration

No code changes needed - it just works! 🎉