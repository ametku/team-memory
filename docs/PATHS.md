# team-memory: Paths and Configuration

## How the CLI finds your team-memory repo

When you run any `team-memory` command, it resolves where your shared repo is in this order:

```
1. TEAM_MEMORY_DIR env var                  explicit, always wins
2. .claude/.team-memory-dir in current repo written by `team-memory opt-in`
3. ~/.team-memory                           default fallback
```

**The practical implication:** once you've run `team-memory opt-in` in a project, all `team-memory` commands work from that project directory without any env var. No prefixing, no extra setup.

---

## Default setup (most users)

If you joined with the default path:
```bash
team-memory join https://github.com/org/team-memory.git
```

Your team-memory repo is at `~/.team-memory`. Every command uses it automatically. You don't need to set anything.

---

## Custom path setup

If you want the repo somewhere visible (or have multiple team repos):
```bash
team-memory join https://github.com/org/team-memory.git --dir ~/my-team-memory
```

Now add it to your shell profile so every terminal and Claude Code picks it up:
```bash
echo 'export TEAM_MEMORY_DIR=~/my-team-memory' >> ~/.zshrc
source ~/.zshrc
```

After that, every command — in any directory — uses `~/my-team-memory`.

---

## Opted-in repos: commands just work

When you opt in a project:
```bash
cd ~/repos/my-service
team-memory opt-in
```

Two things are created:
- `.claude/team-memory.md` — the opt-in marker (commit this)
- `.claude/.team-memory-dir` — your local path pointer (gitignored, do not commit)

From this point on, any `team-memory` command run from `~/repos/my-service` auto-discovers the right repo — no `TEAM_MEMORY_DIR` needed:

```bash
cd ~/repos/my-service
team-memory query "database connection"     # works
team-memory add "Always use X" ...          # works
team-memory review-pending                  # works
team-memory dashboard                       # works
```

### What teammates need to do

`.claude/team-memory.md` is committed — the opt-in is global. But `.claude/.team-memory-dir` is machine-local (gitignored). After pulling, teammates run once:

```bash
cd ~/repos/my-service
team-memory opt-in    # creates their own .team-memory-dir pointing to their local repo
```

---

## What changes when a project is opted in

| Feature | Opted-in | Not opted-in |
|---|---|---|
| `preprompt-hook` injects facts | ✅ | ❌ silently skips |
| `extract-bgc` processes sessions | ✅ | ❌ ignored |
| `extract-slack` queues prompts | ✅ | ❌ skips |
| `review-pending` | ✅ shows facts | ❌ nothing to show |
| `add`, `query`, `reject` | ✅ | ✅ works anywhere |
| `sync`, `dashboard`, `prune` | ✅ | ✅ works anywhere |

---

## Dashboard

`team-memory dashboard` reads from `TEAM_MEMORY_DIR` — not from the project you're currently in. It shows all facts from all teammates across all projects.

- Works from any directory, opted-in or not
- Output file: `TEAM_MEMORY_DIR/dashboard.html` (never in your project repo)
- Filter by project inside the dashboard UI after opening it

```bash
# From anywhere:
team-memory dashboard

# From an opted-in project (auto-discovers TEAM_MEMORY_DIR):
cd ~/repos/my-service
team-memory dashboard
```

---

## Commands and current directory

Most commands don't care where you run them — they read `TEAM_MEMORY_DIR` from the env var or `.team-memory-dir` file.

Commands that use the current directory:

| Command | Why it needs CWD | Run from |
|---|---|---|
| `opt-in` | Registers the current project | Your project root |
| `review-pending` | Detects project to show pending facts | Your project root |
| `preprompt-hook` | Detects project name + checks opt-in | Your project (Claude Code does this) |

Commands that don't care about CWD:

`query`, `add`, `reject`, `sync`, `dashboard`, `prune`, `rebuild-index`, `extract-bgc`, `extract-slack`, `update`

---

## What lives where

### TEAM_MEMORY_DIR (shared git repo)

```
TEAM_MEMORY_DIR/
│
│  ── committed and synced with teammates ──────────────
├── facts/facts-<name>.db            your authored facts
├── interactions/interactions-<name>.db  your surface counts + rejects
├── config.yaml                      developer name, cli_source
│
│  ── local only, never committed ──────────────────────
├── merged_index.db                  FTS5 query index (rebuilt from facts/)
├── dashboard.html                   generated on demand
├── opted-in-projects.json           your machine's project registry
├── slack-queue.json                 prompts queued for Slack search
├── pending-facts.json               facts awaiting your review
├── processed-sessions-bgc.json      extract-bgc dedup list
├── hooks/idle.sh  (or idle.ps1)     idle hook script
│
│  ── logs, never committed ────────────────────────────
├── idle.txt      one line per Claude response (hook fired/skipped)
├── bgc.txt       one line per fact queued by extract-bgc
├── slack.txt     one line per fact queued by extract-slack
└── hooks.log     Claude Code hook errors (check here if hooks misbehave)
```

### Each opted-in project

```
my-project/
└── .claude/
    ├── team-memory.md        opt-in marker — COMMIT this
    ├── .gitignore            contains ".team-memory-dir"
    └── .team-memory-dir      your local path pointer — DO NOT commit
```

### Claude Code config

```
~/.claude/
├── settings.json   5 team-memory hooks installed by join/update
└── skills/extract-facts/SKILL.md   the /extract-facts skill
```

---

## Troubleshooting

**Facts not showing up in Claude**
```bash
# 1. Is the project opted in?
cat .claude/team-memory.md

# 2. Is the dir pointer set?
cat .claude/.team-memory-dir

# 3. Test the hook directly:
echo '{"prompt":"your search"}' | team-memory preprompt-hook

# 4. Check hook errors:
cat $(team-memory --help | grep -o '[^ ]*hooks.log' | head -1) 2>/dev/null \
  || cat ~/.team-memory/hooks.log
```

**`extract-bgc` finds no sessions**
```bash
# Re-register the project:
cd ~/repos/my-project
team-memory opt-in

# Check registry:
cat ${TEAM_MEMORY_DIR:-~/.team-memory}/opted-in-projects.json
```

**Commands using wrong TEAM_MEMORY_DIR**
```bash
# Which repo is being used right now?
cd ~/repos/my-service
node -e "import('./node_modules/.bin/team-memory')" 2>/dev/null \
  || echo '{"prompt":""}' | team-memory preprompt-hook | head -c 5

# Simpler check:
cat .claude/.team-memory-dir    # should show your expected path
```

**Hooks not firing**
```bash
team-memory update --no-rebuild   # wipe + reinstall all hooks
# Then restart Claude Code
```
