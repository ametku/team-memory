# Changelog

## v0.2.0 — 2026-06-13

### New features

- **`team-memory update`** — self-update command: pulls latest CLI source, rebuilds binary, wipes and reinstalls all Claude Code hooks, force-updates the extract-facts skill, and syncs team facts. Use `--no-rebuild` to skip the git pull + build step and only refresh hooks/skill/facts.

- **`extract-bgc`** — Claude-native background fact extraction. Processes past completed sessions using the `claude --print` binary (no API key needed). Queues facts to `pending-facts.json` for human review. Respects session safety gates (active sentinel, clean-end marker, 30-min crash safety). Run `team-memory review-pending` to approve/reject queued facts.

- **`extract-slack`** — extracts facts from Slack threads matching prompts queued during live sessions. Requires `SLACK_TOKEN` and `NERD_COMPLETION_API_KEY`. The preprompt hook silently queues qualifying prompts (questions, debug signals, architecture decisions) for this command to process.

- **Idle extract-facts hook** (`Stop` event, `asyncRewake`) — after 2 minutes of idle, fires `/extract-facts` automatically so facts are never lost. 10-minute per-session cooldown prevents interruptions during active work. Scoped to `$PPID` so concurrent sessions never interfere.

- **`session-start` hook** — marks the session active (safety gate for `extract-bgc`) and notifies if pending facts are queued from past sessions.

- **`session-deactivate` hook** — called at `SessionEnd`: removes the active sentinel, creates a clean-end marker, and marks the session in `processed-sessions-bgc.json` so `extract-bgc` never reprocesses a session already handled by `/extract-facts`.

- **`review-pending`** — interactive approval flow for facts queued by `extract-bgc`. Presented per-project at session start.

### Bug fixes

- **Critical: `idle.sh` never got `+x` permission** — `require("fs")` in an ESM module silently failed, so `chmodSync` was never called and the idle hook never fired. Fixed by using the statically imported `chmodSync`.
- `rewakeMessage` said "45 seconds" but the script uses `IDLE_SECS=120` — corrected to "2 minutes".
- Dead `deriveProject()` function in `extract-bgc` — deleted.
- Dynamic `await import('fs/path/os')` inside async function — replaced with already-present static imports.
- `execSync` with template literals in `add.ts` and `surface-logging.ts` — replaced with `execFileSync` array args to prevent shell injection when developer names contain spaces or quotes.
- `sync`: push was happening before pull — reordered to pull first, preventing non-fast-forward failures when remote had diverged.
- `pending-facts`: IDs used `Math.random()` — replaced with `nanoid(8)` for consistency.
- `query`: silent double-negative `bm25 * trust` ordering — added explanatory comment.
- `--version` returned hardcoded `"0.1.0"` string — now reads from `package.json`.
- `update`/`extract-slack` missing indent in `--help` USAGE output — fixed.
- `init`/`join`/`update` output improved to list every installed artifact (DB paths, hook locations, skill path).

### Upgrade from v0.1.0

See [upgrading from v0.1.0](#upgrading-from-v010) below.

---

## v0.1.0 — initial release

- Core fact lifecycle: `add`, `query`, `reject`, `prune`, `rebuild-index`, `sync`
- Per-developer SQLite files (`facts-<dev>.db`, `interactions-<dev>.db`) synced via git
- FTS5 merged index with precomputed trust score (`bm25 * trust` ranking)
- `preprompt-hook` for Claude Code `UserPromptSubmit` — injects relevant facts as `additionalContext`
- `install-hook` — post-merge git hook for automatic index rebuild on pull
- `init` / `join` — onboard a new team or join an existing one
- `opt-in` — opt a project into team-memory fact extraction
- `extract-bg` — background extraction via NerdCompletion API (requires `NERD_COMPLETION_API_KEY`)
- `dashboard` — self-contained HTML fact browser with Team / Members / Tags views

---

## Upgrading from v0.1.0

### If you already have `team-memory update` (rare — only if you're on this branch)

```bash
team-memory update
```

That's it. It pulls the latest source, rebuilds, reinstalls all hooks, and syncs facts.

---

### If you do NOT have `team-memory update` (most people on v0.1.0)

This is the common case. v0.1.0 shipped without the `update` command, so you'll need to upgrade manually once, then use `team-memory update` going forward.

**Step 1 — find your CLI source directory**

```bash
grep cli_source ~/.team-memory/config.yaml
```

If that key exists, `cd` to the printed path. If it doesn't, you cloned the source somewhere manually — find it:

```bash
which team-memory          # e.g. /usr/local/bin/team-memory
ls -la $(which team-memory) # shows where the symlink points
```

Navigate to the project root (the directory that contains `package.json`).

**Step 2 — pull and rebuild**

```bash
cd <cli-source-dir>    # the directory from step 1
git pull
npm run build
npm link               # re-link the binary to the rebuilt dist/
```

**Step 3 — reinstall hooks and sync**

```bash
team-memory update --no-rebuild
```

This wipes any old/stale hooks across every Claude Code hook event type and installs the three current hooks:
- `UserPromptSubmit` → `team-memory preprompt-hook`
- `SessionEnd` → reminder to run `/extract-facts`
- `Stop` (idle) → `~/.team-memory/hooks/idle.sh` (2-min idle, 10-min cooldown, `asyncRewake`)

It also force-updates the `extract-facts` skill and syncs team facts from the remote.

**Step 4 — verify**

```bash
team-memory --version   # should print 0.2.0
```

Check `~/.claude/settings.json` — you should see all three hook entries. Check `~/.team-memory/hooks/idle.sh` exists and is executable (`ls -la ~/.team-memory/hooks/idle.sh`).

---

### What you get after upgrading

| Feature | v0.1.0 | v0.2.0 |
|---|---|---|
| `team-memory update` | — | ✓ |
| `extract-bgc` (no API key) | — | ✓ |
| `extract-slack` | — | ✓ |
| Idle auto extract-facts hook | — | ✓ (2 min idle) |
| `session-start` / `session-deactivate` hooks | — | ✓ |
| `review-pending` fact queue | — | ✓ |
| `idle.sh` actually executable | broken | fixed |
| Shell-safe git commands (`execFileSync`) | broken | fixed |
| `sync` pull-before-push | broken | fixed |
| Version from `package.json` | hardcoded | live |
