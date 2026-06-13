# QA: Idle extract-facts hook

Assumes `team-memory` is on PATH and `~/.claude/settings.json` has the Stop hook installed.

## How the hook works

After every Claude response, a 45-second background timer starts. If no new response arrives in that time (session is idle), and `/extract-facts` has not run in the last 30 minutes, Claude is woken via `asyncRewake` and automatically runs `/extract-facts`.

Watch the log in real time to see every hook decision:
```bash
tail -f /tmp/tm-idle.txt
```

---

## Test 1: Verify hook is installed

```bash
python3 -m json.tool ~/.claude/settings.json | grep -A6 "asyncRewake"
```

**Expected:**
```json
"asyncRewake": true,
"rewakeMessage": "Session idle for 45 seconds..."
```

---

## Test 2: Idle triggers extract-facts

**Setup:**
```bash
# Clear cooldown so 30-min check passes immediately
rm -f /tmp/tm-last-extracted /tmp/tm-idle.txt
```

**Steps:**
1. Open a Claude Code session: `claude`
2. Send one prompt and wait for a response
3. Wait 45 seconds without typing anything
4. Watch the log: `tail -f /tmp/tm-idle.txt`

**Expected log output:**
```
[team-memory] 10:30:01 hook started, waiting 45s...
[team-memory] 10:30:46 idle + 30min elapsed — firing extract-facts
```

**Expected in Claude session:** Claude wakes and runs `/extract-facts` automatically.

---

## Test 3: Active session — hook does not fire

**Steps:**
1. Open a Claude Code session
2. Send prompts every 30 seconds (faster than the 45s idle threshold)
3. Check the log

**Expected log output:**
```
[team-memory] 10:31:00 hook started, waiting 45s...
[team-memory] 10:31:45 skipping (active or ran within 30min, elapsed=...)
```

Extract-facts does NOT run while you are actively working.

---

## Test 4: 30-minute cooldown — does not fire twice

**Steps:**
1. Clear only the old log, keep `/tmp/tm-last-extracted` intact from a recent run:
   ```bash
   rm -f /tmp/tm-idle.txt
   ```
2. Open a Claude session, send a prompt, wait 45 seconds

**Expected log:**
```
[team-memory] 10:35:01 hook started, waiting 45s...
[team-memory] 10:35:46 skipping (active or ran within 30min, elapsed=120s)
```

Extract-facts does NOT run again within 30 minutes of the last run.

---

## Test 5: Multiple sessions — each fires independently

**Setup:**
```bash
rm -f /tmp/tm-activity-* /tmp/tm-extracted-ppid-* /tmp/tm-idle.txt
tail -f /tmp/tm-idle.txt
```

**Steps:**
1. Open Session A in one terminal, send a prompt, then stop typing
2. Open Session B in another terminal within 10 seconds, send a prompt, keep Session B active
3. Wait 45 seconds

**Expected log (two different PPIDs):**
```
[team-memory] 10:40:01 [12345] hook started, waiting 45s...   ← Session A
[team-memory] 10:40:03 [67890] hook started, waiting 45s...   ← Session B
[team-memory] 10:40:46 [12345] idle + 30min — firing extract-facts  ← A fires ✅
[team-memory] 10:40:48 [67890] skipping (active or ran within 30min, elapsed=0s)  ← B quiet ✅
```

Session A fires because it's idle. Session B skips because it's active. The sessions are fully isolated — Session B's activity does **not** prevent Session A from detecting its own idle.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Log file not created | Hook not installed | Run `team-memory join` or manually add to `~/.claude/settings.json` |
| Always skipping (elapsed=0s) | Stale cooldown file | `rm /tmp/tm-extracted-ppid-*` |
| Session A never fires when Session B is active | Old version with global `/tmp/tm-last-activity` | Run `team-memory update` to get per-session activity file |
| Log shows `[1234PPID]` instead of `[1234]` | `$$PPID` double-dollar bug in old hook | Run `team-memory update` to reinstall clean hook |
| Fires every 45s repeatedly | `/tmp/tm-last-extracted` not being written | Check shell arithmetic syntax (`$((NOW - LAST))`) works on your shell |
| asyncRewake fires but no extract-facts | `rewakeMessage` not reaching Claude | Check `asyncRewake: true` is set in settings |
| Hook fires but `&` is in command | Old broken version | Re-run `team-memory join` to reinstall correct hook |
