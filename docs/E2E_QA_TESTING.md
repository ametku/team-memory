# E2E QA: Full Flow (From Scratch)

Complete end-to-end test covering repo creation through facts surfacing in a Claude session.

## Prerequisites

- Node.js installed
- `gh` CLI authenticated (`gh auth status`)
- `git config user.name` set
- This repo built: `cd /Users/ametku/Documents/dev/experiments/team-memory && npm run build && npm link`

---

## Step 1 — Initialize a new team-memory repo

```bash
team-memory init --org <your-gh-org> --repo team-memory-test
```

**Verify:**

```bash
# Repo created on GitHub -- <QA NOTE: yes>
gh repo view <your-gh-org>/team-memory-test

# Local clone exists
ls ~/.team-memory/
# Expected: README.md, config.yaml, facts/, interactions/, .git/

# Developer DBs initialized
ls ~/.team-memory/facts/facts-*.db
ls ~/.team-memory/interactions/interactions-*.db

# Merged index built
ls ~/.team-memory/merged_index.db

# Post-merge hook installed
cat ~/.team-memory/.git/hooks/post-merge
# Expected: contains "team-memory rebuild-index"

# Claude hooks installed
jq '.hooks.UserPromptSubmit' ~/.claude/settings.json
# Expected: contains "team-memory preprompt-hook"
jq '.hooks.SessionEnd' ~/.claude/settings.json
# Expected: contains "run /extract-facts before quitting"

# Extract-facts skill installed
ls ~/.claude/skills/extract-facts/SKILL.md
```

---

## Step 2 — Add a fact

```bash
export TEAM_MEMORY_DIR=~/.team-memory

team-memory add \
  "Our API rate limit is 1000 req/min per client. Use X-RateLimit-Remaining header to check." \
  --project "backend-api" \
  --tags '["category:convention","rate-limit","api"]'
```

**Verify:**

```bash
# Fact committed to git
git -C ~/.team-memory log --oneline -1
# Expected: commit message like "feat: add fact <uuid>"

# Fact queryable
team-memory query "rate limit"
# Expected: shows the fact with trust score
```

---

## Step 3 — Rebuild the merged index

```bash
team-memory rebuild-index
```

**Verify:**

```bash
# Output shows stats
# Expected: "Rebuilt index: 1 dev DBs, 1 facts indexed in X.XXs"

# Query still works against rebuilt index
team-memory query "rate limit"
```

---

## Step 4 — Push facts to remote

```bash
team-memory sync --push
```

**Verify:**

```bash
# Local commits pushed
git -C ~/.team-memory log --oneline origin/main..HEAD
# Expected: empty (nothing ahead of remote)

gh repo view <your-gh-org>/team-memory-test --json defaultBranchRef
```

---

## Step 5 — Verify preprompt hook surfaces facts in Claude

Start a Claude Code session in any project that has the hook configured:

```bash
claude
```

Type a prompt related to the fact:

> "What's our API rate limit?"

**Verify:**

- The system prompt / `additionalContext` block shows `--- Team Memory Facts ---`
- Your rate limit fact appears in the context

---

## Step 6 — Add another fact and verify retrieval

```bash
team-memory add \
  "Deploy process: merge to main triggers CI, then auto-deploys to staging. Prod requires manual approval in ArgoCD." \
  --project "infra" \
  --tags '["category:convention","deploy","ci"]'

team-memory rebuild-index
```

Then in Claude, prompt:

> "How do we deploy to prod?"

**Verify:** The deploy fact surfaces in the context.

---

## Cleanup

```bash
# Remove local clone
rm -r ~/.team-memory

# Delete remote repo
gh repo delete <your-gh-org>/team-memory-test --yes

# Remove Claude hooks (optional — they're harmless without the repo)
# Edit ~/.claude/settings.json manually if desired
```

---

## Success Criteria

| Check | Expected |
|-------|----------|
| `init` creates GitHub repo | Private repo on the org |
| Local clone has facts/ and interactions/ dirs | Both present with .db files |
| Post-merge hook installed | `post-merge` file in `.git/hooks/` |
| Claude preprompt hook installed | Entry in `~/.claude/settings.json` |
| `add` commits a fact | New commit in the memory repo |
| `rebuild-index` updates merged_index.db | File timestamp changes |
| `query` returns relevant facts | Matching facts with trust scores |
| `sync --push` pushes to remote | No local-only commits remain |
| Preprompt hook surfaces facts in Claude | `--- Team Memory Facts ---` in context |
