# Stage 1: Install dependencies
FROM node:20-alpine AS deps

# Install compatibility libs for native modules
RUN apk add --no-cache libc6-compat

# Set working directory
WORKDIR /app

# Copy only package files for caching
COPY package.json package-lock.json* ./

# Install full dependencies (including dev for build)
RUN npm ci

# Copy Prisma schema for generation (if using Prisma)
COPY prisma ./prisma/

# Generate Prisma client
RUN npx prisma generate


# Stage 2: Build the Next.js app
FROM node:20-alpine AS builder

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy the full app source code
COPY . .

# Set env for production build
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Build the Next.js app
RUN npm run build

# Stage 3: Production image to run app
FROM node:20-alpine AS runner

WORKDIR /app

# Set environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=80

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Install runtime dependencies
RUN apk add --no-cache libc6-compat

# Copy necessary build output
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# If you use Prisma in production (with PostgreSQL or MySQL)
COPY --from=builder /app/prisma ./prisma

# Copy entrypoint script
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

RUN mkdir -p /app/public/uploads && chown -R nextjs:nodejs /app/public/uploads
# Optional: SQLite support
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 80

ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
