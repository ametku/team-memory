# team-memory: Path Guide

There are **three separate directories** you need to understand. They are independent — each can live anywhere on your machine.

---

## The Three Directories

```
1. CLI source          where you cloned the team-memory source code
                       used once to build and install the binary

2. TEAM_MEMORY_DIR     the shared git repo — facts, logs, state
                       the core of the system, synced with teammates

3. Your project repos  the repos you work in day-to-day
                       each opted-in one gets a .claude/team-memory.md marker
```

They are **completely separate**. Opt-in markers go in your project repos. Facts and logs go in `TEAM_MEMORY_DIR`. The CLI source is just where you installed from.

---

## 1. CLI Source (one-time setup)

Clone anywhere — this is just your local copy of the code to build from.

```bash
git clone https://github.com/ametku/team-memory.git ~/team-memory-cli
cd ~/team-memory-cli
npm install && npm run build && npm link
```

After `npm link`, `team-memory` is a global binary. The source directory is remembered in `TEAM_MEMORY_DIR/config.yaml` as `cli_source` so `team-memory update` knows where to pull and rebuild from.

---

## 2. TEAM_MEMORY_DIR — the shared repo

This is the most important path. It is a git repository shared with your team, containing all the facts, logs, and state.

### Recommended paths

| Scenario | Suggested path |
|---|---|
| Default (hidden, out of the way) | `~/.team-memory` |
| Visible on Desktop | `~/Desktop/team-memory` |
| Hackathon / project-specific | `~/Desktop/afa-team-memory` |
| Multiple teams | `~/team-memory/my-team` and `~/team-memory/other-team` |

### Setting it

**Temporary (current terminal session):**
```bash
export TEAM_MEMORY_DIR=~/Desktop/afa-team-memory
team-memory query "something"
```

**Persistent (add to `~/.zshrc` or `~/.bashrc`):**
```bash
echo 'export TEAM_MEMORY_DIR=~/Desktop/afa-team-memory' >> ~/.zshrc
source ~/.zshrc
```

**When joining:**
```bash
# The --dir flag sets the location AND saves it to config.yaml
team-memory join https://github.com/org/team-memory.git --dir ~/Desktop/afa-team-memory

# Then add the export to your shell profile so every terminal picks it up
echo 'export TEAM_MEMORY_DIR=~/Desktop/afa-team-memory' >> ~/.zshrc
```

**Without setting the env var**, every command defaults to `~/.team-memory`. If you used `--dir` but didn't export the env var, you must prefix every command:
```bash
TEAM_MEMORY_DIR=~/Desktop/afa-team-memory team-memory query "something"
```

> **Tip:** Set it in your shell profile once and forget about it. Every terminal, every tool that inherits env vars (including Claude Code), will use the right path automatically.

### How the CLI resolves TEAM_MEMORY_DIR

```
1. TEAM_MEMORY_DIR env var           ← explicit, always wins
2. ~/.team-memory                    ← default fallback
```

### What lives in TEAM_MEMORY_DIR

```
TEAM_MEMORY_DIR/
├── facts/
│   ├── facts-Alice.db               ← Alice's authored facts (in git)
│   └── facts-Bob.db                 ← Bob's authored facts (in git)
├── interactions/
│   ├── interactions-Alice.db        ← Alice's surface counts + rejects (in git)
│   └── interactions-Bob.db
├── hooks/
│   ├── idle.sh                      ← macOS/Linux idle hook script
│   └── idle.ps1                     ← Windows idle hook script
├── merged_index.db                  ← local FTS5 query index (NOT in git)
├── dashboard.html                   ← generated on demand (NOT in git)
├── config.yaml                      ← developer name + cli_source path (in git)
├── opted-in-projects.json           ← project registry (NOT in git — machine-specific)
├── slack-queue.json                 ← queued prompts for extract-slack (NOT in git)
├── pending-facts.json               ← facts awaiting your review (NOT in git)
├── processed-sessions-bgc.json      ← dedup list for extract-bgc (NOT in git)
├── idle.txt                         ← idle hook log (NOT in git)
├── bgc.txt                          ← extract-bgc fact log (NOT in git)
├── slack.txt                        ← extract-slack fact log (NOT in git)
└── hooks.log                        ← Claude Code hook errors (NOT in git)
```

Files marked "NOT in git" are local to your machine. Files in `facts/` and `interactions/` are committed and synced with teammates.

---

## 3. Your Project Repos (opt-in)

These are the repos you actually work in. team-memory does **not** store data here — it only reads a small marker file to know the project is opted in.

### Opting in a project

```bash
cd ~/repos/my-service          # must be run from inside the project
team-memory opt-in
```

This creates one file: `my-service/.claude/team-memory.md`

```
my-service/
└── .claude/
    └── team-memory.md         ← opt-in marker (commit this!)
```

**Commit it so teammates are automatically opted in:**
```bash
git add .claude/team-memory.md
git commit -m "chore: opt into team-memory"
git push
```

Once committed, any teammate who has team-memory set up will have their Claude sessions from this project feed the shared fact store automatically.

