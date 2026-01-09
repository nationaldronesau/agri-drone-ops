# ----------------------
# Stage 1: Install dependencies
# ----------------------
FROM node:20-alpine AS deps

# Install compatibility libs for Prisma & native modules
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copy only package files first (for better layer caching)
COPY package.json package-lock.json* ./

# Install dependencies (dev + prod for build)
RUN npm ci

# Copy Prisma schema early to run generate
COPY prisma ./prisma/
RUN npx prisma generate

# ----------------------
# Stage 2: Build the Next.js app
# ----------------------
FROM node:20-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ----------------------
# Stage 3: Production runtime with PM2
# ----------------------
FROM node:20-alpine AS runner

WORKDIR /app

# Environment settings — Beanstalk will set PORT, default to 8080
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080

# Install compatibility libs + PM2 globally
RUN apk add --no-cache libc6-compat bash curl \
    && npm install -g pm2

# Create non-root user
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Copy built files
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/workers ./workers
COPY --from=builder /app/lib ./lib
# Copy tsconfig.json so tsconfig-paths can resolve @/* imports
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Copy entrypoint script
COPY ./scripts/docker-entrypoint.sh ./scripts/
RUN chmod +x ./scripts/docker-entrypoint.sh

# Ensure writable directories exist
RUN mkdir -p .next && chown -R nextjs:nodejs .next
# Optional: SQLite support
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

USER nextjs

# Match Beanstalk’s default Nginx proxy mapping
EXPOSE 8080

# ----------------------
# PM2 ecosystem configuration
# ----------------------
# We'll define two processes: web (Next.js) and worker:inference
COPY ./ecosystem.config.js ./

##############################################################################
# Run PM2-runtime when container starts
##############################################################################
CMD ["pm2-runtime", "ecosystem.config.js"]
