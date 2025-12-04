# AgriDrone Ops — Deployment Overview (Elastic Beanstalk)

This document describes how AgriDrone Ops is deployed, the platform used, and the deployment architecture.

It focuses only on what has been implemented—clear, simple, and to the point.

## 1. Platform & Architecture

AgriDrone Ops runs on AWS Elastic Beanstalk using:

- Single-Container Docker (Amazon Linux 2)
- MySQL RDS database
- Built-in Elastic Beanstalk Nginx reverse proxy
- Application Load Balancer (ALB) for HTTPS termination
- S3 for file storage
- CloudFront for serving static imagery
- Redis (ElastiCache Serverless) for caching and background operations

**Traffic flow:**
```
Client → CloudFront (static assets)
Client → AWS ALB (HTTPS) → EB Nginx → Docker container (Next.js on port 8080)
```

## 2. Environment Variables (Production)

Environment variables are set directly in the Elastic Beanstalk console:

```
NODE_ENV=production
PORT=8080
NEXT_TELEMETRY_DISABLED=1
DATABASE_URL=mysql://username:password@agridrone-cluster.cluster-ro-cwi2bksacgtt.ap-southeast-2.rds.amazonaws.com:3306/agridrone
AWS_REGION=ap-southeast-2
AWS_S3_BUCKET=nd-agridrone
CLOUDFRONT_BASE_URL=https://staticagridrone.ndsmartdata.com
REDIS_URL=rediss://agrodrone-9dbvsf.serverless.apse2.cache.amazonaws.com:6379

# Roboflow Integration
ROBOFLOW_API_KEY=<your-api-key>
ROBOFLOW_WORKSPACE=smartdata-ggzkp
```

These values support:
- MySQL-based Prisma ORM
- AWS S3 upload handling
- Static distribution through CloudFront
- Redis caching / task queue
- Next.js production runtime
- Roboflow AI model integration

## 3. Docker Build Process

The deployment uses a three-stage Dockerfile:

### Stage 1 — deps
- Based on `node:20-alpine`
- Installs all application dependencies (`npm ci`)
- Generates Prisma client

### Stage 2 — builder
- Builds the Next.js production bundle (`npm run build`)

### Stage 3 — runner
- Copies compiled `.next`, `node_modules`, `public`, Prisma schema
- Creates `nextjs` non-root user
- Exposes port 8080
- Starts via `docker-entrypoint.sh`

## 4. Entrypoint Logic

`docker-entrypoint.sh` handles runtime bootstrapping:

```bash
npx prisma migrate deploy
npm run start -- -p $PORT
```

This ensures:
- Prisma migrations automatically run whenever the container starts
- The app always aligns with the current schema
- Next.js runs on port 8080, which matches EB's proxy config
- No external migration pipeline is required

## 5. Nginx Proxy (Beanstalk Built-In)

A custom Nginx override is placed in:
```
.platform/nginx/conf.d/custom-proxy.conf
```

Key rules:
- `client_max_body_size 10000M;` for drone image uploads
- Redirect HTTP → HTTPS
- Forward all requests to the container at `http://127.0.0.1:8080`

Nginx handles all reverse proxying; the container does not run its own Nginx.

## 6. Deployment Flow (What Happens)

1. You upload a ZIP file with your code + Dockerfile to Elastic Beanstalk
2. EB builds the Docker image on its EC2 instance
3. EB provisions:
   - EC2 instance
   - Load balancer
   - Nginx proxy
4. Docker container starts and runs `docker-entrypoint.sh`
5. Prisma migrations apply automatically
6. Next.js production server starts on port 8080
7. Nginx forwards all inbound traffic to the app

Everything is automated; no manual SSH or migration steps required.

## 7. Summary

AgriDrone Ops uses a clean, scalable, production-ready AWS setup:

| Component | Service |
|-----------|---------|
| Deployment | Elastic Beanstalk |
| Runtime | Docker |
| Networking | ALB + Nginx |
| Database | MySQL RDS |
| File Storage | S3 |
| CDN | CloudFront |
| Cache/Queue | Redis Serverless |
| Migrations | Auto-run on deploy |

This architecture ensures smooth drone-imagery processing, high upload throughput, reliable AI operations, and a scalable production environment.
