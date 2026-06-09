# QA: Sync, Join & Multi-Developer Scenarios

Assumes base setup is complete (a team-memory repo exists on GitHub with at least one fact).

---

## Test: `join` — Second developer onboards

Simulates a second developer joining the memory repo.

```bash
# Use a different directory to simulate dev 2
TEAM_MEMORY_DIR=/tmp/dev2-memory \
  team-memory join https://github.com/<org>/<repo>.git --dir /tmp/dev2-memory
```

**Verify:**

```bash
# Clone exists with existing facts
ls /tmp/dev2-memory/facts/
# Expected: facts-<original-dev>.db AND facts-<dev2>.db

# Dev 2's own DBs created
ls /tmp/dev2-memory/facts/facts-$(git config user.name | tr ' ' '-').db
ls /tmp/dev2-memory/interactions/interactions-$(git config user.name | tr ' ' '-').db

# Merged index built (contains dev 1's facts)
TEAM_MEMORY_DIR=/tmp/dev2-memory \
TEAM_MEMORY_INDEX_PATH=/tmp/dev2-memory/merged_index.db \
  team-memory query "rate limit"
# Expected: returns dev 1's fact

# Post-merge hook installed
cat /tmp/dev2-memory/.git/hooks/post-merge

# Claude hooks installed (idempotent — no duplicates)
jq '.hooks.UserPromptSubmit | length' ~/.claude/settings.json
# Expected: 1 (not 2)
```

---

## Test: `join` — Idempotent re-run

```bash
# Should fail because dir already exists
TEAM_MEMORY_DIR=/tmp/dev2-memory \
  team-memory join https://github.com/<org>/<repo>.git --dir /tmp/dev2-memory
# Expected: Error "Directory already exists"
```

---

## Test: `sync` — Pull remote changes

Simulate dev 1 pushing a new fact, then dev 2 pulling:

```bash
# Dev 1 adds a fact
team-memory add "Friday standup is at 9:30am PT" \
  --project "team" \
  --tags '["category:convention","standup"]'
team-memory sync --push

# Dev 2 syncs
TEAM_MEMORY_DIR=/tmp/dev2-memory \
TEAM_MEMORY_INDEX_PATH=/tmp/dev2-memory/merged_index.db \
  team-memory sync
```

**Verify:**

```bash
# Dev 2 can now query the new fact
TEAM_MEMORY_DIR=/tmp/dev2-memory \
TEAM_MEMORY_INDEX_PATH=/tmp/dev2-memory/merged_index.db \
  team-memory query "standup"
# Expected: returns the standup fact
```

---

## Test: `sync --push` — Dev 2 contributes facts

```bash
# Dev 2 adds their own fact
TEAM_MEMORY_DIR=/tmp/dev2-memory \
TEAM_MEMORY_INDEX_PATH=/tmp/dev2-memory/merged_index.db \
  team-memory add "Use pnpm, not npm — npm causes lockfile drift" \
  --project "tooling" \
  --tags '["category:gotcha","pnpm","npm"]'

# Dev 2 pushes
TEAM_MEMORY_DIR=/tmp/dev2-memory \
TEAM_MEMORY_INDEX_PATH=/tmp/dev2-memory/merged_index.db \
  team-memory sync --push

# Dev 1 syncs and sees it
team-memory sync
team-memory query "pnpm"
# Expected: returns dev 2's fact
```

---

## Test: `sync` — Pull fails gracefully (offline)

```bash
# Simulate no network by using a bad remote
cd /tmp/dev2-memory && git remote set-url origin https://invalid.example.com/nope.git

TEAM_MEMORY_DIR=/tmp/dev2-memory \
TEAM_MEMORY_INDEX_PATH=/tmp/dev2-memory/merged_index.db \
  team-memory sync
# Expected: "Warning: pull failed, rebuilding from local cache"
# Index still rebuilds from local facts

# Restore remote
cd /tmp/dev2-memory && git remote set-url origin https://github.com/<org>/<repo>.git
```

---

## Test: Post-merge hook auto-rebuilds index

```bash
cd /tmp/dev2-memory

# Simulate a git pull triggering the post-merge hook
git pull origin main
# Expected: post-merge hook runs rebuild-index automatically

# Verify index is current
TEAM_MEMORY_DIR=/tmp/dev2-memory \
TEAM_MEMORY_INDEX_PATH=/tmp/dev2-memory/merged_index.db \
  team-memory query "standup"
```

---

## Test: Concurrent adds (no conflict)

Both devs add facts simultaneously — each writes to their own `.db` file, so no merge conflicts.

```bash
# Dev 1
team-memory add "Never force-push to main" --tags '["category:convention","git"]'

# Dev 2 (at the same time)
TEAM_MEMORY_DIR=/tmp/dev2-memory \
  team-memory add "Run migrations before deploy" --tags '["category:convention","deploy"]'

# Both push
team-memory sync --push
TEAM_MEMORY_DIR=/tmp/dev2-memory \
TEAM_MEMORY_INDEX_PATH=/tmp/dev2-memory/merged_index.db \
  team-memory sync --push
# Expected: no merge conflicts — different files
```

---

## Cleanup

```bash
rm -r /tmp/dev2-memory
```
