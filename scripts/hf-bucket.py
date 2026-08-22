#!/usr/bin/env python3
"""
HF Storage Bucket helper for discord-bot-fleet.

Usage:
    python3 scripts/hf-bucket.py pull <local_path> <remote_key>
    python3 scripts/hf-bucket.py push <local_path> <remote_key>
    python3 scripts/hf-bucket.py list
    python3 scripts/hf-bucket.py delete <remote_key>
    python3 scripts/hf-bucket.py exists <remote_key>

Env vars:
    HF_TOKEN   — HF access token (required)
    HF_BUCKET  — bucket namespace/name (e.g. scsfvfsvs/discord-bot) (required)

Exit codes:
    0  success
    1  error (see stderr)
    2  file-not-found (for `pull` only — bucket doesn't have the key yet)
"""

import os
import sys
import json
import time

def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    token = os.environ.get('HF_TOKEN')
    bucket = os.environ.get('HF_BUCKET')

    if not token:
        print('HF_TOKEN env var is not set', file=sys.stderr)
        sys.exit(1)
    if not bucket:
        print('HF_BUCKET env var is not set', file=sys.stderr)
        sys.exit(1)

    # Import huggingface_hub lazily so the script starts fast
    try:
        from huggingface_hub import batch_bucket_files, list_bucket_tree, download_bucket_files
    except ImportError as e:
        print(f'huggingface_hub is not installed: {e}', file=sys.stderr)
        print('Run: pip install -U "huggingface_hub>=1.5.0" hf_xet', file=sys.stderr)
        sys.exit(1)

    os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')
    os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
    # Suppress the hf_xet verbose progress bars
    os.environ.setdefault('HF_HUB_VERBOSITY', 'error')
    # Also patch tqdm to be silent
    try:
        import tqdm
        def _silent_tqdm(*args, **kwargs):
            kwargs['disable'] = True
            return tqdm.tqdm(*args, **kwargs)
        import huggingface_hub
        if hasattr(huggingface_hub, 'utils') and hasattr(huggingface_hub.utils, '_tqdm'):
            huggingface_hub.utils._tqdm = _silent_tqdm
    except Exception:
        pass

    if cmd == 'pull':
        # pull <local_path> <remote_key>
        if len(sys.argv) != 4:
            print('Usage: pull <local_path> <remote_key>', file=sys.stderr)
            sys.exit(1)
        local_path = sys.argv[2]
        remote_key = sys.argv[3]

        # Check if remote file exists first (so we can return exit code 2 for missing)
        exists = False
        try:
            for f in list_bucket_tree(bucket, recursive=False):
                if f.path == remote_key:
                    exists = True
                    break
        except Exception as e:
            # list_bucket_tree may return [] for empty bucket — that's fine
            pass

        if not exists:
            print(f'remote file {remote_key} not found in bucket — starting fresh', file=sys.stderr)
            sys.exit(2)

        # Ensure local parent dir exists
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
        # push <local_path> <remote_key>
        if len(sys.argv) != 4:
            print('Usage: push <local_path> <remote_key>', file=sys.stderr)
            sys.exit(1)
        local_path = sys.argv[2]
        remote_key = sys.argv[3]

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
            files = []
            for f in list_bucket_tree(bucket, recursive=True):
                files.append({'path': f.path, 'size': f.size})
            print(json.dumps({'files': files}))
        except Exception as e:
            print(f'list failed: {e}', file=sys.stderr)
            sys.exit(1)

    elif cmd == 'delete':
        # delete <remote_key>
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
        # exists <remote_key>
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
            sys.exit(0)
        except Exception as e:
            print(f'exists check failed: {e}', file=sys.stderr)
            sys.exit(1)

    else:
        print(f'Unknown command: {cmd}', file=sys.stderr)
        print(__doc__, file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
