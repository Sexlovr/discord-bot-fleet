# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────
# Bootstrap Dockerfile for HuggingFace Spaces — single-file edition.
#
# What this does:
#   1. Installs Node 20 + git + ca-certs.
#   2. At container START (runtime, not build), writes /entrypoint.sh from a
#      heredoc embedded in THIS Dockerfile (no separate entrypoint.sh file
#      needed in your HF Space repo).
#   3. On boot, the entrypoint clones your private GitHub repo using the
#      GIT_PAT HF Secret, installs deps, compiles TypeScript, and starts
#      the bot fleet server.
#
# Your HF Space repo only needs THIS Dockerfile + README.md. All real
# source code lives on GitHub. Push to GitHub main → restart the Space →
# new code is live.
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

# Install git + ca-certs + Python 3 + pip
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates bash python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages \
        discord.py>=2.4.0 openai>=1.50.0 aiohttp>=3.9.0 cryptography>=42.0.0

# Bake a global git safe.directory exception. Without this, git refuses to
# operate on /data/repo because HF mounts /data from a different UID.
# See: https://git-scm.com/docs/git-config/#Documentation/git-config.txt-safedirectory
RUN git config --global --add safe.directory '*'

WORKDIR /app

# Write the entrypoint script inline using a BuildKit heredoc.
# Single-quoted EOF means no shell expansion at build time — the script
# content is written verbatim, and bash variables ($GIT_PAT, $REPO_URL,
# etc.) are expanded at runtime when the script actually runs.
RUN <<'ENTRYPOINT_EOF' cat > /entrypoint.sh
#!/usr/bin/env bash
set -e

log() { echo "[entrypoint] $*"; }
err() { echo "[entrypoint] ERROR: $*" >&2; }

# ─── Validate env vars ────────────────────────────────────────────────
if [ -z "$GIT_PAT" ]; then
  err "GIT_PAT secret not set. Add it in HF Space Settings → Variables and secrets → New secret."
  err "Create a PAT at https://github.com/settings/tokens with 'repo' scope."
  exit 1
fi
if [ -z "$REPO_URL" ]; then
  err "REPO_URL env var not set. Add it in HF Space Settings → Variables → New variable."
  err "Example: https://github.com/YOUR_USERNAME/discord-bot-fleet"
  exit 1
fi

REPO_DIR=/data/repo
BRANCH="${REPO_BRANCH:-main}"

# Inject PAT into the URL (https://x-access-token:TOKEN@github.com/...)
# x-access-token is GitHub's convention for PAT auth
AUTH_URL=$(echo "$REPO_URL" | sed -E "s|^(https?://)|\1x-access-token:${GIT_PAT}@|")

# ─── Clone or pull ─────────────────────────────────────────────────────
mkdir -p /data
cd /data

if [ -d "$REPO_DIR/.git" ]; then
  log "Repo exists, fetching latest from $REPO_URL (branch $BRANCH)..."
  cd "$REPO_DIR"
  # Update remote URL (in case PAT rotated)
  git remote set-url origin "$AUTH_URL" 2>/dev/null || true
  # Fetch + hard reset to origin (we never commit from this container)
  git fetch origin "$BRANCH" --depth 1 || {
    log "Fetch failed, trying full fetch..."
    git fetch origin "$BRANCH" || {
      err "Could not fetch from origin. Will continue with existing checkout."
    }
  }
  git reset --hard "origin/$BRANCH" 2>/dev/null || log "Reset failed, continuing..."
  git clean -fd 2>/dev/null || true
  log "Current commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
else
  log "Cloning $REPO_URL (branch $BRANCH)..."
  git clone --branch "$BRANCH" --depth 1 "$AUTH_URL" "$REPO_DIR" || {
    err "Clone failed. Check GIT_PAT permissions and REPO_URL."
    exit 2
  }
  cd "$REPO_DIR"
  log "Cloned at commit: $(git rev-parse --short HEAD)"
fi

# ─── Install dependencies ─────────────────────────────────────────────
log "Working directory: $REPO_DIR"

NEEDS_INSTALL=0
NEEDS_CLEAN_INSTALL=0
if [ ! -d node_modules ]; then
  NEEDS_INSTALL=1
elif [ ! -f node_modules/.package-lock.json ]; then
  NEEDS_INSTALL=1
elif [ package.json -nt node_modules/.package-lock.json ]; then
  # package.json changed since last install — do a clean install to avoid
  # leftover/corrupted modules from a previous (different) dependency set
  NEEDS_CLEAN_INSTALL=1
  NEEDS_INSTALL=1
elif ! [ -f node_modules/openai/pagination.mjs ]; then
  # Sanity check: openai package was previously not fully installed
  NEEDS_CLEAN_INSTALL=1
  NEEDS_INSTALL=1
fi

if [ "$NEEDS_CLEAN_INSTALL" = "1" ]; then
  log "package.json changed or modules corrupted — clean reinstall..."
  rm -rf node_modules
fi
if [ "$NEEDS_INSTALL" = "1" ]; then
  log "Installing dependencies (this may take a minute on first boot)..."
  # Use --include=dev so devDependencies (typescript, @types/*) are also installed.
  # NODE_ENV=production would otherwise skip them.
  npm install --include=dev --no-audit --no-fund 2>&1 | tail -5
  log "Dependencies installed."
else
  log "Dependencies up to date (node_modules present, package.json unchanged)."
fi

# Always ensure typescript is actually installed (not just listed in package.json).
# `npm ls typescript` returns 0 even when not installed, so check the binary directly.
if ! npx --no-install tsc --version >/dev/null 2>&1; then
  log "typescript binary not found, installing explicitly..."
  npm install --no-save --no-audit --no-fund typescript@^5.6.3 2>&1 | tail -3
fi
log "typescript is available: $(npx --no-install tsc --version 2>&1)"

# ─── Build TypeScript ──────────────────────────────────────────────────
log "Compiling TypeScript..."
npx tsc 2>&1 | tail -5 || {
  err "TypeScript compilation failed."
  exit 3
}
# Hard fail if dist/server.js doesn't exist (catches silent tsc stub issues)
if [ ! -f dist/server.js ]; then
  err "dist/server.js missing after tsc. typescript may not have actually compiled."
  err "Run 'npx tsc --version' to check."
  exit 3
fi
log "Build complete."

# ─── Start the server ─────────────────────────────────────────────────
log "Starting bot fleet server on port ${PORT}..."
log "DATA_DIR=${DATA_DIR}, NODE_ENV=${NODE_ENV}"
exec node dist/server.js
ENTRYPOINT_EOF

RUN chmod +x /entrypoint.sh && mkdir -p /data

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
