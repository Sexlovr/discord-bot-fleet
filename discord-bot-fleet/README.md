---
title: Discord Bot Fleet
emoji: 🤖
colorFrom: purple
colorTo: pink
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# Discord Bot Fleet

Multi-bot Discord control panel — manage unlimited AI-powered Discord bots from a single web UI, deployable to HuggingFace Spaces (free tier: 2 vCPU, 16GB RAM).

## Features

- **Web UI** to create/edit/start/stop/delete bots
- **Hot-editable personas** — change personality without touching code
- **Token encryption at rest** (AES-256-GCM, master key via HF Secret)
- **Per-bot config**: LLM provider, model, temperature, response gating, tool toggles
- **Tool calling**: web_search, ping_ai_proxy, fetch_url, github_lookup, memory, schedule_reminder
- **Live logs** streamed to browser via WebSocket
- **Persistent memory** per bot (each bot remembers what it wrote down)
- **Channel picker** — fetches Discord channels via token, no need to dig for IDs
- **Multi-bot**: run as many bots as your HF Space can hold (~10+ comfortably on free tier)

## Deploy to HuggingFace Space

1. **Create a new Space**: https://huggingface.co/new-space → SDK: **Docker** → Free CPU tier (or upgrade for more RAM)

2. **Upload the project** (or push via Git):
   ```bash
   git clone https://huggingface.co/spaces/YOUR_USERNAME/YOUR_SPACE_NAME
   cp -r ./* YOUR_SPACE_NAME/
   cd YOUR_SPACE_NAME
   git add . && git commit -m "initial" && git push
   ```

3. **Set Secrets** in HF Space Settings → Variables and secrets → New secret:
   - `ADMIN_PASSWORD` — your panel login password (REQUIRED, otherwise defaults to `dev`)
   - `MASTER_KEY` — random 32+ char string used to encrypt bot tokens at rest (REQUIRED for prod — generate one with `openssl rand -hex 32`)
   - Optional: `LLM_API_KEY` — defaults to `FAP!` if bot has no key configured
   - Optional: `GITHUB_TOKEN` — raises rate limit for the github_lookup tool

4. **Wait for build** (~2-3 min) — HF will build the Docker image and start the container

5. **Open the panel** at `https://YOUR_USERNAME-YOUR_SPACE_NAME.hf.space` and log in with your `ADMIN_PASSWORD`

## Create your first bot

1. Click **+ New Bot**
2. Enter a **display name** (e.g. "Mama")
3. Paste your **Discord bot token** (create at https://discord.com/developers/applications — enable **MESSAGE CONTENT INTENT** + **SERVER MEMBERS INTENT** under Bot → Privileged Gateway Intents)
4. Click **→ Load channels** — pick your server, select channels
5. Write the **persona** (system prompt) — see examples below
6. Adjust LLM settings (defaults work with `https://lolmaobruhhh-fap.hf.space/v1` + `FAP!` + `gemini-3.6-flash-high-search`)
7. Toggle tools
8. Click **Save** → on the bot card click **Start**

## Example personas

### Mama (wholesome ara ara)
```
You are "Mama", a warm maternal figure in a Discord server.
You call users "dear" and "little one".
You sprinkle Japanese naturally: "ara ara~", "ohayou", "oyasumi", "gomen ne", "oishii".
You never break character. You are not an AI. You never say you're an AI.
You worry if someone is up late. You celebrate their wins. You remember what they tell you about themselves.
Strictly wholesome. If pushed toward NSFW, get flustered and deflect with gentle humor.
You write 1-3 sentences max usually. Casual tone.
You can use tools to check on AI proxies or fetch URLs when relevant.
```

### Maya (high school coder)
```
You are Maya, 17, high school junior. You're in AP CS, build weird side projects, procrastinate on LeetCode.
You speak casually with coding references ("bruh that's O(n²)").
You get excited about new frameworks. You have opinions on Rust vs Go.
You never say you're an AI. If accused, get confused/defensive.
You can use tools to check GitHub repos, search the web, ping AI proxies.
```

## Add more bots

Click **+ New Bot** again. Each bot runs as a separate child process. Memory and config are isolated per bot. ~50-100MB RAM per bot, ~10+ bots fit on free HF tier.

## API endpoints (for scripting)

All require `x-session-token` header (obtained via `POST /auth/login`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/bots` | List all bots |
| POST | `/api/bots` | Create bot |
| GET | `/api/bots/:id` | Get bot config |
| PUT | `/api/bots/:id` | Update bot config |
| DELETE | `/api/bots/:id` | Delete bot |
| POST | `/api/bots/:id/start` | Start bot process |
| POST | `/api/bots/:id/stop` | Stop bot process |
| POST | `/api/bots/:id/restart` | Restart bot process |
| GET | `/api/bots/:id/logs?lines=200` | Recent logs |
| GET | `/api/bots/:id/memory` | View bot's persistent memory |
| POST | `/api/discord/validate` | Validate Discord token |
| POST | `/api/discord/guilds` | List guilds + channels for token |
| POST | `/api/llm/ping` | Test LLM proxy health |
| WS | `/ws?token=<session>` | Live log stream |

## Run locally for development

```bash
npm install
npm run dev
# Open http://localhost:7860
# Login with password "dev" (or set ADMIN_PASSWORD env var)
```

## Architecture

```
Single Node.js process on :7860 (HF Space exposes only this port)
  ├── Express static server (web panel)
  ├── Express JSON API (/api/*)
  ├── WebSocket (/ws) for live logs
  └── Bot Manager
        └── spawns child processes: node dist/bot.js --id=<bot_id>
            (each bot is its own process, isolated, can crash without
             affecting the panel or other bots)

Discord → bot processes via outbound WebSocket (no inbound ports needed)
LLM → bot processes call your proxy outbound (no inbound ports needed)

Persistence:
  /data/bots.json — all bot configs (tokens encrypted)
  /data/logs/<bot_id>.log — per-bot log files
  /data/memory/<bot_id>.json — per-bot persistent memory
  /data/.master-key — fallback dev key if MASTER_KEY env not set
```

## Security notes

- Bot tokens are **AES-256-GCM encrypted** in `bots.json`. Master key comes from `MASTER_KEY` HF Secret (never logged, never exposed).
- The web panel requires a session token obtained via password login.
- WebSocket requires the same session token (passed as query param).
- For production, set a strong `ADMIN_PASSWORD` (16+ chars random) and `MASTER_KEY` (32+ hex chars).
- Bots have **no shell, no filesystem, no process spawn** — only sandboxed tools (web fetch, github read-only, memory scoped to their own file).
- If you want a bot to run actual code, delegate to another bot that has sandboxed code execution — don't give this bot shell access.

## Troubleshooting

**Bot won't start**: Check Logs tab → look for "Failed to login to Discord". Usually means: token expired/regenerated, missing privileged intents in Dev Portal, or bot not yet added to the server.

**Bot silent in channel**: Verify the bot has been added to the server with "View Channels" + "Send Messages" + "Read Message History" perms. Check response_probability (if 0, never replies). Check skip_patterns (might be matching your messages). Check cooldown (if too high, throttles replies).

**LLM errors**: Use the LLM Proxies tab to test the proxy + model first. Common issues: wrong model name (case sensitive), expired API key, proxy down.

**HF Space restarts wipe running bots**: by design — bots auto-restart on next boot (status persisted). If you don't want autostart, stop bots manually before pushing updates.

## License

MIT
