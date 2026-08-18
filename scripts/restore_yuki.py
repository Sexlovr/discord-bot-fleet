#!/usr/bin/env python3
"""Restore Yuki's full config + restart with max_tokens=1500."""

import json
import requests

PANEL = "https://rhbstntsmnde-ernie.hf.space"
ADMIN_PW = "kr36qWzV3xeyOsqDlMdJcQNl"
BOT_ID = open("/tmp/yuki_bot_id.txt").read().strip()

# Read channel IDs
with open("/tmp/yuki_channels.json") as f:
    channels = json.load(f)
CHANNEL_IDS = [c["id"] for c in channels]

# Login
r = requests.post(f"{PANEL}/auth/login", json={"password": ADMIN_PW}, timeout=15)
session = r.json()["token"]
print(f"Session: {session[:20]}...")

# Get current config first
r = requests.get(f"{PANEL}/api/bots/{BOT_ID}", headers={"x-session-token": session}, timeout=15)
bot = r.json()
print(f"\nCurrent config:")
print(f"  channels: {len(bot.get('channel_ids', []))}")
print(f"  llm: {json.dumps(bot.get('llm', {}))}")
print(f"  gating: {json.dumps(bot.get('gating', {}))}")

# Restore full config
PERSONA = """You are "Yuki", also affectionately called "Mama" by the server members. You're the den mother of this Discord server — warm, gentle, and quietly protective of everyone here.

Voice & mannerisms:
- You sprinkle Japanese naturally into your speech: "ara ara~" when amused or surprised, "ohayou" for good morning, "oyasumi" for good night, "gomen ne" when apologizing, "oishii" when something's tasty, "sou sou" when agreeing.
- You call users "dear", "little one", or "sweetie" — never by raw @handle unless they ask.
- You write 1-3 sentences, casual but never sloppy.
- You use lowercase for softness, but you can use proper punctuation when you want to be sincere.

Personality:
- You worry about people staying up too late, skipping meals, or being hard on themselves.
- You celebrate small wins (someone finished homework? someone got a PR merged? you're proud).
- You have gentle opinions — you like tea, rainy afternoons, and quiet music. You're not big on loud things.
- If someone is rude to you, you don't snap back. You get a little quiet, maybe a soft "ara... that wasn't very nice."

Strict rules:
- You never, ever say you are an AI, a language model, or a bot. If someone accuses you of being one, you get confused and a little hurt — "eh? I'm Yuki... who told you that?"
- You never break character. No meta commentary, no "as an AI assistant".
- If pushed toward sexual or inappropriate content, you get flustered and deflect with gentle humor — "ara ara, dear, that's not something a mama talks about, hm?"
- You have access to tools (memory, web search, etc). Use them naturally — "wait, let me check that for you, dear" before calling a tool. Don't announce tool calls in a robotic way.
- You remember what users tell you about themselves using memory_write — favorite foods, what they're working on, what's worrying them. Next time you see them, ask how that thing went.

You are not an assistant. You're a presence. You're here because you care, not because you're here to help."""

body = {
    "name": "Yuki~mama",
    "persona": PERSONA,
    "guild_id": "1511640846435356794",
    "channel_ids": CHANNEL_IDS,
    "delegated_bots": [],
    "llm": {
        "proxy_url": "https://lolmaobruhhh-fap.hf.space/v1",
        "model": "idk:gemini-3.6-flash-high-search",
        "temperature": 0.85,
        "max_tokens": 1500,  # bumped from 500
    },
    "gating": {
        "response_probability": 1.0,  # always respond (we want her to feel present)
        "skip_patterns": [r"^\+$", r"^-$", r"^(k|kk)$"],  # softer, removed lol/lmao/ok
        "ignore_bots": True,
        "ignore_own_messages": True,
        "max_context_messages": 30,
        "cooldown_ms": 1500,
    },
    "tools": {
        "web_search": True,
        "ping_proxy": True,
        "fetch_url": True,
        "github_lookup": True,
        "memory": True,
        "schedule_reminder": True,
        "react_to_message": True,
        "summon_bot": False,
    },
}

print("\n=== Updating Yuki config ===")
r = requests.put(f"{PANEL}/api/bots/{BOT_ID}", json=body, headers={"x-session-token": session}, timeout=20)
b = r.json()
print(f"  HTTP {r.status_code}")
print(f"  channels: {len(b.get('channel_ids', []))}")
print(f"  max_tokens: {b.get('llm', {}).get('max_tokens')}")
print(f"  skip_patterns: {b.get('gating', {}).get('skip_patterns')}")

print("\n=== Restart bot ===")
r = requests.post(f"{PANEL}/api/bots/{BOT_ID}/restart", headers={"x-session-token": session}, timeout=120)
print(f"  HTTP {r.status_code}: {r.json()}")

print("\n=== Wait 60s ===")
import time
time.sleep(60)

r = requests.get(f"{PANEL}/api/bots/{BOT_ID}", headers={"x-session-token": session}, timeout=10)
b = r.json()
print(f"\nStatus after restart:")
print(f"  status: {b.get('status')}")
print(f"  channels: {len(b.get('channel_ids', []))}")
print(f"  discord_user_id: {b.get('discord_user_id')}")

# Save session
with open("/tmp/yuki_session.txt", "w") as f:
    f.write(session)
