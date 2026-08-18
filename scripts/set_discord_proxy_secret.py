#!/usr/bin/env python3
"""Add DISCORD_PROXY_URL HF Secret with both Cloudflare Workers."""

import json
import requests

HF_TOKEN = "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"
SPACE_ID = "rhbstntsmnde/ernie"
BASE = f"https://huggingface.co/api/spaces/{SPACE_ID}"

PROXY_VALUE = "https://vertex-proxy-worker.damnitbruhhh.workers.dev,https://vertex-proxy-worker.damnitbruhhh19.workers.dev"

print(f"=== Setting DISCORD_PROXY_URL secret ===")
print(f"  Value: {PROXY_VALUE}")
r = requests.post(
    f"{BASE}/secrets",
    headers={"Authorization": f"Bearer {HF_TOKEN}", "Content-Type": "application/json"},
    json={"key": "DISCORD_PROXY_URL", "value": PROXY_VALUE},
    timeout=30,
)
print(f"  HTTP {r.status_code}: {r.text[:200]}")

print("\n=== Current secrets ===")
r = requests.get(f"{BASE}/secrets", headers={"Authorization": f"Bearer {HF_TOKEN}"}, timeout=30)
print(json.dumps(r.json(), indent=2) if r.status_code == 200 else r.text[:300])
