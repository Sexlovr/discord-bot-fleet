# ──────────────────────────────────────────────────────────────────────────
# Bootstrap Dockerfile for HuggingFace Spaces.
#
# What this does:
#   1. Installs Node 20 + git + ca-certificates.
#   2. At container START (runtime, not build), clones your private GitHub
#      repo using the GIT_PAT HF Secret, installs deps, compiles TypeScript,
#      and starts the bot fleet server.
#
# This means your HF Space repo only needs THIS Dockerfile + entrypoint.sh +
# README.md. All real source code lives on GitHub. Push to GitHub main →
# restart the Space → new code is live.
#
# Required HF Secrets (Settings → Variables and secrets → New secret):
#   - GIT_PAT         GitHub Personal Access Token with `repo` scope
#   - ADMIN_PASSWORD  Web panel login password (16+ chars recommended)
#   - MASTER_KEY      32+ hex chars, encrypts bot tokens at rest
#                     (generate with: openssl rand -hex 32)
#
# Required HF Space env vars (Settings → Variables → New variable):
#   - REPO_URL        e.g. https://github.com/YOUR_USERNAME/discord-bot-fleet
#   - REPO_BRANCH     (optional, default: main)
# ──────────────────────────────────────────────────────────────────────────

FROM node:20-slim

# Install git + ca-certs for HTTPS clone
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates bash \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the bootstrap entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && \
    # Pre-create the data dir so it's owned by root
    mkdir -p /data

# Defaults (override via HF env vars)
ENV NODE_ENV=production
ENV PORT=7860
ENV DATA_DIR=/data
ENV REPO_BRANCH=main

# HF Space exposes 7860 by default
EXPOSE 7860

# Health check — confirms server is up
HEALTHCHECK --interval=60s --timeout=15s --start-period=120s --retries=3 \
    CMD node -e "require('http').get('http://localhost:7860/', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/entrypoint.sh"]
