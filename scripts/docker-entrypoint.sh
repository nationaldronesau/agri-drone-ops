#!/bin/sh
set -e

echo "Running Prisma migrations..."
npx prisma migrate deploy

echo "Starting web + inference worker with PM2-runtime..."

# Start pm2-runtime (reads ecosystem.config.js)
exec pm2-runtime ecosystem.config.js
