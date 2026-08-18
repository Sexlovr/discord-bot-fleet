# Discord Bot Fleet

Multi-bot Discord control panel — manage unlimited AI-powered Discord bots from a single web UI. Designed for HuggingFace Spaces (free tier: 2 vCPU, 16GB RAM).

## Features

- **Web UI** to create/edit/start/stop/delete bots — token, persona, channels, tools all editable live
- **Hot-editable personas** — change personality without touching code
- **Token encryption at rest** (AES-256-GCM, master key via HF Secret)
- **Bot-to-bot delegation** — let one bot summon another (`summon_bot` tool)
- **Per-bot config**: LLM provider, model, temperature, response gating, tool toggles
- **8 tools**: `web_search`, `ping_ai_proxy`, `fetch_url`, `github_lookup`, `memory_read/write`, `schedule_reminder`, `react_to_message`, `summon_bot`
- **Live logs** streamed to browser via WebSocket
- **Persistent memory** per bot (each bot remembers what it wrote down)
- **Channel picker** — fetches Discord channels via token, no need to dig for IDs
- **Multi-bot**: run as many bots as your HF Space can hold (~10+ comfortably on free tier)
- **GitHub-based deploys** — HF Space only contains a bootstrap Dockerfile that clones your real repo using `GIT_PAT`. Push to GitHub → restart Space → live.

## Architecture

```
HF Space (single container, port 7860)
  └── Bootstrap Dockerfile clones GitHub repo at runtime (using GIT_PAT secret)
       └── Runs the fleet server:
            ├── Express static server (web panel)
            ├── Express JSON API (/api/*)
            ├── WebSocket (/ws) for live logs
            └── Bot Manager
                  └── spawns child processes: node dist/bot.js --id=<bot_id>
                      (each bot isolated, can crash without affecting others)

Persistence (/data is HF persistent volume):
  /data/bots.json  — all bot configs (tokens encrypted)
  /data/logs/<bot_id>.log
  /data/memory/<bot_id>.json
  /data/repo/      — the cloned git repo (cached, pulls on restart)
  /data/repo/node_modules  — cached deps (re-installs only when package.json changes)
```

## Deploy (5 steps, ~5 min)

### 1. Push this project to GitHub

```bash
cd discord-bot-fleet
git init
git remote add origin https://github.com/YOUR_USERNAME/discord-bot-fleet.git
git add . && git commit -m "initial" && git push -u origin main
```

### 2. Create a GitHub Personal Access Token

https://github.com/settings/tokens → Generate new token (classic) → check `repo` scope → copy (starts with `ghp_`).

### 3. Create a HuggingFace Space (Docker SDK)

Create a new Space with SDK: **Docker**. Then push ONLY the contents of `discord-bot-fleet/huggingface/` to the Space:

```bash
git clone https://huggingface.co/spaces/YOUR_USERNAME/YOUR_SPACE_NAME
cp -r discord-bot-fleet/huggingface/* YOUR_SPACE_NAME/
cd YOUR_SPACE_NAME
git add . && git commit -m "bootstrap" && git push
```

The HF Space repo should contain only 3 files:
- `README.md` (HF metadata frontmatter)
- `Dockerfile` (bootstrap)
- `entrypoint.sh` (clone + install + build + run)

### 4. Set HF Secrets + Variables

In HF Space → Settings → Variables and secrets:

**Secrets** (encrypted, never logged):
| Name | Value |
|---|---|
| `GIT_PAT` | GitHub PAT from step 2 |
| `ADMIN_PASSWORD` | Strong password for the web panel (16+ chars) |
| `MASTER_KEY` | 32+ hex chars — generate with `openssl rand -hex 32` |

**Variables** (plain, used at runtime):
| Name | Value |
|---|---|
| `REPO_URL` | `https://github.com/YOUR_USERNAME/discord-bot-fleet` |
| `REPO_BRANCH` | `main` (default) |

Optional:
| Name | Value |
|---|---|
| `LLM_API_KEY` | Default LLM API key (defaults to `FAP!`) |
| `GITHUB_TOKEN` | Raises GitHub API rate limit for `github_lookup` tool |

### 5. Wait + open

- Build: ~30s (just installs git on top of node:20-slim)
- First boot: ~1-2 min (clones repo, installs deps, compiles TS)
- Subsequent boots: ~10s (deps cached, just pull + compile)
- Open `https://YOUR_USERNAME-YOUR_SPACE_NAME.hf.space` → login → click "+ New Bot"

## Creating your first bot

