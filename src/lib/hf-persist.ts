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
// The actual upload/download is done by shelling out to a Python script
// (embedded below) that uses the official `huggingface_hub` library (the
// only official HF SDK that supports bucket uploads via Xet storage).
//
// Configuration (via env.ts):
//   HF_TOKEN   — HF access token with repo.write on the bucket
//   HF_BUCKET  — bucket namespace/name (e.g. "scsfvfsvs/discord-bot")
//
// If HF_TOKEN or HF_BUCKET is not set, this module becomes a no-op.

import { spawn, execSync } from 'child_process';
import { createHash } from 'crypto';
import { readFile, writeFile, mkdir, access, mkdtemp, writeFile as writeFileAsync } from 'fs/promises';
import { existsSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { ADMIN_PASSWORD, MASTER_KEY, LLM_API_KEY, DATABASE_URL, DATA_DIR, HF_TOKEN, HF_BUCKET } from './env';

// Re-export env vars for backwards compatibility with other modules
export { ADMIN_PASSWORD, MASTER_KEY, LLM_API_KEY, DATABASE_URL, DATA_DIR, HF_TOKEN, HF_BUCKET };

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

// ─── Embedded Python script ────────────────────────────────────────────────
// The script is embedded as a string so it's always available — even in the
// z.ai publish container where the scripts/ folder isn't copied.
const HF_BUCKET_PY = `#!/usr/bin/env python3
"""HF Storage Bucket helper for discord-bot-fleet."""
import os, sys, json
def main():
    if len(sys.argv) < 2:
        print('Usage: hf-bucket.py <pull|push|list|delete|exists> [args]', file=sys.stderr)
        sys.exit(1)
    cmd = sys.argv[1]
    token = os.environ.get('HF_TOKEN')
    bucket = os.environ.get('HF_BUCKET')
    if not token or not bucket:
        print('HF_TOKEN or HF_BUCKET not set', file=sys.stderr)
        sys.exit(1)
    try:
        from huggingface_hub import batch_bucket_files, list_bucket_tree, download_bucket_files
    except ImportError as e:
        print(f'huggingface_hub not installed: {e}', file=sys.stderr)
        sys.exit(1)
    os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
    os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
    os.environ.setdefault('HF_HUB_VERBOSITY', 'error')
    try:
        import tqdm, huggingface_hub
        def _silent(*a, **kw):
            kw['disable'] = True
            return tqdm.tqdm(*a, **kw)
        if hasattr(huggingface_hub, 'utils') and hasattr(huggingface_hub.utils, '_tqdm'):
            huggingface_hub.utils._tqdm = _silent
    except Exception:
        pass
    if cmd == 'pull':
        if len(sys.argv) != 4:
            print('Usage: pull <local_path> <remote_key>', file=sys.stderr)
            sys.exit(1)
        local_path, remote_key = sys.argv[2], sys.argv[3]
        exists = False
        try:
            for f in list_bucket_tree(bucket, recursive=False):
                if f.path == remote_key:
                    exists = True
                    break
        except Exception:
            pass
        if not exists:
            print(f'remote file {remote_key} not found in bucket — starting fresh', file=sys.stderr)
            sys.exit(2)
        local_dir = os.path.dirname(local_path)
        if local_dir and not os.path.exists(local_dir):
            os.makedirs(local_dir, exist_ok=True)
        try:
            download_bucket_files(bucket, files=[(remote_key, local_path)])
            size = os.path.getsize(local_path)
            print(json.dumps({'ok': True, 'bytes': size, 'path': local_path}))
        except Exception as e:
            print(f'download failed: {e}', file=sys.stderr)
            sys.exit(1)
    elif cmd == 'push':
        if len(sys.argv) != 4:
            print('Usage: push <local_path> <remote_key>', file=sys.stderr)
            sys.exit(1)
        local_path, remote_key = sys.argv[2], sys.argv[3]
        if not os.path.exists(local_path):
            print(f'local file {local_path} does not exist', file=sys.stderr)
            sys.exit(1)
        size = os.path.getsize(local_path)
        try:
            batch_bucket_files(bucket, add=[(local_path, remote_key)])
            print(json.dumps({'ok': True, 'bytes': size, 'remote_key': remote_key}))
        except Exception as e:
            print(f'upload failed: {e}', file=sys.stderr)
            sys.exit(1)
    elif cmd == 'list':
        try:
            files = [{'path': f.path, 'size': f.size} for f in list_bucket_tree(bucket, recursive=True)]
            print(json.dumps({'files': files}))
        except Exception as e:
            print(f'list failed: {e}', file=sys.stderr)
            sys.exit(1)
    elif cmd == 'delete':
        if len(sys.argv) != 3:
            print('Usage: delete <remote_key>', file=sys.stderr)
            sys.exit(1)
        remote_key = sys.argv[2]
        try:
            batch_bucket_files(bucket, delete=[remote_key])
            print(json.dumps({'ok': True, 'deleted': remote_key}))
        except Exception as e:
            print(f'delete failed: {e}', file=sys.stderr)
            sys.exit(1)
    elif cmd == 'exists':
        if len(sys.argv) != 3:
            print('Usage: exists <remote_key>', file=sys.stderr)
            sys.exit(1)
        remote_key = sys.argv[2]
        try:
            for f in list_bucket_tree(bucket, recursive=False):
                if f.path == remote_key:
                    print(json.dumps({'exists': True, 'size': f.size}))
                    sys.exit(0)
            print(json.dumps({'exists': False}))
        except Exception as e:
            print(f'exists check failed: {e}', file=sys.stderr)
            sys.exit(1)
    else:
        print(f'Unknown command: {cmd}', file=sys.stderr)
        sys.exit(1)
if __name__ == '__main__':
    main()
`;

// Write the embedded Python script to a temp file at runtime so we can
// invoke it. This avoids the need for scripts/ to be copied into the
// z.ai publish container's standalone build.
let _pyScriptPath: string | null = null;
async function getPyScriptPath(): Promise<string> {
  if (_pyScriptPath && existsSync(_pyScriptPath)) return _pyScriptPath;
  // Try scripts/hf-bucket.py first (dev mode)
  const devPath = join(process.cwd(), 'scripts', 'hf-bucket.py');
  if (existsSync(devPath)) {
    _pyScriptPath = devPath;
    return devPath;
  }
  // Fall back to a temp file (publish container)
  const tmpDir = await mkdtemp(join(tmpdir(), 'hf-bucket-'));
  _pyScriptPath = join(tmpDir, 'hf-bucket.py');
  await writeFileAsync(_pyScriptPath, HF_BUCKET_PY, { mode: 0o755 });
  return _pyScriptPath;
}

// ─── Python binary discovery ────────────────────────────────────────────────
function findPythonBinary(): string | null {
  const candidates = [
    'python3',
    '/usr/bin/python3',
    '/usr/local/bin/python3',
    '/app/python-runtime/bin/python',
    '/app/python-runtime/bin/python3',
    'python',
  ];
  for (const c of candidates) {
    try {
      execSync(`${c} --version`, { stdio: 'ignore', timeout: 3000 });
      return c;
    } catch { /* try next */ }
  }
  return null;
}

const PYTHON_BIN = findPythonBinary();

// ─── Python helper invocation ─────────────────────────────────────────────

function runPython(scriptPath: string, cmd: string, args: string[] = [], timeoutMs = 60000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    if (!PYTHON_BIN) {
      resolve({ stdout: '', stderr: 'no python3 binary found in PATH', exitCode: -1 });
      return;
    }
    const env = {
      ...process.env,
      HF_TOKEN,
      HF_BUCKET,
      HF_HUB_DISABLE_PROGRESS_BARS: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
    };
    const child = spawn(PYTHON_BIN, [scriptPath, cmd, ...args], {
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
  console.log(`[hf-persist] pulling ${REMOTE_DB_KEY} from bucket ${HF_BUCKET} → ${localPath} (python: ${PYTHON_BIN})`);

  const dir = dirname(localPath);
  if (dir && !existsSync(dir)) {
    try { await mkdir(dir, { recursive: true }); } catch { /* ignore */ }
  }

  const scriptPath = await getPyScriptPath();
  const result = await runPython(scriptPath, 'pull', [localPath, REMOTE_DB_KEY], 60000);
  if (result.exitCode === 2) {
    console.log('[hf-persist] remote DB not found in bucket — will start fresh and push on first write');
    return { ok: true, bytes: 0, fresh: true };
  }
  if (result.exitCode !== 0) {
    console.error('[hf-persist] pull failed:', result.stderr.slice(-500));
    return { ok: false, bytes: 0, fresh: false };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    console.log(`[hf-persist] pulled ${parsed.bytes} bytes`);
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
  if (isShuttingDown) return;

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
    return;
  }

  console.log(`[hf-persist] pushing ${buf.length} bytes to bucket (hash ${currentHash.slice(0, 12)})`);
  const scriptPath = await getPyScriptPath();
  const result = await runPython(scriptPath, 'push', [localPath, REMOTE_DB_KEY], 120000);
  if (result.exitCode === 0) {
    lastPushedHash = currentHash;
    console.log(`[hf-persist] pushed ${buf.length} bytes`);
  } else {
    console.error('[hf-persist] push failed:', result.stderr.slice(-500));
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

// ─── Public API: listRemoteFiles (for debugging / health check) ──────────

export async function listRemoteFiles(): Promise<Array<{ path: string; size: number }>> {
  if (!isHfPersistEnabled()) return [];
  const scriptPath = await getPyScriptPath();
  const result = await runPython(scriptPath, 'list', [], 15000);
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
