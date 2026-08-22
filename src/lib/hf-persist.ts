// HF dataset-repo persistence layer for discord-bot-fleet.
//
// Treats a HuggingFace DATASET repo (NOT a Storage Bucket — buckets require
// the hf_xet Rust extension which is Python-only) as the source of truth for
// the SQLite DB. Pure HTTP — no Python, no hf_xet, works in the z.ai publish
// container which doesn't have Python.
//
// Pattern:
//   - On app startup: pull custom.db from HF dataset repo → write to local disk.
//     (If HF doesn't have it yet, start with empty DB.)
//   - After every Prisma write: schedule a debounced push of local custom.db
//     back to HF (3s delay, deduped by SHA-256 of file contents).
//   - On SIGTERM/SIGINT: flush a final push so no writes are lost on shutdown.
//
// Configuration (via env.ts):
//   HF_TOKEN   — HF access token with write access to the dataset repo
//   HF_DATASET_REPO — dataset repo name (e.g. "scsfvfsvs/bot-fleet-db")
//
// If HF_TOKEN or HF_DATASET_REPO is not set, this module becomes a no-op.

import { createHash } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { ADMIN_PASSWORD, MASTER_KEY, LLM_API_KEY, DATABASE_URL, DATA_DIR, HF_TOKEN, HF_DATASET_REPO } from './env';

// Re-export env vars for backwards compatibility with other modules
export { ADMIN_PASSWORD, MASTER_KEY, LLM_API_KEY, DATABASE_URL, DATA_DIR, HF_TOKEN, HF_DATASET_REPO };

const REMOTE_DB_KEY = 'custom.db';
const HF_ENDPOINT = 'https://huggingface.co';

// Resolve local DB path from DATABASE_URL (strip the "file:" prefix)
function localDbPath(): string {
  const url = DATABASE_URL;
  if (url.startsWith('file:')) return url.slice(5);
  return url;
}