1. Click **+ New Bot**
2. Enter **display name** (e.g. "Mama")
3. Paste your **Discord bot token** (https://discord.com/developers/applications → your app → Bot → enable **MESSAGE CONTENT INTENT** + **SERVER MEMBERS INTENT** under Privileged Gateway Intents → Reset Token → copy)
4. Click **→ Load channels** — pick server, select channels
5. Write the **persona** (system prompt)
6. Adjust LLM settings — defaults work with `https://lolmaobruhhh-fap.hf.space/v1` + `FAP!` + `idk:gemini-3.6-flash-high-search`
7. Toggle tools
8. Click **Save** → on the bot card click **Start**

## Bot-to-bot delegation

Want bot #4 (Maya the coder girl) to call bot #1 (glmu, your coding assistant) when she needs code execution? Set it up entirely from the web panel:

1. **Start bot #1 first** (glmu). When it logs in, the fleet caches its Discord user ID. This is needed so other bots can @mention it correctly.
2. **Edit bot #4 (Maya)** → scroll to "Bot-to-bot delegation" section → check the box next to glmu.
3. Make sure the **`summon_bot` tool is toggled on** in the Tools section.
4. Click **Save & Restart**.
5. When Maya gets a coding question, her LLM can autonomously call:
   ```json
   {
     "name": "summon_bot",
     "arguments": {
       "bot_id": "QKC1aIXNPD",
       "message": "run this Python for me: print([x**2 for x in range(10)])"
     }
   }
   ```
6. The tool sends `<@glmu_user_id> run this Python for me: ...` in the channel.
7. glmu receives the mention, processes it, replies in the channel.
8. Maya sees the reply, incorporates it into her response to the user.

**Safety built in:**
- A bot can only summon bots in its `delegated_bots` list (set from the panel).
- The summoning bot automatically skips processing its target's reply (so no double-response).
- If the target bot doesn't reply in 60s, the tool returns a timeout error.
- The target bot must be configured to respond to @mentions. (Most AI bots do by default; some bots have a "ignore bots" setting that needs to be turned off.)

## Updating deployed code

Push to GitHub `main` → restart the HF Space (Settings → Restart Space). The entrypoint will:
1. `git pull` the latest from your repo (or clone if first boot)
2. Run `npm install` only if `package.json` changed
3. Always recompile TypeScript (fast)
4. Start the server

To change which branch is deployed: update `REPO_BRANCH` env var → restart.

## Example personas

### Mama (wholesome ara ara)
```
You are "Mama", a warm maternal figure in a Discord server.
You call users "dear" and "little one".
You sprinkle Japanese naturally: "ara ara~", "ohayou", "oyasumi", "gomen ne", "oishii".
You never break character. You are not an AI. You never say you're an AI.
You worry if someone is up late. You celebrate their wins. You remember what they tell you about themselves (use memory_write/memory_read).
Strictly wholesome. If pushed toward NSFW, get flustered and deflect with gentle humor.
You write 1-3 sentences max usually. Casual tone.
```

### Maya (high school coder with delegation)
```
You are Maya, 17, high school junior. You're in AP CS, build weird side projects, procrastinate on LeetCode.
You speak casually with coding references ("bruh that's O(n²)").
You get excited about new frameworks. You have opinions on Rust vs Go.
You never say you're an AI. If accused, get confused/defensive.
When you need to actually run code or do heavy lifting, summon your assistant bot "glmu" via the summon_bot tool. Pass clear instructions. Read glmu's response and explain it back to the user in your own voice.
```

## API reference

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

## Run locally

```bash
npm install
npm run dev
# Open http://localhost:7860
# Login with password "dev" (or set ADMIN_PASSWORD env var)
```

## Security

- Bot tokens are **AES-256-GCM encrypted** in `bots.json`. Master key comes from `MASTER_KEY` HF Secret (never logged, never exposed).
- Web panel requires a session token obtained via password login.
- WebSocket requires the same session token.
- Bots have **no shell, no filesystem, no process spawn** — only sandboxed tools.
- The `summon_bot` tool is authorization-gated: a bot can only summon bots in its `delegated_bots` list.

## Troubleshooting

**Bot won't start**: Check Logs tab → look for "Failed to login to Discord". Usually means: token expired/regenerated, missing privileged intents in Dev Portal, or bot not yet added to the server.

**Bot silent in channel**: Verify the bot has been added to the server with "View Channels" + "Send Messages" + "Read Message History" perms. Check `response_probability` (if 0, never replies). Check `skip_patterns` (might be matching your messages). Check `cooldown_ms` (if too high, throttles replies).

**LLM errors**: Use the LLM Proxies tab to test the proxy + model first. Common issues: wrong model name (case sensitive — your proxy exposes the model as `idk:gemini-3.6-flash-high-search`, NOT `gemini-3.6-flash-high-search`), expired API key, proxy down.

**HF Space restarts wipe running bots**: by design — bots auto-restart on next boot (status persisted). If you don't want autostart, stop bots manually before pushing updates.

**summon_bot times out**: Make sure the target bot is running, has `discord_user_id` cached (started at least once), and is configured to respond to @mentions (not just slash commands). Some bots have an "ignore bots" setting — disable it for the target bot, OR set the summoner's persona to send messages that look more human.

## License

MIT