### What opt-in does

- The `preprompt-hook` checks for this file before injecting facts. If missing → silently skips.
- `extract-bgc` only processes session transcripts from opted-in projects. If missing → session is ignored entirely.
- The project is registered in `TEAM_MEMORY_DIR/opted-in-projects.json` mapping its absolute path to the encoded session directory name Claude Code uses.

### Multiple projects

You can opt in as many projects as you want:

```bash
cd ~/repos/my-service    && team-memory opt-in
cd ~/repos/api-gateway   && team-memory opt-in
cd ~/repos/mobile-app    && team-memory opt-in
```

All of them will feed the same `TEAM_MEMORY_DIR`. Facts are tagged with `--project <name>` (the repo basename) so they stay scoped.

---

## How TEAM_MEMORY_INDEX_PATH works

The merged index is separate from the data repo — it's a local cache rebuilt from the facts.

```
Default: ~/.cache/team-memory/merged_index.db
Custom:  TEAM_MEMORY_INDEX_PATH=/path/to/merged_index.db
```

You rarely need to set this. It's only useful if you want the index in a different location (e.g. on a fast SSD while the data repo is on a network drive).

---

## Common setups

### Solo developer, default path

```bash
team-memory join https://github.com/org/team-memory.git
# uses ~/.team-memory automatically
# no env var needed
```

### Team, custom visible path

```bash
# Each developer runs:
team-memory join https://github.com/org/team-memory.git --dir ~/team-memory

# Add to ~/.zshrc:
export TEAM_MEMORY_DIR=~/team-memory

# Opt in your main project:
cd ~/repos/my-service
team-memory opt-in
git add .claude/team-memory.md && git commit -m "chore: opt into team-memory" && git push
```

### Multiple teams, multiple repos

```bash
# Team A
team-memory join https://github.com/org/team-a-memory.git --dir ~/team-a-memory

# Team B
team-memory join https://github.com/org/team-b-memory.git --dir ~/team-b-memory

# Switch between them per terminal:
export TEAM_MEMORY_DIR=~/team-a-memory
team-memory query "something"

export TEAM_MEMORY_DIR=~/team-b-memory
team-memory query "something"
```

### Hackathon / Desktop

```bash
team-memory join https://github.com/ametku/afa2026-team-memory.git \
  --dir ~/Desktop/afa-memory

echo 'export TEAM_MEMORY_DIR=~/Desktop/afa-memory' >> ~/.zshrc
source ~/.zshrc

# Opt in your hackathon project:
cd ~/repos/afa-project
team-memory opt-in
```

---

## Verifying your setup

```bash
# 1. Check which TEAM_MEMORY_DIR is active
echo $TEAM_MEMORY_DIR
# Should print your custom path, or empty (= ~/.team-memory)

# 2. Check the repo is there and has facts
ls $TEAM_MEMORY_DIR/facts/
# Should list facts-<name>.db files

# 3. Check opted-in projects
cat $TEAM_MEMORY_DIR/opted-in-projects.json
# Should list your project paths

# 4. Check hooks are installed
cat ~/.claude/settings.json | grep -A2 "team-memory"
# Should show preprompt-hook, session-start, session-deactivate, idle.sh

# 5. Check the idle script is executable
ls -la $TEAM_MEMORY_DIR/hooks/idle.sh
# Should show -rwxr-xr-x

# 6. Test the preprompt hook from an opted-in project
cd ~/repos/my-service
echo '{"prompt":"test query"}' | team-memory preprompt-hook
# Should return {"continue":true} or facts if any match

# 7. Check logs
tail -20 $TEAM_MEMORY_DIR/idle.txt    # idle hook activity
tail -20 $TEAM_MEMORY_DIR/bgc.txt     # extract-bgc facts queued
tail -20 $TEAM_MEMORY_DIR/hooks.log   # any hook errors
```

---

## Troubleshooting

**"merged_index.db not found"**
```bash
team-memory rebuild-index
# or
team-memory sync
```

**Facts not injecting in Claude**

1. Is the project opted in? `cat .claude/team-memory.md`
2. Is `TEAM_MEMORY_DIR` set? `echo $TEAM_MEMORY_DIR`
3. Does the index exist? `ls $TEAM_MEMORY_DIR/merged_index.db`
4. Test the hook directly: `echo '{"prompt":"your query"}' | team-memory preprompt-hook`
5. Check hook errors: `cat $TEAM_MEMORY_DIR/hooks.log`

**extract-bgc finds no sessions**

1. Is the project opted in? `cat .claude/team-memory.md`
2. Is it registered? `cat $TEAM_MEMORY_DIR/opted-in-projects.json`
3. Re-register: `cd ~/repos/my-project && team-memory opt-in`

**Hooks not firing (Claude Code)**

Run `team-memory update --no-rebuild` to wipe and reinstall all hooks fresh. Then verify:
```bash
cat ~/.claude/settings.json | grep -c "team-memory"
# Should print 5 (one per hook)
```
