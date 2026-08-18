#!/usr/bin/env python3
"""Set HF Space secrets + variables for the bot fleet."""

import requests
import sys

HF_TOKEN = "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"
SPACE_ID = "rhbstntsmnde/ernie"
BASE = f"https://huggingface.co/api/spaces/{SPACE_ID}"

# Read generated credentials
with open("/tmp/.admin_pw") as f:
    ADMIN_PASSWORD = f.read().strip()
with open("/tmp/.master_key") as f:
    MASTER_KEY = f.read().strip()

# Load values to set
SECRETS = {
    "GIT_PAT": "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",
    "ADMIN_PASSWORD": ADMIN_PASSWORD,
    "MASTER_KEY": MASTER_KEY,
    # Optional: default LLM API key (in case bot has none configured)
    "LLM_API_KEY": "FAP!",
}

VARIABLES = {
    "REPO_URL": "https://github.com/Sexlovr/discord-bot-fleet",
    "REPO_BRANCH": "main",
}

def set_secret(key: str, value: str):
    """POST /api/spaces/{id}/secrets — upserts."""
    url = f"{BASE}/secrets"
    headers = {"Authorization": f"Bearer {HF_TOKEN}", "Content-Type": "application/json"}
    payload = {"key": key, "value": value}
    r = requests.post(url, headers=headers, json=payload, timeout=30)
    return r.status_code, r.text[:200]

def set_variable(key: str, value: str):
    url = f"{BASE}/variables"
    headers = {"Authorization": f"Bearer {HF_TOKEN}", "Content-Type": "application/json"}
    payload = {"key": key, "value": value}
    r = requests.post(url, headers=headers, json=payload, timeout=30)
    return r.status_code, r.text[:200]

def list_secrets():
    """Returns list of {key} (value is never exposed by HF API)."""
    url = f"{BASE}/secrets"
    headers = {"Authorization": f"Bearer {HF_TOKEN}"}
    r = requests.get(url, headers=headers, timeout=30)
    return r.json() if r.status_code == 200 else []

def list_variables():
    """Returns list of {key, value}."""
    url = f"{BASE}/variables"
    headers = {"Authorization": f"Bearer {HF_TOKEN}"}
    r = requests.get(url, headers=headers, timeout=30)
    return r.json() if r.status_code == 200 else []

print("=== Setting Secrets ===")
for k, v in SECRETS.items():
    code, body = set_secret(k, v)
    masked = v[:4] + "***" if len(v) > 4 else "***"
    print(f"  {k}={masked}: HTTP {code} {'OK' if code in (200, 201) else body}")

print("\n=== Setting Variables ===")
for k, v in VARIABLES.items():
    code, body = set_variable(k, v)
    print(f"  {k}={v}: HTTP {code} {'OK' if code in (200, 201) else body}")

print("\n=== Verify Secrets (keys only, values never exposed) ===")
secrets = list_secrets()
print(f"  Secrets set: {[s.get('key') for s in (secrets or [])]}")

print("\n=== Verify Variables ===")
variables = list_variables()
for v in (variables or []):
    print(f"  {v.get('key')}={v.get('value')}")
