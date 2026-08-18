#!/usr/bin/env bash
# Bootstrap entrypoint — runs on every container start.
# Clones/pulls the source repo from GitHub using GIT_PAT, installs deps,
# compiles TypeScript, and starts the bot fleet server.

set -e

log() { echo "[entrypoint] $*"; }
err() { echo "[entrypoint] ERROR: $*" >&2; }

# ─── Validate env vars ────────────────────────────────────────────────────
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

# ─── Clone or pull ─────────────────────────────────────────────────────────
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

# ─── Install dependencies ─────────────────────────────────────────────────
log "Working directory: $REPO_DIR"

NEEDS_INSTALL=0
if [ ! -d node_modules ]; then
  NEEDS_INSTALL=1
elif [ ! -f node_modules/.package-lock.json ]; then
  NEEDS_INSTALL=1
elif [ package.json -nt node_modules/.package-lock.json ]; then
  NEEDS_INSTALL=1
fi

if [ "$NEEDS_INSTALL" = "1" ]; then
  log "Installing dependencies (this may take a minute on first boot)..."
  npm install --no-audit --no-fund 2>&1 | tail -5
  log "Dependencies installed."
else
  log "Dependencies up to date (node_modules present, package.json unchanged)."
fi

# ─── Build TypeScript ──────────────────────────────────────────────────────
log "Compiling TypeScript..."
npx tsc 2>&1 | tail -5 || {
  err "TypeScript compilation failed."
  exit 3
}
log "Build complete."

# ─── Start the server ─────────────────────────────────────────────────────
log "Starting bot fleet server on port ${PORT}..."
log "DATA_DIR=${DATA_DIR}, NODE_ENV=${NODE_ENV}"
exec node dist/server.js
