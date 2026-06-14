# team-memory

Shared long-term memory for coding agents. Facts learned by one developer in a Claude Code session become available to all teammates automatically — injected as context before every prompt.

---

## Quick start

### Step 1 — Build the CLI

```bash
git clone https://github.com/ametku/team-memory.git ~/team-memory-cli
cd ~/team-memory-cli
npm install && npm run build && npm link

team-memory --version   # 0.2.0
```

### Step 2 — Join your team's shared repo

```bash
team-memory join https://github.com/your-org/your-team-memory.git

# Or with a custom location (recommended — easier to find):
team-memory join https://github.com/your-org/your-team-memory.git \
  --dir ~/Desktop/team-memory

# Add to ~/.zshrc so every terminal uses it:
echo 'export TEAM_MEMORY_DIR=~/Desktop/team-memory' >> ~/.zshrc
source ~/.zshrc
```

This clones the shared repo, creates your per-developer databases, installs Claude Code hooks, and installs the `/extract-facts` skill.

### Step 3 — Opt in your projects

```bash
cd ~/repos/my-service
team-memory opt-in
git add .claude/team-memory.md && git commit -m "chore: opt into team-memory" && git push
```

Commit the marker file so teammates are opted in automatically when they pull.

### Step 4 — Start working

Open Claude Code in any opted-in project. Facts from your team are injected automatically before every prompt. When you close a session or go idle for 2 minutes, `/extract-facts` runs to capture what you learned.

---

## How it works

```
You type a prompt
  → UserPromptSubmit hook queries merged_index.db (FTS5)
  → Matching facts injected as context before Claude responds

You go idle 2 minutes
  → Stop hook fires → asyncRewake → /extract-facts skill runs
  → Claude proposes 0-3 facts from the session
  → You approve → committed + pushed to the shared repo

Teammate syncs
  → git pull → post-merge hook → rebuild merged_index.db
  → Your facts now surface in their sessions
```

---

## Commands at a glance

```
team-memory --help     Full command reference organized by where to run each command
```

Key commands by context:

| Where | Command |
|---|---|
| Terminal (setup) | `team-memory join <url>` · `team-memory update` · `team-memory opt-in` |
| Terminal (periodic) | `team-memory extract-bgc` · `team-memory sync --push` · `team-memory prune` |
| Claude session (`!`) | `! team-memory review-pending` · `! team-memory dashboard` · `! team-memory query <text>` |
| Auto (hooks) | `preprompt-hook` · `session-start` · `session-deactivate` · `idle.sh` |

---

## Docs

| Doc | What's in it |
|---|---|
| [docs/PATHS.md](docs/PATHS.md) | **Path guide** — where everything lives, custom paths, multi-team setup, troubleshooting |
| [ARCHITECTURE-V1.md](ARCHITECTURE-V1.md) | Full architecture — data model, trust scoring, sync, all design decisions |
| [CHANGELOG.md](CHANGELOG.md) | Version history and upgrade guide from v0.1.0 |
| `team-memory --help` | Command reference organized by execution context |

---

## Logs

All logs live in `TEAM_MEMORY_DIR` (never in your project repos):

| File | What's in it |
|---|---|
| `idle.txt` | Idle hook fires — one entry per Claude response |
| `bgc.txt` | Facts queued by `extract-bgc` — one line per fact |
| `slack.txt` | Facts queued by `extract-slack` — one line per fact |
| `hooks.log` | Claude Code hook errors — check here if hooks misbehave |
