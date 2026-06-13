# QA: `team-memory extract-bgc`

Assumes `TEAM_MEMORY_DIR` is set, at least one project is opted in, and `claude` CLI is on PATH (Claude Code company auth active).

---

## Pre-flight

```bash
# Verify opted-in projects exist
cat $TEAM_MEMORY_DIR/opted-in-projects.json

# Verify claude is available
claude --version

# Check for past sessions from opted-in projects
ls ~/.claude/projects/ | head -5
```

---

## Test 1: Dry run — preview without writing

```bash
team-memory extract-bgc --dry-run
```

**Expected:**
```
[extract-bgc] found N session(s) to process
[extract-bgc] parsing <uuid>.jsonl (project: media-streaming-ui)
[extract-bgc] extracted 2 turns, 1234 chars
[dry-run] Fact: "avgStartTime uses LEFT JOIN to exclude pre-roll ad duration"
[dry-run] Tags: ["category:convention","nrql","video"]
[dry-run] done. No changes written.
```

`pending-facts.json` must NOT be created or modified.

---

## Test 2: Active session is never touched

```bash
# Open a Claude session in a terminal (keep it open)
cd ~/repos/media-streaming-ui && claude &

# In another terminal — run extract-bgc
team-memory extract-bgc --dry-run
```

**Expected:** The currently open session's JSONL file does NOT appear in the output. All other completed sessions are processed normally.

**Verify sentinel exists:**
```bash
ls /tmp/tm-active-*
# Should show the UUID of the open session
```

---

## Test 3: Clean exit — processed immediately (no 30-min wait)

```bash
# Open Claude, ask a question, then /exit
cd ~/repos/media-streaming-ui && claude
# Inside: ask one prompt, then type /exit

# Immediately run extract-bgc
team-memory extract-bgc --dry-run
```

**Expected:** The just-closed session IS found and processed — no waiting. The done marker (`/tmp/tm-done-<uuid>`) was created by SessionEnd, so Gate 2a passes immediately.

**Verify done marker exists:**
```bash
ls /tmp/tm-done-*
```

---

## Test 4: Facts queue per project

```bash
# Run real extraction
team-memory extract-bgc

# Check pending-facts.json — should be scoped to project
cat $TEAM_MEMORY_DIR/pending-facts.json
```

**Expected:**
```json
{
  "media-streaming-ui": [
    { "id": "abc123", "content": "...", "tags": [...], "session": "xyz.jsonl" }
  ]
}
```

Facts from `media-streaming-ui` sessions only appear under `"media-streaming-ui"`. Never cross-project.

---

## Test 5: review-pending — only shows current project's facts

```bash
# In media-streaming-ui
cd ~/repos/media-streaming-ui
! team-memory review-pending
```

**Expected:** shows only `media-streaming-ui` facts.

```bash
# In a different project
cd ~/repos/payments-service
! team-memory review-pending
```

**Expected:** "No pending facts for payments-service." — even if media-streaming-ui has pending facts.

---

## Test 6: Sessions not processed twice

```bash
team-memory extract-bgc   # first run — processes sessions, writes processed-sessions-bgc.json
team-memory extract-bgc   # second run
```

**Expected second run:** `[extract-bgc] no sessions ready to process (all are active, recent, or already done)` — nothing re-processed.

---

## Test 7: Sessions handled by /extract-facts are skipped

When `/extract-facts` runs at session end, SessionEnd hook marks the session UUID in `processed-sessions-bgc.json`. extract-bgc should not re-process those sessions.

```bash
# Verify the session UUID is in processed-sessions-bgc.json after a session ends
cat $TEAM_MEMORY_DIR/processed-sessions-bgc.json | python3 -m json.tool | grep "processed"
```

---

## Test 8: Loop mode

```bash
/loop 30m team-memory extract-bgc
```

**Expected:** runs every 30 minutes, picks up new sessions, skips already-processed ones. Exits cleanly when no new sessions remain.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "no sessions ready to process" | All sessions are active, recent (<30min), or already processed | Wait 30 min, or check that a clean-exit session exists |
| Facts from wrong project appear | Bug in project derivation | Check `opted-in-projects.json` encoding matches session dir name |
| Active session gets processed | Sentinel not created (SessionStart hook missing) | Run `team-memory update` to reinstall hooks |
| Same session processed twice | `processed-sessions-bgc.json` missing or corrupt | Delete it — extract-bgc will rebuild from scratch |
| `claude --print` fails | Claude CLI not on PATH or company auth expired | Re-authenticate Claude Code |
