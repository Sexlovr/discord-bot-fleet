// Centralized env var access — reads from process.env first, then falls back
// to compiled-in defaults so the z.ai preview deployment (which has no .env)
// can still function.
//
// ─── z.ai FILESYSTEM LAYOUTS ─────────────────────────────────────────────────
//
// 1. z.ai SANDBOX (where the dev server runs):
//    /home/z/my-project/  — EPHEMERAL. Wiped on every sandbox restart.
//    /tmp/my-project/     — PERSISTENT (PolarFS mount). Survives restarts.
//                           → Use this for the DB.
//
// 2. z.ai PUBLISH CONTAINER (production deploy):
//    /app/db/              — READ-ONLY (build snapshot mounted read-only).
//    /tmp/bot-fleet-db/   — WRITABLE but EPHEMERAL (wiped on container restart).
//    /tmp/my-project/     — NOT MOUNTED (sandbox-only).
//                           → Use /tmp/bot-fleet-db/ + HF for persistence.
//
// 3. LOCAL DEV:
//    process.cwd()/db/    — Standard dev location.

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// IMPORTANT: this MUST match the MASTER_KEY used to encrypt bot tokens.
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kr36qWzV3xeyOsqDlMdJcQNl';
export const MASTER_KEY = process.env.MASTER_KEY || '127b4e60537c545a66f49cb307c5f3d8e56bc925398e885de72c2d98a5d3f181';
export const LLM_API_KEY = process.env.LLM_API_KEY || 'FAP!';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

// HF dataset repo config — used as backup persistence for the publish container.
// The sandbox uses /tmp/my-project/ (PolarFS) as primary; HF is secondary.
export const HF_TOKEN = process.env.HF_TOKEN || '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';
export const HF_DATASET_REPO = process.env.HF_DATASET_REPO || 'scsfvfsvs/bot-fleet-db';

// ─── Environment detection ────────────────────────────────────────────────

export function isSandbox(): boolean {
  return existsSync('/tmp/my-project');
}

export function isPublishContainer(): boolean {
  // Publish container markers:
  //   - /app/next-service-dist exists (the standalone build)
  //   - cwd includes 'next-service-dist'
  //   - no prisma/ dir in cwd (it's bundled, not source)
  return existsSync('/app/next-service-dist') ||
         process.cwd().includes('next-service-dist') ||
         !existsSync(join(process.cwd(), 'prisma'));
}

// ─── Database path resolution ──────────────────────────────────────────────

function resolveDatabaseUrl(): string {
  // 1. z.ai SANDBOX — use persistent PolarFS mount
  if (isSandbox()) {
    const DB = '/tmp/my-project/db/custom.db';
    const DIR = '/tmp/my-project/db';
    if (!existsSync(DIR)) {
      try { mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ }
    }
    console.log(`[env] sandbox detected → DATABASE_URL=file:${DB}`);
    return `file:${DB}`;
  }

  // 2. z.ai PUBLISH CONTAINER — /app/db is read-only, use /tmp instead
  if (isPublishContainer()) {
    const DB = '/tmp/bot-fleet-db/custom.db';
    const DIR = '/tmp/bot-fleet-db';
    if (!existsSync(DIR)) {
      try { mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ }
    }
    console.log(`[env] publish container detected → DATABASE_URL=file:${DB}`);
    return `file:${DB}`;
  }

  // 3. Local dev fallback
  const LOCAL_DIR = join(process.cwd(), 'db');
  if (!existsSync(LOCAL_DIR)) {
    try { mkdirSync(LOCAL_DIR, { recursive: true }); } catch { /* ignore */ }
  }
  console.log(`[env] local dev → DATABASE_URL=file:${join(LOCAL_DIR, 'custom.db')}`);
  return `file:${join(LOCAL_DIR, 'custom.db')}`;
}

export const DATABASE_URL = resolveDatabaseUrl();

// DATA_DIR — for logs + memory storage (tools.ts, logger.ts)
export const DATA_DIR = isSandbox()
  ? '/tmp/my-project/db'
  : (isPublishContainer()
    ? '/tmp/bot-fleet-db'
    : (process.env.DATA_DIR || join(process.cwd(), 'db')));
