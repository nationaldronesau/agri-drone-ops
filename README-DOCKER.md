# Docker Deployment Guide for AgriDrone Ops

This guide explains how to build and deploy the AgriDrone Ops platform using Docker for CI/CD.

## 🚀 Quick Start

### Development with Docker

```bash
# Build and run development environment
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up

# Access the application
open http://localhost:3000

# View database with Prisma Studio
docker-compose -f docker-compose.yml -f docker-compose.dev.yml --profile tools up
open http://localhost:5555
```

### Production Build

```bash
# Build production image
docker build -t agridrone-ops .

# Run with docker-compose
docker-compose up -d

# Check health
curl http://localhost:3000/api/health
```

## 📦 Docker Images

### Production Image (Dockerfile)
- Multi-stage build for optimized size
- Node.js 20 Alpine base
- Standalone Next.js build
- Non-root user execution
- Health check included

### Development Image (Dockerfile.dev)
- Full development environment
- Hot reloading enabled
- All dev dependencies included

## 🔧 Configuration

### Environment Variables

Create a `.env` file for docker-compose:

```env
# Database
DATABASE_URL=postgresql://postgres:password@db:5432/agridrone

# Authentication
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-here

# Roboflow API
ROBOFLOW_API_KEY=your-api-key
ROBOFLOW_WORKSPACE=your-workspace

# AWS (for production)
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=ap-southeast-2
S3_BUCKET=agridrone-uploads

# Redis
REDIS_URL=redis://redis:6379

# Mapbox
NEXT_PUBLIC_MAPBOX_TOKEN=your-mapbox-token

# Auth mode
NEXT_PUBLIC_AUTH_MODE=disabled
```

### Docker Compose Services

1. **app** - Main Next.js application
2. **db** - PostgreSQL database
3. **redis** - Redis for job queues
4. **nginx** - Reverse proxy (production profile)

## 🚢 CI/CD Integration

### GitHub Actions

The repository includes `.github/workflows/docker-build.yml` for automated builds:

- Builds on push to main/develop
- Pushes to GitHub Container Registry
- Multi-platform support (amd64/arm64)
- Automated testing on PRs

### Deploy to Production

1. **AWS ECS**:
```bash
# Build and push to ECR
aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_URL
docker build -t $ECR_URL/agridrone-ops:latest .
docker push $ECR_URL/agridrone-ops:latest

# Update ECS service
aws ecs update-service --cluster production --service agridrone-ops --force-new-deployment
```

2. **Docker Swarm**:
```bash
docker stack deploy -c docker-compose.yml agridrone
```

3. **Kubernetes**:
```bash
kubectl apply -f k8s/
```

## 🔒 Security Considerations

1. **Secrets Management**:
   - Use Docker secrets or environment files
   - Never commit `.env` files
   - Rotate secrets regularly

2. **Network Security**:
   - Internal network for service communication
   - Only expose necessary ports
   - Use HTTPS in production

3. **Image Security**:
   - Run as non-root user
   - Minimal Alpine base image
   - Regular security updates

## 📊 Monitoring

### Health Checks

- Application: `GET /api/health`
- Database: PostgreSQL health check
- Redis: Redis ping command

### Logging

```bash
# View logs
docker-compose logs -f app

# View specific service
docker-compose logs -f db
```

## 🛠️ Troubleshooting

### Common Issues

1. **Database Connection Failed**:
   ```bash
   # Check database is running
   docker-compose ps db
   
   # Check logs
   docker-compose logs db
   ```

2. **Build Failures**:
   ```bash
   # Clear cache and rebuild
   docker-compose build --no-cache
   ```

3. **Permission Issues**:
   ```bash
   # Fix upload directory permissions
   docker-compose exec app chown -R nextjs:nodejs /app/public/uploads
   ```

### Debug Commands

```bash
# Enter container shell
docker-compose exec app sh

# Run Prisma migrations
docker-compose exec app npx prisma migrate deploy

# Check environment
docker-compose exec app env
```

## 🔄 Updates and Maintenance

### Updating the Application

```bash
# Pull latest changes
git pull

# Rebuild images
docker-compose build

# Restart services
docker-compose up -d

# Run migrations
docker-compose exec app npx prisma migrate deploy
```

### Backup and Restore

```bash
# Backup database
docker-compose exec db pg_dump -U postgres agridrone > backup.sql

# Restore database
docker-compose exec -T db psql -U postgres agridrone < backup.sql
```

## 📈 Scaling

### Horizontal Scaling

```yaml
# docker-compose.override.yml
services:
  app:
    deploy:
      replicas: 3
```

### Resource Limits

```yaml
services:
  app:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
```

## 🎯 Best Practices

1. **Use specific image tags** in production
2. **Enable BuildKit** for faster builds: `DOCKER_BUILDKIT=1`
3. **Use multi-stage builds** to reduce image size
4. **Implement proper logging** and monitoring
5. **Regular security updates** for base images
6. **Use Docker secrets** for sensitive data
7. **Implement graceful shutdown** handling

## 📞 Support

For issues or questions:
- Check application logs: `docker-compose logs`
- Review health endpoint: `/api/health`
- Check GitHub issues: https://github.com/nationaldronesau/agri-drone-ops/issues