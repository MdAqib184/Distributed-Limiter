# ============================================================
# DOCKERFILE — Multi-stage build for production
# ============================================================
# Stage 1: Install dependencies
# Stage 2: Run the app (smaller final image, no dev tools)

FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first (Docker layer caching optimization)
# If package.json doesn't change, this layer is cached on rebuilds
COPY package*.json ./
RUN npm ci --only=production

# ============================================================

FROM node:20-alpine AS runtime

# Security: Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy built dependencies from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY src/ ./src/
COPY package.json ./

# Switch to non-root user
USER nodejs

EXPOSE 3000

# Health check so Docker knows if container is healthy
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "src/server.js"]
