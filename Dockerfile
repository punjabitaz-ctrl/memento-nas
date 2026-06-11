# ─────────────────────────────────────────────────────────────────────────────
# Memento NAS Edition — Multi-stage Dockerfile
# Supports: linux/amd64, linux/arm64 (Synology, QNAP, RPi-based NAS)
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build frontend ───────────────────────────────────────────────────
FROM node:20-alpine AS client-builder

WORKDIR /build/client
COPY client/package*.json ./
RUN npm ci --prefer-offline

COPY client/ ./
RUN npm run build

# ── Stage 2: Build backend (compiles better-sqlite3 native bindings) ──────────
FROM node:20-alpine AS server-builder

# Build tools required for better-sqlite3 native C++ compilation on ANY arch
RUN apk add --no-cache python3 make g++

WORKDIR /build/server
COPY server/package*.json ./

# --build-from-source ensures compilation for the target architecture
RUN npm ci --build-from-source

COPY server/ ./

# ── Stage 3: Production image ─────────────────────────────────────────────────
FROM node:20-alpine AS production

# Install only runtime dependencies (no build tools)
RUN apk add --no-cache tini

# Non-root user for security
# node user (uid/gid 1000) is built into the node:alpine image
RUN mkdir -p /data/db /data/vault /data/sessions /data/tmp \
    && chown -R node:node /data

WORKDIR /app

# Copy compiled backend
COPY --from=server-builder --chown=node:node /build/server/node_modules ./node_modules
COPY --from=server-builder --chown=node:node /build/server/ ./

# Copy compiled frontend into the location the server expects
COPY --from=client-builder --chown=node:node /build/client/dist ./client/dist

USER node

# Health check (Docker + Synology DSM / QNAP Container Station will use this)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:${PORT:-3002}/health || exit 1

EXPOSE 3002

# tini: proper PID 1 signal handling — critical for graceful shutdown on NAS
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]
