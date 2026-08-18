#!/usr/bin/env python3
"""Create Yuki bot on the z.ai Next.js bot fleet."""
import json
import requests

PANEL = "http://localhost:3000"
ADMIN_PW = "kr36qWzV3xeyOsqDlMdJcQNl"

# Read channel IDs from the old /tmp file (still exists)
with open("/tmp/yuki_channels.json") as f:
    channels = json.load(f)
CHANNEL_IDS = [c["id"] for c in channels]

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

# Login
r = requests.post(f"{PANEL}/api/auth/login", json={"password": ADMIN_PW}, timeout=15)
session = r.json()["token"]
print(f"Session: {session[:20]}...")

# Create Yuki with multi-provider config:
# Provider 1: your lolmaobruhhh proxy (primary)
# Provider 2: z.ai SDK as fallback (free, no proxy needed)
body = {
    "name": "Yuki~mama",
    "persona": PERSONA,
    "token": "MTUzOTE5OTI3ODUzMzA1NDQ2NA.GMxDS4.j69pRhWYKfavn4xs2kGSnWjkuWi9RKLLuciNHo",
    "guild_id": "1511640846435356794",
    "channel_ids": CHANNEL_IDS,
    "delegated_bots": [],
    "providers": [
        {
            "id": "primary",
            "name": "lolmaobruhhh proxy",
            "type": "openai",
            "priority": 1,
            "enabled": True,
            "proxy_url": "https://lolmaobruhhh-fap.hf.space/v1",
            "api_key": "FAP!",
            "model": "idk:gemini-3.6-flash-high-search",
            "temperature": 0.85,
            "max_tokens": 1500,
        },
        {
            "id": "zai-fallback",
            "name": "z.ai SDK (free fallback)",
            "type": "zai",
            "priority": 2,
            "enabled": True,
            "proxy_url": "",
            "api_key_enc": "",
            "model": "glm-4.6",
            "temperature": 0.85,
            "max_tokens": 1500,
            "zai_thinking": "disabled",
        },
    ],
    "gating": {
        "response_probability": 1.0,
        "skip_patterns": [r"^\+$", r"^-$", r"^(k|kk)$"],
        "ignore_bots": True,
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

print("\n=== Creating Yuki with 2 providers ===")
r = requests.post(f"{PANEL}/api/bots", json=body, headers={"x-session-token": session}, timeout=30)
print(f"HTTP {r.status_code}")
resp = r.json()
if r.status_code != 200:
    print(json.dumps(resp, indent=2))
else:
    bot = resp["bot"]
    print(f"  id: {bot['id']}")
    print(f"  name: {bot['name']}")
    print(f"  providers: {len(bot['providers'])}")
    for p in bot["providers"]:
        print(f"    - [{p['priority']}] {p['name']} (type={p['type']}, enabled={p['enabled']}, model={p['model']})")
    print(f"  channels: {len(bot['channel_ids'])}")
    print(f"  status: {bot['status']}")
    # Save ID for next step
    with open("/tmp/yuki_zai_bot_id.txt", "w") as f:
        f.write(bot["id"])
    with open("/tmp/yuki_zai_session.txt", "w") as f:
        f.write(session)
    print(f"\n  Bot ID saved: {bot['id']}")
