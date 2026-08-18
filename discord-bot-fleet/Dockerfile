# ─── Build stage ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && \
    npm install typescript@^5.6.3 --no-save

# Copy source and compile
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ─── Runtime stage ───────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Copy package + install only prod deps
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy compiled output + web panel + config
COPY --from=builder /app/dist ./dist
COPY web ./web
COPY data/.gitkeep ./data/.gitkeep

# Create writable data dir on HF Space (HF mounts /data as persistent volume)
# We symlink /app/data → /data so HF's persistent storage survives restarts
RUN mkdir -p /data && \
    rm -rf /app/data && \
    ln -s /data /app/data

ENV NODE_ENV=production
ENV PORT=7860
ENV DATA_DIR=/data

# HF Space expects port 7860
EXPOSE 7860

# Health check (optional — HF pings /)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:7860/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/server.js"]
