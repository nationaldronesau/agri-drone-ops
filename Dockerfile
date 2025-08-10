# ----------------------
# Stage 1: Install dependencies
# ----------------------
    FROM node:20-alpine AS deps

    # Install compatibility libs for native modules (some Prisma binaries need this)
    RUN apk add --no-cache libc6-compat
    
    # Set working directory
    WORKDIR /app
    
    # Copy only package files for caching (so rebuilds are faster)
    COPY package.json package-lock.json* ./
    
    # Install all dependencies (dev + prod) for the build stage
    RUN npm ci
    
    # Copy Prisma schema early to run generate (saves build time if schema changes rarely)
    COPY prisma ./prisma/
    
    # Generate Prisma client
    RUN npx prisma generate
    
    
    # ----------------------
    # Stage 2: Build the Next.js app
    # ----------------------
    FROM node:20-alpine AS builder
    
    WORKDIR /app
    
    # Bring over node_modules from deps stage
    COPY --from=deps /app/node_modules ./node_modules
    
    # Copy full project source
    COPY . .
    
    # Set production env for Next.js build
    ENV NODE_ENV=production
    ENV NEXT_TELEMETRY_DISABLED=1
    
    # Build Next.js app
    RUN npm run build
    
    
    # ----------------------
    # Stage 3: Production runtime
    # ----------------------
    FROM node:20-alpine AS runner
    
    WORKDIR /app
    
    # Environment settings
    ENV NODE_ENV=production
    ENV NEXT_TELEMETRY_DISABLED=1
    ENV PORT=8080
    
    # Install runtime-only dependencies
    RUN apk add --no-cache libc6-compat
    
    # Create a non-root user (for security)
    RUN addgroup --system --gid 1001 nodejs \
     && adduser --system --uid 1001 nextjs
    
    # Copy built application from builder
    COPY --from=builder /app/.next ./.next
    COPY --from=builder /app/node_modules ./node_modules
    COPY --from=builder /app/public ./public
    COPY --from=builder /app/package.json ./package.json
    COPY --from=builder /app/prisma ./prisma
    
    # Copy entrypoint script and make executable
    COPY ./scripts/docker-entrypoint.sh ./scripts/
    RUN chmod +x ./scripts/docker-entrypoint.sh
    
    # Ensure .next folder is writable (prevents EACCES error during runtime)
    RUN mkdir -p .next && chown -R nextjs:nodejs .next
    
    # Ensure uploads & data folders are writable
    RUN mkdir -p /app/public/uploads && chown -R nextjs:nodejs /app/public/uploads
    RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data
    
    # Switch to non-root user
    USER nextjs
    
    # Expose container port (Beanstalk/Nginx can map this to port 80)
    EXPOSE 8080
    
    # Run entrypoint script (handles migrations & starts server)
    ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
    