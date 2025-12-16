#!/bin/bash
set -e

echo "=== Pre-deploy: Running Prisma migrations ==="

cd /var/app/staging

# Generate Prisma client
npx prisma generate

# Run database migrations (safe for production - only applies pending migrations)
npx prisma migrate deploy

echo "=== Pre-deploy: Migrations complete ==="
