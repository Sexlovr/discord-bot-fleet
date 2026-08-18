#!/usr/bin/env python3
"""Upload our Dockerfile + README.md to the HF Space using the commit API."""

import json
import os
import requests

HF_TOKEN = "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"
SPACE_ID = "rhbstntsmnde/ernie"
REPO_TYPE = "space"
BASE = f"https://huggingface.co/api/{REPO_TYPE}s/{SPACE_ID}"

def upload_via_commit(files_to_upload, files_to_delete=None):
    """Use the commit API to upload multiple files atomically.
    files_to_upload: list of (local_path, remote_path)
    files_to_delete: list of remote_path strings
    """
    operations = []
    for local_path, remote_path in files_to_upload:
        with open(local_path, "rb") as f:
            content = f.read()
        operations.append({
            "path": remote_path,
            "action": "update",
            "content": content.decode("utf-8", errors="replace"),
        })
    for remote_path in (files_to_delete or []):
        operations.append({"path": remote_path, "action": "delete"})

    url = f"{BASE}/commit/main"
    headers = {"Authorization": f"Bearer {HF_TOKEN}", "Content-Type": "application/json"}
    payload = {
        "summary": "Bootstrap deploy: Discord Bot Fleet",
        "files": operations,
    }
    print(f"  Committing {len(operations)} operations...")
    r = requests.post(url, headers=headers, json=payload, timeout=120)
    if r.status_code != 200:
        print(f"  ERROR: HTTP {r.status_code}: {r.text[:500]}")
        return False
    print(f"  OK: commit succeeded")
    return True

def list_files():
    url = f"{BASE}/tree/main"
    headers = {"Authorization": f"Bearer {HF_TOKEN}"}
    r = requests.get(url, headers=headers, timeout=30)
    return r.json() if r.status_code == 200 else []

print("=== Current files in HF Space ===")
files = list_files()
for f in files:
    print(f"  {f.get('type', '?'):>6}  {f.get('path', '?')}  ({f.get('size', '?')} bytes)")

print("\n=== Uploading via commit API ===")
ok = upload_via_commit([
    ("/home/z/my-project/discord-bot-fleet/huggingface/Dockerfile", "Dockerfile"),
    ("/home/z/my-project/discord-bot-fleet/huggingface/README.md", "README.md"),
])

print("\n=== Final file listing ===")
files = list_files()
for f in files:
    print(f"  {f.get('type', '?'):>6}  {f.get('path', '?')}  ({f.get('size', '?')} bytes)")
