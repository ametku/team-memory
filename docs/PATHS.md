# team-memory: Paths and Configuration

## The one env var you need to know

```
TEAM_MEMORY_DIR    path to your team-memory git clone
```

That's it. Everything else is derived from this.

If you don't set it, every command defaults to `~/.team-memory`. If you set it, every command uses that path instead — hooks, logs, index, pending facts, all of it.

---

## Setting TEAM_MEMORY_DIR

**Temporary (one terminal session):**
```bash
export TEAM_MEMORY_DIR=~/my-team-memory
team-memory query "something"
```

**Persistent (recommended — add to `~/.zshrc` or `~/.bashrc`):**
```bash
echo 'export TEAM_MEMORY_DIR=~/my-team-memory' >> ~/.zshrc
source ~/.zshrc
```

Once it's in your shell profile, every terminal and every tool that inherits env vars — including Claude Code — uses the right path automatically. You never have to think about it again.

**What happens if you don't set it:**
- Commands work fine — they use `~/.team-memory`
- The hooks installed by `join`/`init` also default to `~/.team-memory`
- Consistent as long as you only have one team-memory repo

**What happens if you set it inconsistently** (e.g. set in one terminal but not another):
- Commands in different terminals talk to different repos
- Claude Code uses whatever env var the process that launched it had
- Facts get silently split across two locations
- Fix: set it in your shell profile and reload

---

## Running commands from different directories

team-memory commands work from **any directory**. They always read `TEAM_MEMORY_DIR` from the env var (or default), never from the current directory.

**Exception: commands that involve your project repo.**
Some commands detect the current directory's git repo to scope things:

| Command | Uses current directory for | Needs to be run from |
|---|---|---|
| `opt-in` | Detect which project to register | Inside your project repo |
| `preprompt-hook` | Detect project name + check opt-in marker | Inside your project repo (Claude Code does this) |
| `extract-bgc` | Nothing — uses registry | Anywhere |
| `review-pending` | Detect project to show pending facts | Inside your project repo |
| `add` | Nothing | Anywhere |
| `query` | Nothing (use `--project` to scope) | Anywhere |
| `sync`, `dashboard`, `prune` | Nothing | Anywhere |
| `rebuild-index` | Nothing | Anywhere |

---

## Opted-in repos vs non-opted-in repos

### What opt-in does

When you run `team-memory opt-in` from a project directory, two things happen:

1. Creates `.claude/team-memory.md` in the project root
2. Registers the project in `TEAM_MEMORY_DIR/opted-in-projects.json`

### What changes when a project is opted in

| Feature | Opted-in project | Non-opted-in project |
|---|---|---|
| `preprompt-hook` injects facts | ✅ | ❌ silently skips |
| `extract-bgc` processes sessions | ✅ | ❌ sessions ignored |
| `extract-slack` queues prompts | ✅ | ❌ skips |
| `review-pending` shows facts | ✅ | ❌ nothing to show |
| `add`, `query`, `reject` | ✅ works anywhere | ✅ works anywhere |
| `sync`, `dashboard`, `prune` | ✅ works anywhere | ✅ works anywhere |

### Committing the opt-in marker

```bash
cd ~/repos/my-service
team-memory opt-in
git add .claude/team-memory.md
git commit -m "chore: opt into team-memory"
git push
```

Commit `.claude/team-memory.md` so teammates get it when they pull — they don't need to run `opt-in` themselves, the marker file is enough for `preprompt-hook`. But they do need to register the project locally for `extract-bgc`:

```bash
# Teammate needs to re-register after pulling (one-time):
cd ~/repos/my-service
team-memory opt-in    # sees marker already exists, just updates local registry
```

### Opting in multiple projects

```bash
cd ~/repos/service-a   && team-memory opt-in
cd ~/repos/service-b   && team-memory opt-in
cd ~/repos/mobile-app  && team-memory opt-in
```

All feed the same `TEAM_MEMORY_DIR`. Facts are tagged with `--project <basename>` automatically so they stay scoped. When you're in `service-a` and query, you get `service-a` facts first.

---

## What lives where

### In TEAM_MEMORY_DIR (your shared git clone)

