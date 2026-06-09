# QA: Hooks, Skills & Session Lifecycle

Assumes base setup is complete (`team-memory init` or `join` done, Claude hooks installed).

---

## Test: Preprompt hook — Facts injected on relevant prompts

```bash
# Ensure you have facts and a built index
team-memory query "deploy"
# Should return at least one fact

# Start Claude Code in any project
claude
```

Prompt:

> "How do we deploy?"

**Verify:**

- You see `--- Team Memory Facts ---` in the system context
- Relevant deploy facts appear
- Claude's response incorporates the fact

---

## Test: Preprompt hook — No facts for unrelated prompts

In the same Claude session, prompt:

> "What's 2 + 2?"

**Verify:**

- No `--- Team Memory Facts ---` block appears (or it's empty)
- The hook returns `{ "continue": true }` without `additionalContext`

---

## Test: Preprompt hook — Missing index file

```bash
# Temporarily rename the index
mv ~/.team-memory/merged_index.db ~/.team-memory/merged_index.db.bak

# Run preprompt manually
echo '{"prompt":"deploy"}' | team-memory preprompt-hook
# Expected: {"continue":true}  (no additionalContext, no error)

# Restore
mv ~/.team-memory/merged_index.db.bak ~/.team-memory/merged_index.db
```

---

## Test: Preprompt hook — Malformed input

```bash
echo 'not json' | team-memory preprompt-hook
# Expected: {"continue":true}  (graceful fallback, no crash)

echo '{}' | team-memory preprompt-hook
# Expected: {"continue":true}  (empty prompt = no results)
```

---

## Test: `session-end` — Commit interaction logs

After a Claude session where facts were surfaced:

```bash
team-memory session-end
```

**Verify:**

```bash
# If interactions accumulated, a commit is created
git -C ~/.team-memory log --oneline -1
# Expected: "chore: update interactions" (if there were surfaces)

# If no new interactions, no commit
team-memory session-end
# Expected: no output, no new commit
```

---

## Test: SessionEnd hook — Reminder fires on quit

Start and quit a Claude session:

```bash
claude
# type /quit or Ctrl+D
```

**Verify:**

Terminal output includes:

```
team-memory: run /extract-facts before quitting to save anything worth keeping.
```

---

## Test: `/extract-facts` skill — End-to-end

1. Open Claude Code in any project
2. Have a conversation with fact-worthy moments:
   - Correct Claude on something: "No, we use pnpm here, not npm"
   - State a convention: "Always run `db:migrate` before starting the dev server"
3. Type `/extract-facts`

**Verify:**

- Agent reviews conversation and proposes 0–3 candidates
- Each candidate has: `content`, `project` (auto-detected from repo name), `tags`
- Tags follow format: `["category:<enum>", "kw1", "kw2", "kw3"]`
- You get an approve/edit/reject prompt per candidate
- Approved facts run `team-memory add ... --project ... --tags '...'`
- After all candidates: a single `team-memory sync --push`

```bash
git -C ~/.team-memory log --oneline | head -5
# Expected: one commit per approved fact, then push
```

---

## Test: `/extract-facts` — Empty session

```bash
# Start fresh session, immediately invoke
claude
# type: /extract-facts
```

**Verify:** Response is "Nothing worth saving from this session." — no commits.

---

## Test: `/extract-facts` — Not in a git repo

```bash
cd /tmp && claude
# Have a short conversation, then /extract-facts
```

**Verify:** Proposals omit `--project` flag (fact saved as team-wide).

---

## Test: Surface logging — Interactions tracked

```bash
# Query something that matches existing facts
echo '{"prompt":"rate limit"}' | team-memory preprompt-hook

# Check interactions DB was updated
sqlite3 ~/.team-memory/interactions/interactions-$(git config user.name | tr ' ' '-').db \
  "SELECT fact_id, surface_count FROM interactions ORDER BY surface_count DESC LIMIT 5;"
# Expected: shows the fact ID with incremented surface_count
```

---

## Test: Claude hook installation — Idempotency

```bash
# Run init or join again (or manually invoke the hook installer)
# The simplest way: rebuild from source
node dist/cli.js init --org test --repo test2 --dir /tmp/idempotency-test 2>/dev/null || true

# Check no duplicate hooks
jq '.hooks.UserPromptSubmit | length' ~/.claude/settings.json
# Expected: 1

jq '.hooks.SessionEnd | length' ~/.claude/settings.json
# Expected: 1
```

---

## Test: Skill file content

```bash
head -5 ~/.claude/skills/extract-facts/SKILL.md
# Expected: starts with "---" frontmatter with "name: extract-facts"

grep -c "category:" ~/.claude/skills/extract-facts/SKILL.md
# Expected: >= 1 (skill mentions category types)
```

---

## Success Criteria

| Component | Scenario | Expected |
|-----------|----------|----------|
| Preprompt hook | Relevant prompt | Facts in `additionalContext` |
| Preprompt hook | Unrelated prompt | No facts injected |
| Preprompt hook | Missing index | Graceful no-op |
| Preprompt hook | Malformed input | Returns `{"continue":true}` |
| `session-end` | Has interactions | Commit created |
| `session-end` | No interactions | No-op |
| SessionEnd hook | Quit Claude | Reminder printed |
| `/extract-facts` | Conversation with facts | Proposes candidates, commits approved |
| `/extract-facts` | Empty session | "Nothing worth saving" |
| Surface logging | Fact surfaced | `surface_count` incremented |
| Hook install | Re-run | No duplicate entries |
