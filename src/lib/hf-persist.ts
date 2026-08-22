// HF Storage Bucket persistence layer for discord-bot-fleet.
//
// Treats HuggingFace Storage Bucket (Xet-backed) as the source of truth for
// the SQLite DB. Pattern:
//   - On app startup: pull custom.db from HF → write to local disk.
//     (If HF doesn't have it yet, start with empty DB.)
//   - After every Prisma write: schedule a debounced push of local custom.db
//     back to HF (3s delay, deduped by SHA-256 of file contents).
//   - On SIGTERM/SIGINT: flush a final push so no writes are lost on shutdown.
//
// The actual upload/download is done by shelling out to scripts/hf-bucket.py
// which uses the official `huggingface_hub` Python library (the only official
// HF SDK that supports bucket uploads via Xet storage).
//
// Configuration (via env.ts):
//   HF_TOKEN   — HF access token with repo.write on the bucket
//   HF_BUCKET  — bucket namespace/name (e.g. "scsfvfsvs/discord-bot")
//
// If HF_TOKEN or HF_BUCKET is not set, this module becomes a no-op (no
// persistence — useful for local dev where you don't want to push to HF).

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { ADMIN_PASSWORD, MASTER_KEY, LLM_API_KEY, DATABASE_URL, DATA_DIR } from './env';

// Re-export env vars for backwards compatibility with other modules
export { ADMIN_PASSWORD, MASTER_KEY, LLM_API_KEY, DATABASE_URL, DATA_DIR };

// HF bucket config
const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_BUCKET = process.env.HF_BUCKET || '';
const REMOTE_DB_KEY = 'custom.db';

// Resolve local DB path from DATABASE_URL (strip the "file:" prefix)
function localDbPath(): string {
  const url = DATABASE_URL;
  if (url.startsWith('file:')) return url.slice(5);
  return url;
}

// Detect if HF persistence is enabled
export function isHfPersistEnabled(): boolean {
  return !!(HF_TOKEN && HF_BUCKET);
}

// ─── Python helper invocation ─────────────────────────────────────────────

function runPython(cmd: string, args: string[] = [], timeoutMs = 60000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const scriptPath = join(process.cwd(), 'scripts', 'hf-bucket.py');
    const env = {
      ...process.env,
      HF_TOKEN,
      HF_BUCKET,
      HF_HUB_DISABLE_PROGRESS_BARS: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
    };
    const child = spawn('python3', [scriptPath, cmd, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => resolve({ stdout, stderr: stderr + e.message, exitCode: -1 }));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

// ─── Pull (download from HF to local disk) ────────────────────────────────

export async function pullDbFromHf(): Promise<{ ok: boolean; bytes: number; fresh: boolean }> {
  if (!isHfPersistEnabled()) {
    console.log('[hf-persist] disabled — HF_TOKEN or HF_BUCKET not set');
    return { ok: false, bytes: 0, fresh: false };
  }

  const localPath = localDbPath();
  console.log(`[hf-persist] pulling ${REMOTE_DB_KEY} from bucket ${HF_BUCKET} → ${localPath}`);

  // Ensure local parent dir exists
  const dir = dirname(localPath);
  if (dir && !existsSync(dir)) {
    try { await mkdir(dir, { recursive: true }); } catch { /* ignore */ }
  }

  const result = await runPython('pull', [localPath, REMOTE_DB_KEY], 60000);
  if (result.exitCode === 2) {
    // Remote file doesn't exist — start fresh
    console.log('[hf-persist] remote DB not found in bucket — will start fresh and push on first write');
    return { ok: true, bytes: 0, fresh: true };
  }
  if (result.exitCode !== 0) {
    console.error('[hf-persist] pull failed:', result.stderr.slice(-300));
    return { ok: false, bytes: 0, fresh: false };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    console.log(`[hf-persist] pulled ${parsed.bytes} bytes`);
    // Update lastHash so we don't immediately re-push the same data
    const buf = await readFile(localPath);
    lastPushedHash = sha256(buf);
    return { ok: true, bytes: parsed.bytes, fresh: false };
  } catch (e) {
    console.error('[hf-persist] pull parse error:', (e as Error).message, 'stdout:', result.stdout.slice(0, 200));
    return { ok: false, bytes: 0, fresh: false };
  }
}

// ─── Push (upload local DB to HF) ─────────────────────────────────────────

let lastPushedHash = '';
let pendingPush: Promise<void> | null = null;
let pushDebounceTimer: NodeJS.Timeout | null = null;
let isShuttingDown = false;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function pushDbToHf(): Promise<void> {
  if (!isHfPersistEnabled()) return;
  if (isShuttingDown) return; // shutdown flush is synchronous

  const localPath = localDbPath();
  let buf: Buffer;
  try {
    buf = await readFile(localPath);
  } catch (e) {
    console.error('[hf-persist] push: cannot read local DB:', (e as Error).message);
    return;
  }

  // Dedup: skip if file content unchanged since last push
  const currentHash = sha256(buf);
  if (currentHash === lastPushedHash) {
    return;
  }

  console.log(`[hf-persist] pushing ${buf.length} bytes to bucket (hash ${currentHash.slice(0, 12)})`);
  const result = await runPython('push', [localPath, REMOTE_DB_KEY], 120000);
  if (result.exitCode === 0) {
    lastPushedHash = currentHash;
    console.log(`[hf-persist] pushed ${buf.length} bytes`);
  } else {
    console.error('[hf-persist] push failed:', result.stderr.slice(-300));
  }
}

// Serialize pushes — never run two at once
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
  // Wait for any in-flight push, then do one final push
  if (pendingPush) {
    try { await pendingPush; } catch { /* ignore */ }
  }
  await pushDbToHf();
}

// ─── Public API: listRemoteFiles (for debugging / health check) ──────────

export async function listRemoteFiles(): Promise<Array<{ path: string; size: number }>> {
  if (!isHfPersistEnabled()) return [];
  const result = await runPython('list', [], 15000);
  if (result.exitCode !== 0) {
    console.error('[hf-persist] list failed:', result.stderr.slice(-300));
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return parsed.files || [];
  } catch {
    return [];
  }
}