// Detect if HF persistence is enabled
export function isHfPersistEnabled(): boolean {
  return !!(HF_TOKEN && HF_DATASET_REPO);
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async function hfFetch(path: string, init: RequestInit = {}, timeoutMs = 60000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${HF_ENDPOINT}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Pull (download from HF to local disk) ────────────────────────────────

export async function pullDbFromHf(): Promise<{ ok: boolean; bytes: number; fresh: boolean }> {
  if (!isHfPersistEnabled()) {
    console.log('[hf-persist] disabled — HF_TOKEN or HF_DATASET_REPO not set');
    return { ok: false, bytes: 0, fresh: false };
  }

  const localPath = localDbPath();
  console.log(`[hf-persist] pulling ${REMOTE_DB_KEY} from dataset ${HF_DATASET_REPO} → ${localPath}`);

  const dir = dirname(localPath);
  if (dir && !existsSync(dir)) {
    try { await mkdir(dir, { recursive: true }); } catch { /* ignore */ }
  }

  // First, list files in the repo to check if custom.db exists
  let fileExists = false;
  try {
    const resp = await hfFetch(`/api/datasets/${HF_DATASET_REPO}/tree/main`, {}, 15000);
    if (resp.ok) {
      const files = await resp.json() as Array<{ path: string; size: number }>;
      fileExists = files.some(f => f.path === REMOTE_DB_KEY);
    }
  } catch (e) {
    console.warn('[hf-persist] list failed (continuing):', (e as Error).message);
  }

  if (!fileExists) {
    console.log('[hf-persist] remote DB not found in dataset repo — will start fresh and push on first write');
    return { ok: true, bytes: 0, fresh: true };
  }

  // Download the file via /resolve endpoint (follows redirect to CDN)
  try {
    const resp = await hfFetch(`/datasets/${HF_DATASET_REPO}/resolve/main/${REMOTE_DB_KEY}`, {}, 60000);
    if (!resp.ok) {
      console.error(`[hf-persist] download HTTP ${resp.status}: ${await resp.text().catch(() => '').slice(0, 200)}`);
      return { ok: false, bytes: 0, fresh: false };
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    // CRITICAL: don't overwrite local DB with an empty remote file.
    // This can happen if the dataset repo has a stale empty custom.db
    // (e.g., from a previous delete operation that left an empty file).
    if (buf.length === 0) {
      console.log('[hf-persist] remote file is 0 bytes — treating as fresh start');
      return { ok: true, bytes: 0, fresh: true };
    }
    await writeFile(localPath, buf);
    lastPushedHash = sha256(buf);
    console.log(`[hf-persist] pulled ${buf.length} bytes`);
    return { ok: true, bytes: buf.length, fresh: false };
  } catch (e) {
    console.error('[hf-persist] pull failed:', (e as Error).message);
    return { ok: false, bytes: 0, fresh: false };
  }
}

// ─── Push (upload local DB to HF via commit API) ───────────────────────────

let lastPushedHash = '';
let pendingPush: Promise<void> | null = null;
let pushDebounceTimer: NodeJS.Timeout | null = null;
let isShuttingDown = false;
// CRITICAL: don't push until we've successfully pulled at least once.
// This prevents the bug where the publish container starts with an empty
// local DB and immediately pushes it to HF, wiping the bucket.
let pullCompleted = false;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function pushDbToHf(): Promise<void> {
  if (!isHfPersistEnabled()) return;
  if (isShuttingDown) return;
  if (!pullCompleted) {
    console.warn('[hf-persist] push skipped — pull not yet completed (would wipe remote)');
    return;
  }

  const localPath = localDbPath();
  let buf: Buffer;
  try {
    buf = await readFile(localPath);
  } catch (e) {
    console.error('[hf-persist] push: cannot read local DB:', (e as Error).message);
    return;
  }

  const currentHash = sha256(buf);
  if (currentHash === lastPushedHash) {
    return; // no-op, file unchanged
  }

  console.log(`[hf-persist] pushing ${buf.length} bytes to dataset (hash ${currentHash.slice(0, 12)})`);
  const b64 = buf.toString('base64');
  const body = JSON.stringify({
    summary: `DB snapshot ${new Date().toISOString()}`,
    files: [{ path: REMOTE_DB_KEY, content: b64, encoding: 'base64' }],
  });

  try {
    const resp = await hfFetch(`/api/datasets/${HF_DATASET_REPO}/commit/main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, 120000);
    if (resp.ok) {
      lastPushedHash = currentHash;
      console.log(`[hf-persist] pushed ${buf.length} bytes`);
    } else {
      const text = await resp.text().catch(() => '');
      console.error(`[hf-persist] push HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
  } catch (e) {
    console.error('[hf-persist] push failed:', (e as Error).message);
  }
}

async function serializedPush(): Promise<void> {
  if (pendingPush) return pendingPush;
  pendingPush = pushDbToHf().finally(() => { pendingPush = null; });
  return pendingPush;
}

// ─── Public API: schedulePush ─────────────────────────────────────────────

const PUSH_DEBOUNCE_MS = 3000;

export function schedulePush(delayMs: number = PUSH_DEBOUNCE_MS): void {
  if (!isHfPersistEnabled()) return;
  if (isShuttingDown) return;
  if (!pullCompleted) return; // don't schedule pushes until pull is done
  if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
  pushDebounceTimer = setTimeout(() => {
    pushDebounceTimer = null;
    serializedPush().catch((e) => console.error('[hf-persist] scheduled push error:', e));
  }, delayMs);
}

// ─── Public API: flushNow (for SIGTERM) ────────────────────────────────────

export async function flushNow(): Promise<void> {
  if (!isHfPersistEnabled()) return;
  isShuttingDown = true;
  if (pushDebounceTimer) {
    clearTimeout(pushDebounceTimer);
    pushDebounceTimer = null;
  }
  if (pendingPush) {
    try { await pendingPush; } catch { /* ignore */ }
  }
  await pushDbToHf();
}

// ─── Public API: markPullCompleted ────────────────────────────────────────
// Called by instrumentation.ts after a successful pull (or fresh-start
// detection). Without this, schedulePush() is a no-op.

export function markPullCompleted(): void {
  pullCompleted = true;
  console.log('[hf-persist] pull marked complete — pushes are now enabled');
}

// ─── Public API: listRemoteFiles (for debugging / health check) ──────────

export async function listRemoteFiles(): Promise<Array<{ path: string; size: number }>> {
  if (!isHfPersistEnabled()) return [];
  try {
    const resp = await hfFetch(`/api/datasets/${HF_DATASET_REPO}/tree/main`, {}, 15000);
    if (!resp.ok) return [];
    const files = await resp.json() as Array<{ path: string; size: number }>;
    return files;
  } catch {
    return [];
  }
}
