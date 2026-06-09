# QA: `extract-bg --dry-run`

Assumes `NERD_COMPLETION_API_KEY` is set and at least one Claude Code session exists in `~/.claude/projects/`.

---

## Pre-flight

```bash
# Verify API key is set
echo $NERD_COMPLETION_API_KEY
# Expected: NCT-... (non-empty)

# Verify sessions exist
ls ~/.claude/projects/**/*.jsonl | head -5
# Expected: at least one .jsonl file

# Confirm state file does NOT exist yet (first run)
ls ~/.team-memory/processed-sessions.json
# Expected: No such file (dry-run will not create it)
```

---

## Test 1: Missing API key → fail fast

```bash
NERD_COMPLETION_API_KEY= team-memory extract-bg --dry-run
```

**Verify:**
- Output: `Error: NERD_COMPLETION_API_KEY is not set.`
- Exit code: `1`

---

## Test 2: Normal dry-run launch

```bash
team-memory extract-bg --dry-run
```

**Verify first lines:**
```
[extract-bg] found 1 session(s) to process
[extract-bg] parsing <uuid>.jsonl (project: <project-name>)
[dry-run] Session: /Users/<you>/.claude/projects/.../<uuid>.jsonl
[dry-run] Parse this session and extract conversation text? (y/n):
```

- Exactly **one** session is shown (most recent by mtime — not all of them)
- Log prefix is `[extract-bg]` on every line
- Prompt ends with `(y/n):`

---

## Test 3: Decline parse → skips cleanly

At the parse prompt, enter `n`:

```
[dry-run] Parse this session and extract conversation text? (y/n): n
```

**Verify:**
- Output: `[extract-bg] skipped.`
- Process exits with code `0`
- State file NOT created: `ls ~/.team-memory/processed-sessions.json` → No such file

---

## Test 4: Accept parse, decline API call

At the parse prompt enter `y`, at the API prompt enter `n`:

```
[dry-run] Parse this session and extract conversation text? (y/n): y
[extract-bg] extracted N turns, X chars (truncated: yes/no)
[dry-run] Extracted N turns, X chars.
[dry-run] Send to NerdCompletion (claude-4-5-sonnet)? (y/n): n
```

**Verify:**
- `[extract-bg] extracted N turns, X chars (truncated: yes/no)` appears after parse
- `N` > 0, `X` > 0
- After `n`: output is `[extract-bg] skipped API call.` and exits `0`
- State file NOT created

---

## Test 5: Full dry-run — accept all, facts found

Accept parse (`y`), accept API call (`y`), accept each fact (`y`):

**Verify API call log:**
```
[extract-bg] calling NerdCompletion (model: claude-4-5-sonnet, X chars)
[extract-bg] response: HTTP 200 in Xms
[extract-bg] extracted N facts
```

**Verify per-fact prompt:**
```
[dry-run] Fact 1/N:
  content: "..."
  tags:    ["category:...", "...", "..."]
  project: <project-name>
[dry-run] Save this fact? (y/n):
```

After `y` for a fact:
```
[dry-run] would run: team-memory add "..." --project <project> --tags '[...]'
```

**After all facts:**
```
[dry-run] done. No changes written.
```

**Verify nothing was saved:**
```bash
# State file still absent
ls ~/.team-memory/processed-sessions.json
# Expected: No such file

# No new facts in the DB
team-memory query "any keyword from extracted fact"
# Expected: 0 results (fact was not saved)

# No new git commit
git -C ~/.team-memory log --oneline -1
# Expected: commit unchanged from before the run
```

---

## Test 6: Full dry-run — decline individual facts

Accept parse and API call, then enter `n` for each fact:

**Verify:**
- Each declined fact shows `[extract-bg] skipped fact.`
- After all: `[dry-run] done. No changes written.`
- Nothing saved (same checks as Test 5)

---

## Test 7: Full dry-run — 0 facts extracted

If the session has no extractable facts, the model returns `{ "facts": [] }`:

**Verify:**
```
[extract-bg] extracted 0 facts
[dry-run] done. No changes written.
```

- No fact prompts shown
- Process exits `0`

---

## Test 8: No sessions found

```bash
# Point to an empty projects dir
HOME=/tmp team-memory extract-bg --dry-run
```

**Verify:**
```
[extract-bg] no sessions found.
```

Exit code: `0`

---

## Test 9: Truncation log

For a very long session (unlikely in manual testing — confirm by checking log output):

```
[extract-bg] extracted N turns, X chars (truncated: yes)
```

- If truncated, `X` ≤ 1,048,576

---

## Success Criteria

| Scenario | Expected |
|----------|----------|
| Missing API key | `Error: NERD_COMPLETION_API_KEY is not set.` + exit 1 |
| Decline parse | `[extract-bg] skipped.` + exit 0 |
| Decline API call | `[extract-bg] skipped API call.` + exit 0 |
| Decline a fact | `[extract-bg] skipped fact.` + continues to next |
| Accept all | `[dry-run] would run: team-memory add ...` per fact |
| After any dry-run | State file not created, no facts saved, no git commit |
| End of run | `[dry-run] done. No changes written.` |
| No sessions | `[extract-bg] no sessions found.` + exit 0 |
| 0 facts extracted | `[extract-bg] extracted 0 facts` + exits cleanly |
