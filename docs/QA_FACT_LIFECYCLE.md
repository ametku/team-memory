# QA: Fact Lifecycle (Reject, Prune, Rebuild-Index)

Assumes base setup is complete (`team-memory init` or `join` done, facts exist).

---

## Test: `reject` — Mark a fact as incorrect

```bash
# First, add a fact we'll reject
team-memory add "Deploy on Fridays is fine" \
  --project "ops" \
  --tags '["category:convention","deploy"]'
# Note the returned fact ID (e.g., abc123)

# Reject it
team-memory reject <fact-id>
```

**Verify:**

```bash
# Output confirms rejection
# Expected: "Rejected fact <id>: Deploy on Fridays is fine"

# Interactions DB records explicit_score = -1
# (commit created in interactions/)
git -C ~/.team-memory log --oneline -1
# Expected: "feat: reject fact <id>"

# Fact still exists in facts DB but has negative interaction score
team-memory query "deploy friday"
# Expected: fact appears but with lower trust score
```

---

## Test: `reject` — Unknown fact ID

```bash
team-memory reject nonexistent-id-12345
# Expected: "Error: Fact not found: nonexistent-id-12345"
# Exit code: 1
```

---

## Test: `prune --dry-run` — Preview what would be pruned

```bash
team-memory prune --dry-run
```

**Verify:**

- Lists facts that meet prune criteria (rejected with net score <= -2, never-surfaced > 6 months, stale)
- No actual deletions occur
- No git commit created

```bash
git -C ~/.team-memory log --oneline -1
# Expected: NOT a prune commit
```

---

## Test: `prune` — Actually remove stale facts

To trigger pruning, reject a fact twice (from two sources or simulate):

```bash
# Add and reject a fact to get net_explicit <= -2
team-memory add "Use tabs not spaces" --tags '["category:convention"]'
# Note ID

team-memory reject <id>
team-memory reject <id>
# Second reject is idempotent on score but ensures -1

# For testing "never-surfaced" pruning: the fact must be > 6 months old
# (hard to test without time manipulation — skip in manual testing)

team-memory prune
```

**Verify:**

```bash
# Shows pruned facts
# Expected: "Pruned N fact(s):" with reason "(rejected)"

# Git commit created
git -C ~/.team-memory log --oneline -1
# Expected: "chore: prune N facts"

# Pruned fact no longer appears in queries
team-memory query "tabs spaces"
# Expected: no results
```

---

## Test: `prune` — Nothing to prune

```bash
# After pruning, run again
team-memory prune
# Expected: "Nothing to prune."
```

---

## Test: `rebuild-index` — Fresh rebuild

```bash
# Delete the index and rebuild
rm ~/.team-memory/merged_index.db

team-memory rebuild-index
```

**Verify:**

```bash
# Output shows stats
# Expected: "Rebuilt index: N dev DBs, M facts indexed in X.XXs"

# Index file recreated
ls ~/.team-memory/merged_index.db

# Queries work after rebuild
team-memory query "api"
```

---

## Test: `rebuild-index` — Multiple dev DBs

```bash
# If you have a multi-dev setup (from QA_SYNC_AND_MULTI_DEV)
team-memory rebuild-index
# Expected: "Rebuilt index: 2 dev DBs, N facts indexed..."
# The count should reflect ALL developers' facts
```

---

## Test: `rebuild-index` — Empty facts directory

```bash
# Create a temp repo with no facts
mkdir /tmp/empty-memory && cd /tmp/empty-memory && git init
mkdir facts interactions

TEAM_MEMORY_DIR=/tmp/empty-memory \
TEAM_MEMORY_INDEX_PATH=/tmp/empty-memory/merged_index.db \
  team-memory rebuild-index
# Expected: "Rebuilt index: 0 dev DBs, 0 facts indexed..."
```

**Cleanup:**

```bash
rm -r /tmp/empty-memory
```

---

## Test: `query --project` — Project-scoped queries

```bash
# Add facts to different projects
team-memory add "Redis cache TTL is 5 minutes" \
  --project "backend-api" \
  --tags '["category:convention","redis","cache"]'

team-memory add "Use Tailwind, not raw CSS" \
  --project "frontend" \
  --tags '["category:convention","css","tailwind"]'

team-memory rebuild-index

# Query scoped to a project
team-memory query "convention" --project "backend-api"
# Expected: only shows backend-api facts
```

---

## Test: `query --limit` — Result count control

```bash
# Add several facts, then limit
team-memory query "convention" --limit 1
# Expected: only 1 result returned

team-memory query "convention" --limit 10
# Expected: up to 10 results
```

---

## Success Criteria

| Command | Scenario | Expected |
|---------|----------|----------|
| `reject` | Valid fact ID | Score set to -1, commit created |
| `reject` | Invalid ID | Error message, exit 1 |
| `prune --dry-run` | Has pruneable facts | Lists them, no commit |
| `prune` | Rejected facts (score <= -2) | Deletes from DB, commits |
| `prune` | Nothing to prune | "Nothing to prune." |
| `rebuild-index` | Normal | Rebuilds from all dev DBs |
| `rebuild-index` | After deletion | Index file recreated |
| `query` | With `--limit` | Respects limit |
