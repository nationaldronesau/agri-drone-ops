FROM node:20-alpine

# Install compatibility libs for Prisma & native modules
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copy package files first
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci

# Copy Prisma schema & generate client early
COPY prisma ./prisma/
RUN npx prisma generate

# Copy rest of the source code
COPY . .

# Build Next.js directly in the same container
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Create non-root user
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Writable dirs
RUN mkdir -p /app/public/uploads && chown -R nextjs:nodejs /app/public/uploads \
    && mkdir -p /app/data && chown -R nextjs:nodejs /app/data

USER nextjs

# Expose Beanstalk default
ENV PORT=8080
EXPOSE 8080

# Run migrations + start
CMD npx prisma migrate deploy && npm run start -- -p $PORT