```
TEAM_MEMORY_DIR/
│
│  ── in git (synced with teammates) ──────────────────────
├── facts/
│   ├── facts-<yourname>.db          your authored facts
│   └── facts-<teammate>.db          their authored facts
├── interactions/
│   ├── interactions-<yourname>.db   your surface counts + rejects
│   └── interactions-<teammate>.db   their surface counts + rejects
├── config.yaml                      developer name, cli_source path
│
│  ── local only (never committed) ────────────────────────
├── merged_index.db                  FTS5 query index, rebuilt from facts/
├── dashboard.html                   generated on demand
├── opted-in-projects.json           your machine's project registry
├── slack-queue.json                 prompts queued for extract-slack
├── pending-facts.json               facts awaiting your review
├── processed-sessions-bgc.json      dedup list for extract-bgc
├── hooks/
│   ├── idle.sh                      idle hook script (macOS/Linux)
│   └── idle.ps1                     idle hook script (Windows)
│
│  ── logs (never committed) ───────────────────────────────
├── idle.txt                         one line per Claude response (hook fired/skipped)
├── bgc.txt                          one line per fact queued by extract-bgc
├── slack.txt                        one line per fact queued by extract-slack
└── hooks.log                        errors from Claude Code hooks
```

### In each opted-in project repo

```
my-project/
└── .claude/
    └── team-memory.md               opt-in marker — commit this
```

That's the only file team-memory puts in your project. Nothing else.

### In Claude Code's config dir

```
~/.claude/
├── settings.json        has the 5 team-memory hooks (added by join/update)
└── skills/
    └── extract-facts/
        └── SKILL.md     the /extract-facts skill (added by join/update)
```

---

## How each command finds the team-memory repo

Every command calls `resolveRepoDir()` which returns:
```
TEAM_MEMORY_DIR env var  →  if set, use it
~/.team-memory            →  default fallback
```

And `resolveIndexPath()` returns:
```
TEAM_MEMORY_INDEX_PATH env var  →  if set, use it
~/.cache/team-memory/merged_index.db  →  default fallback
```

You rarely need `TEAM_MEMORY_INDEX_PATH`. It's there if you want the index in a different location from the data.

---

## Using the same commands across different repos

You're working in `service-a` and want to query facts from `service-b`:

```bash
# Scoped to current project (auto-detected):
! team-memory query "database connection"

# Scoped to a specific project explicitly:
! team-memory query "database connection" --project service-b

# No project scope — searches everything:
! team-memory query "database connection" --limit 10
```

Adding a fact while in any directory:

```bash
# Auto-detects project from CWD git repo:
! team-memory add "Always use connection pooling — default single connection causes timeouts under load" \
    --project service-a \
    --tags '["category:gotcha","database","pooling","connections"]'
```

---

## Verifying your setup

```bash
# 1. Which TEAM_MEMORY_DIR is active?
echo ${TEAM_MEMORY_DIR:-~/.team-memory}

# 2. Facts DB files exist?
ls ${TEAM_MEMORY_DIR:-~/.team-memory}/facts/

# 3. Opted-in projects?
cat ${TEAM_MEMORY_DIR:-~/.team-memory}/opted-in-projects.json

# 4. Hooks installed in Claude Code?
grep -c "team-memory" ~/.claude/settings.json
# should print 5

# 5. Idle script executable?
ls -la ${TEAM_MEMORY_DIR:-~/.team-memory}/hooks/idle.sh

# 6. Test preprompt hook (from an opted-in project dir):
cd ~/repos/my-service
echo '{"prompt":"database connection pool"}' | team-memory preprompt-hook
# returns {"continue":true} if no facts match, or {"hookSpecificOutput":...} if facts found

# 7. Check hook errors:
cat ${TEAM_MEMORY_DIR:-~/.team-memory}/hooks.log
```

---

## Troubleshooting

**Facts not showing up in Claude**
1. Is the project opted in? → `cat .claude/team-memory.md` (run from project dir)
2. Is `TEAM_MEMORY_DIR` set correctly? → `echo $TEAM_MEMORY_DIR`
3. Does the index exist? → `ls ${TEAM_MEMORY_DIR:-~/.team-memory}/merged_index.db`
4. Test directly: `echo '{"prompt":"your search"}' | team-memory preprompt-hook`
5. Any hook errors? → `cat ${TEAM_MEMORY_DIR:-~/.team-memory}/hooks.log`

**`extract-bgc` processes nothing**
1. Is the project opted in AND registered locally? → `cat ${TEAM_MEMORY_DIR:-~/.team-memory}/opted-in-projects.json`
2. Re-register: `cd ~/repos/my-project && team-memory opt-in`

**Wrong TEAM_MEMORY_DIR being used**
- Claude Code inherits env vars from the shell that launched it
- If you added it to `~/.zshrc` after launching Claude Code, restart Claude Code
- Verify: `echo '{"prompt":"test"}' | team-memory preprompt-hook` — check which index it reads from

**Hooks not firing after update**
```bash
team-memory update --no-rebuild
# Then restart Claude Code to pick up the new settings.json
```
