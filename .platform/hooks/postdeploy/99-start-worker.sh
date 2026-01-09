#!/bin/bash
set -e

# Add npm to PATH
export PATH=$PATH:/usr/local/bin

echo "Starting inference worker with PM2..."

# Install PM2 globally
npm install -g pm2

# Go to your application directory
cd /var/app/current

# Stop old worker if running
pm2 delete inference-worker || true

# Start worker with PM2
pm2 start npm --name "inference-worker" -- run worker:inference

# Save the process list to auto-start on reboot
pm2 save

echo "Inference worker started successfully"