# SAM3 Integration Security Guide

## Overview

The SAM3 integration supports two deployment modes:
1. **Roboflow Serverless** (recommended) - Uses Roboflow's `concept_segment` API
2. **Self-Hosted** - Run your own SAM3 inference service

This document covers security considerations for both modes.

## Roboflow Serverless Mode (Default)

### API Key Security
- Store your Roboflow API key in environment variables only
- Never commit API keys to source control
- The API uses `Authorization: Bearer` headers, not query parameters
- Keys are never logged or exposed in error messages

```env
# .env.local
ROBOFLOW_API_KEY=your-api-key-here
```

### Rate Limiting
- Built-in rate limiting: 30 requests per minute per IP
- Rate limit responses include `Retry-After` header
- Protects against abuse and runaway client requests

### SSRF Protection
The predict endpoint validates all image URLs against an allowlist:
- AWS S3: `https://*.amazonaws.com/*`
- Google Cloud Storage: `https://storage.googleapis.com/*`
- Azure Blob: `https://*.blob.core.windows.net/*`
- Local development: `http://localhost:*` and `http://127.0.0.1:*`

URLs not matching these patterns are rejected.

### Input Validation
- Asset IDs must be valid CUID format
- Point coordinates are bounded (0-10000)
- Maximum 20 points per request
- Maximum 10 box exemplars per request
- Image size limit: 10MB

### Error Handling
- Detailed errors are logged server-side only
- Client receives sanitized error messages
- No stack traces or internal paths exposed

## Self-Hosted Mode

If you deploy your own SAM3 inference service, additional security measures are required.

### Network Security

```yaml
# docker-compose.yml example
services:
  sam3-service:
    image: your-sam3-image
    networks:
      - internal  # Internal network only
    ports:
      - "127.0.0.1:8000:8000"  # Bind to localhost only
```

**Recommendations:**
- Never expose SAM3 service directly to the internet
- Use internal Docker networks
- Bind only to localhost for development
- Use a reverse proxy (nginx, traefik) for production

### Authentication

Add authentication to your self-hosted service:

```python
# app/middleware/auth.py
from fastapi import Request, HTTPException, Depends
from fastapi.security import APIKeyHeader

API_KEY_HEADER = APIKeyHeader(name="X-API-Key")

async def verify_api_key(api_key: str = Depends(API_KEY_HEADER)):
    if api_key != os.environ.get("SAM3_API_KEY"):
        raise HTTPException(status_code=401, detail="Invalid API key")
    return api_key
```

Then update the Next.js proxy to include authentication:

```typescript
// app/api/sam3/predict/route.ts
const response = await fetch(SAM3_SERVICE_URL, {
  headers: {
    'X-API-Key': process.env.SAM3_SERVICE_API_KEY,
    'Content-Type': 'application/json',
  },
  // ...
});
```

### Resource Limits

Configure resource limits to prevent DoS:

```yaml
# docker-compose.yml
services:
  sam3-service:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 8G
        reservations:
          memory: 4G
```

### Image Processing Security

For self-hosted deployments processing untrusted images:

1. **Validate image format** before processing
2. **Limit image dimensions** (e.g., max 8192x8192)
3. **Set processing timeouts** to prevent resource exhaustion
4. **Run inference in sandboxed container** with minimal privileges

```python
# Example validation
from PIL import Image
import io

MAX_DIMENSION = 8192
MAX_FILE_SIZE = 20 * 1024 * 1024  # 20MB

def validate_image(image_data: bytes) -> Image.Image:
    if len(image_data) > MAX_FILE_SIZE:
        raise ValueError("Image too large")

    img = Image.open(io.BytesIO(image_data))
    if img.width > MAX_DIMENSION or img.height > MAX_DIMENSION:
        raise ValueError("Image dimensions exceed limit")

    return img
```

### Logging and Monitoring

- Log all prediction requests (without image data)
- Monitor for unusual patterns (high volume, large images)
- Set up alerts for failed authentication attempts
- Rotate logs regularly

```python
import logging
from datetime import datetime

logger = logging.getLogger("sam3")

@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = datetime.utcnow()
    response = await call_next(request)
    duration = (datetime.utcnow() - start).total_seconds()

    logger.info(
        "request",
        extra={
            "path": request.url.path,
            "method": request.method,
            "status": response.status_code,
            "duration_s": duration,
            "client_ip": request.client.host,
        }
    )
    return response
```

## Environment Variables Reference

```env
# Roboflow Serverless (recommended)
ROBOFLOW_API_KEY=your-roboflow-api-key

# Self-Hosted (optional)
SAM3_SERVICE_URL=http://localhost:8000
SAM3_SERVICE_API_KEY=your-internal-api-key
HF_TOKEN=your-huggingface-token  # For model download
```

## Security Checklist

### Before Production Deployment

- [ ] API keys stored in environment variables, not code
- [ ] Rate limiting configured and tested
- [ ] SSRF protection verified for your storage providers
- [ ] Error messages reviewed for information leakage
- [ ] Logging configured without sensitive data
- [ ] Network isolation verified (for self-hosted)
- [ ] Authentication enabled (for self-hosted)
- [ ] Resource limits set (for self-hosted)
- [ ] TLS/HTTPS configured for all endpoints
- [ ] Regular security updates scheduled

### Ongoing Maintenance

- Rotate API keys periodically
- Monitor for unusual access patterns
- Keep dependencies updated
- Review logs for security issues
- Test rate limiting effectiveness
