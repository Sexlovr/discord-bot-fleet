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

# Discord Bot Fleet — Bootstrap Space

This HF Space is a **bootstrap**: it clones your real source code from GitHub at container start using a `GIT_PAT` secret, then runs it. The actual bot code lives on GitHub — push there, restart this Space, and you're live.

## Setup (5 minutes)

### 1. Push the project to GitHub

```bash
cd discord-bot-fleet
git init
git remote add origin https://github.com/YOUR_USERNAME/discord-bot-fleet.git
git add .
git commit -m "initial"
git push -u origin main
```

If your repo is private, that's fine — the PAT just needs `repo` scope.

### 2. Create a GitHub Personal Access Token

Go to https://github.com/settings/tokens → **Generate new token (classic)** → check `repo` scope → copy the token (starts with `ghp_`).

### 3. Create this HF Space

Create a new Space with **SDK: Docker**. Then push only the contents of `discord-bot-fleet/huggingface/` to the Space's git repo:

```bash
git clone https://huggingface.co/spaces/YOUR_USERNAME/YOUR_SPACE_NAME
cp -r discord-bot-fleet/huggingface/* YOUR_SPACE_NAME/
cd YOUR_SPACE_NAME
git add . && git commit -m "bootstrap" && git push
```

The HF Space repo should contain only 2 files:
- `README.md` (this file, with HF metadata frontmatter)
- `Dockerfile` (bootstrap — uses BuildKit heredoc to embed the entrypoint script inline, so no separate `entrypoint.sh` is needed)

### 4. Set HF Secrets and Variables

In HF Space → **Settings** → **Variables and secrets**:

**Secrets** (encrypted, never logged):
| Name | Value |
|---|---|
| `GIT_PAT` | Your GitHub PAT from step 2 (e.g. `ghp_xxxxxxxxxxxx`) |
| `ADMIN_PASSWORD` | A strong password for the web panel (16+ chars) |
| `MASTER_KEY` | 32+ hex chars for encrypting bot tokens — generate with `openssl rand -hex 32` |

**Variables** (plain, used at build/runtime):
| Name | Value |
|---|---|
| `REPO_URL` | `https://github.com/YOUR_USERNAME/discord-bot-fleet` |
| `REPO_BRANCH` | `main` (or whatever branch you want to deploy) |

Optional variables:
| Name | Value |
|---|---|
| `LLM_API_KEY` | Default LLM API key (defaults to `FAP!` if bot has none configured) |
| `GITHUB_TOKEN` | Optional, raises GitHub API rate limit for `github_lookup` tool |

### 5. Wait + open

- Build takes ~30s (just installs git on top of node:20-slim)
- First boot takes ~1-2 min (clones repo, installs deps, compiles TS)
- Subsequent boots take ~10s (deps cached, just pull + compile)
- Open `https://YOUR_USERNAME-YOUR_SPACE_NAME.hf.space` → login with `ADMIN_PASSWORD`

## Updating the bot

**To deploy new code**: push to GitHub `main` → restart the HF Space (Settings → Restart Space). Or just push — the Space will detect the change and rebuild.

**To change which branch is deployed**: update the `REPO_BRANCH` variable in HF Settings → restart.

**To change repos**: update `REPO_URL` → restart.

## Bot-to-bot delegation

You can have one bot summon another bot in the fleet. Example use case:
- Bot 1: glmu (your existing GLM bot, has Python execution tools)
- Bot 4: Maya (the coder girl, no shell access)

Configure Maya to "use glmu as her coding assistant":
1. Start glmu first (so we know its Discord user ID)
2. Edit Maya → scroll to "Delegated bots" → check glmu
3. Save & Restart Maya
4. Now when Maya gets a coding question, her LLM can call `summon_bot({ bot_id: "glmu_id", message: "run this Python for me: ..." })` — she'll @mention glmu, wait for the reply, then continue her response

## Troubleshooting

**"GIT_PAT secret not set"** → You forgot to add the secret. Go to HF Settings → Variables and secrets → New secret.

**"Clone failed"** → Check:
- `REPO_URL` is correct (no trailing slash, no `.git` needed)
- `GIT_PAT` is valid and has `repo` scope (test at https://github.com/settings/tokens)
- Your repo is not archived

**"TypeScript compilation failed"** → Check the build log on GitHub (CI). The HF logs will show the actual error — usually a typecheck issue.

**Space is stuck building** → Check HF Space → Files → check that `Dockerfile` and `entrypoint.sh` are pushed correctly.

**First boot is slow** → Normal. The first boot clones the repo + runs `npm install` (which downloads ~135 packages). Cached on subsequent boots via the persistent `/data` volume.
