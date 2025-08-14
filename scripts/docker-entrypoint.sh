#!/bin/sh
set -e

echo "Running Prisma migrations..."
npx prisma migrate deploy

echo "Starting Next.js on port $PORT..."
exec npm run start -- -p $PORT
