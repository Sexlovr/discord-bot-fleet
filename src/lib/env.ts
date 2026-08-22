// Centralized env var access — reads from process.env first, then falls back
// to compiled-in defaults so the z.ai preview deployment (which has no .env)
// can still function.
//
// ─── z.ai SANDBOX FILESYSTEM LAYOUT ──────────────────────────────────────────
// The z.ai sandbox has TWO filesystems:
//
//   /home/z/my-project/   — EPHEMERAL. Wiped on every sandbox restart / redeploy.
//                           Code is re-cloned from git here.
//
//   /tmp/my-project/      — PERSISTENT (PolarFS mount). Survives sandbox
//                           restarts. This is where z.ai stores real runtime
//                           state. (Confirmed via mount(8) + file mtimes.)
//
// If we put the DB at /home/z/my-project/db/custom.db, every time the sandbox
// restarts the DB is wiped (because the file doesn't exist in git anymore —
// we correctly gitignore'd it) and Prisma recreates an empty one. That's why
// bots kept disappearing: every code push → sandbox restart → DB wiped →
// "No bots found in DB".
//
// FIX: detect z.ai at runtime. If /tmp/my-project/db/custom.db exists OR
// can be created, use it. Otherwise fall back to the local dev path.
//
// SECURITY NOTE: defaults below are committed to git because z.ai preview has
// no secret-management UI. Acceptable for private bot fleet; for multi-tenant
// you'd inject via the platform's secret manager.

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// IMPORTANT: this MUST match the MASTER_KEY used to encrypt bot tokens.
// If they differ, decryptString() will throw on every bot start.
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kr36qWzV3xeyOsqDlMdJcQNl';
export const MASTER_KEY = process.env.MASTER_KEY || '127b4e60537c545a66f49cb307c5f3d8e56bc925398e885de72c2d98a5d3f181';
export const LLM_API_KEY = process.env.LLM_API_KEY || 'FAP!';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

// HF dataset repo config (for DB persistence across z.ai publish rebuilds)
// We use a DATASET REPO (not a Storage Bucket) because dataset repos support
// plain HTTP commit/upload API — no Python, no hf_xet Rust extension needed.
// This works in the z.ai publish container which doesn't have Python installed.
//
// Defaults are compiled-in so the z.ai publish container (which has no .env
// and no env var injection) can still push/pull from the dataset repo.
export const HF_TOKEN = process.env.HF_TOKEN || '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';
export const HF_DATASET_REPO = process.env.HF_DATASET_REPO || 'scsfvfsvs/bot-fleet-db';

// ─── Database path resolution ──────────────────────────────────────────────
// Priority:
//   1. /tmp/my-project/db/custom.db  (z.ai persistent PolarFS mount) — ALWAYS
//      preferred when z.ai is detected, even if process.env.DATABASE_URL is
//      set to something else (z.ai injects a wrong DATABASE_URL into the
//      shell env that points at the ephemeral /home/z/my-project/ path).
//   2. process.env.DATABASE_URL (explicit override — for tests / migrations
//      on local dev where /tmp/my-project doesn't exist)
//   3. /home/z/my-project/db/custom.db (local dev fallback)
//
// We also auto-create the parent directory if missing.

function resolveDatabaseUrl(): string {
  // 1. z.ai persistent storage — ALWAYS preferred when z.ai is detected.
  //    z.ai injects DATABASE_URL=file:/home/z/my-project/db/custom.db into
  //    the shell env (which points at the EPHEMERAL filesystem that gets
  //    wiped on every restart). We must override that.
  const ZAI_PERSISTENT_DB = '/tmp/my-project/db/custom.db';
  const ZAI_PERSISTENT_DIR = '/tmp/my-project/db';
  if (existsSync('/tmp/my-project')) {
    if (!existsSync(ZAI_PERSISTENT_DIR)) {
      try { mkdirSync(ZAI_PERSISTENT_DIR, { recursive: true }); } catch { /* ignore */ }
    }
    return `file:${ZAI_PERSISTENT_DB}`;
  }

  // 2. Explicit env override (local dev / CI)
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // 3. Local dev fallback
  const LOCAL_DIR = join(process.cwd(), 'db');
  if (!existsSync(LOCAL_DIR)) {
    try { mkdirSync(LOCAL_DIR, { recursive: true }); } catch { /* ignore */ }
  }
  return `file:${join(LOCAL_DIR, 'custom.db')}`;
}

export const DATABASE_URL = resolveDatabaseUrl();

// DATA_DIR is used by tools.ts for memory storage — point it at the same
// persistent location so memories survive sandbox restarts too.
export const DATA_DIR = existsSync('/tmp/my-project')
  ? '/tmp/my-project/db'
  : (process.env.DATA_DIR || join(process.cwd(), 'db'));
