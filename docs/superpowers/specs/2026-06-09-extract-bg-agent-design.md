# Spec: `team-memory extract-bg` — Background Fact Extraction Agent

**Date:** 2026-06-09
**Status:** Ready for implementation
**Stack:** TypeScript (existing team-memory CLI)

---

## Overview

`team-memory extract-bg` is a new CLI subcommand that scans Claude Code session JSONL files, calls NerdCompletion to extract 0–3 facts per session, and saves them via the existing `team-memory add` CLI. It runs on-demand (manually or via cron) — no daemon, no file watcher.

---

## Modes

| Mode | Flag | Behavior |
|------|------|----------|
| Normal | _(none)_ | Processes all unprocessed sessions automatically. No prompts. |
| Dry-run | `--dry-run` | Processes **one session only**. Prompts for confirmation at each step. Nothing is saved or synced. State file is not modified. |

---

## Architecture

```
team-memory extract-bg [--dry-run]
      │
      ├── 1. Load state file: resolveRepoDir() + "/processed-sessions.json"
      │
      ├── 2. Scan ~/.claude/projects/ for *.jsonl files
      │       [dry-run] print list of all eligible files, pick the most recent one only
      │
      ├── 3. For each file (dry-run: just the one):
      │       a. [dry-run] confirm: "Parse this session? <path>" → y/n
      │          Parse JSONL → extract conversation text (user + assistant turns only)
      │          Log: turn count, total characters, truncated (yes/no)
      │
      │       b. [dry-run] confirm: "Send to NerdCompletion? (model: claude-4-5-sonnet, ~N chars)" → y/n
      │          POST to NerdCompletion /v1/chat/completions
      │          Log: HTTP status, response time, raw JSON response
      │
      │       c. Parse JSON → { facts: [{content, tags}] }
      │          Log: number of facts extracted
      │
      │       d. For each fact:
      │          [dry-run] confirm: "Save this fact? <content> | tags: <tags>" → y/n
      │          [normal]  execSync("team-memory add ...")
      │          [dry-run] print: "[dry-run] would run: team-memory add ..."
      │
      │       e. [normal] Update state file (mark processed or increment failure count)
      │          [dry-run] skip state update
      │
      └── 4. [normal]   execSync("team-memory sync --push")
             [dry-run]  print: "[dry-run] would run: team-memory sync --push"
```

---

## File Location in Codebase

| File | Purpose |
|------|---------|
| `src/extract-bg.ts` | Main implementation |
| `src/cli.ts` | Register new `extract-bg` subcommand |

No new dependencies required beyond Node.js built-ins (`fs`, `path`, `child_process`, `readline`).

`readline` is used for interactive confirmation prompts in dry-run mode.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NERD_COMPLETION_API_KEY` | Yes | — | NerdCompletion JWT token (`NCT-...`). Fail fast with clear error if missing. |
| `NERD_COMPLETION_BASE_URL` | No | `https://nerd-completion.staging-service.nr-ops.net` | NerdCompletion endpoint. |
| `TEAM_MEMORY_DIR` | No | `~/.team-memory` | Already used by `resolveRepoDir()` in `src/repo.ts`. |

---

## Session File Parsing

Claude Code stores sessions at:
```
~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
```
where `<encoded-project-path>` is the absolute project path with `/` replaced by `-`.

### What to extract

Only two JSONL entry types carry conversation signal:

**User entries** — include only when `message.content` is a plain string (skip arrays, which are tool results):
```json
{ "type": "user", "message": { "role": "user", "content": "plain text" } }
```

**Assistant entries** — include only `text` blocks from the content array (skip `thinking` and `tool_use` blocks):
```json
{ "type": "assistant", "message": { "content": [{ "type": "text", "text": "..." }] } }
```

Skip all other entry types: `mode`, `system`, `file-history-snapshot`, `attachment`, `tool_result`, `ai-title`, `pr-link`, `queue-operation`, `permission-mode`, `last-prompt`.

### Output format

Concatenate extracted turns chronologically with role prefixes:
```
[USER]: <content>

[ASSISTANT]: <text>

[USER]: ...
```

### Size cap

Apply a 1MB safety cap. If exceeded, truncate from the **top** (keep the end of the file — recent turns are where decisions land). After truncating, find the first `\n\n[` boundary so the output starts at a clean message.

### Extracting `--project`

Derive from the JSONL file's parent directory name (the encoded path), not from session content:

```typescript
const encoded = path.basename(path.dirname(jsonlPath));
// "-Users-ametku-Documents-dev-experiments-team-memory"
const project = encoded.split("-").at(-1);
// "team-memory"
```

---

## Logging

Every step emits a log line regardless of mode. Format: `[extract-bg] <message>`.

| Event | Log message |
|-------|-------------|
| Session discovered | `[extract-bg] found N unprocessed sessions` |
| Parsing a file | `[extract-bg] parsing <uuid>.jsonl (project: <project>)` |
| Parse result | `[extract-bg] extracted <N> turns, <X> chars (truncated: yes/no)` |
| API call start | `[extract-bg] calling NerdCompletion (model: claude-4-5-sonnet, <X> chars)` |
| API call result | `[extract-bg] response: HTTP <status> in <Xms>` |
| Facts found | `[extract-bg] extracted <N> facts` |
| Saving a fact | `[extract-bg] saving fact: "<content>"` |
| Fact saved | `[extract-bg] saved fact <id>` |
| Session done | `[extract-bg] marked <uuid>.jsonl as processed` |
| Failure | `[extract-bg] WARNING: <uuid>.jsonl failed (attempt <N>/3): <error>` |
| Sync | `[extract-bg] syncing...` |
| Done | `[extract-bg] done. <N> facts saved from <M> sessions.` |

---

## Dry-Run Confirmation Prompts

Implemented using Node.js `readline` (built-in, no extra dependency). Each prompt is `y/n` — any input other than `y` or `Y` is treated as `n`.

**Prompt 1 — before parsing:**
```
[dry-run] Session: ~/.claude/projects/-Users-.../4d7b7062.jsonl
[dry-run] Parse this session and extract conversation text? (y/n):
```
If `n`: print `[dry-run] skipped.` and exit.

**Prompt 2 — before API call:**
```
[dry-run] Extracted 42 turns, 8,320 chars.
[dry-run] Send to NerdCompletion (claude-4-5-sonnet)? (y/n):
```
If `n`: print `[dry-run] skipped API call.` and exit.

**Prompt 3 — before each fact (repeated per fact):**
```
[dry-run] Fact 1/2:
  content: "Use 'docker compose' (no hyphen) — Rancher Desktop does not support docker-compose"
  tags:    ["category:gotcha", "docker", "rancher", "cli"]
  project: team-memory
[dry-run] Save this fact? (y/n):
```
If `n`: print `[dry-run] skipped fact.` and move to next.
If `y`: print `[dry-run] would run: team-memory add "..." --project team-memory --tags '[...]'`

After all facts: print `[dry-run] done. No changes written.`

---

## NerdCompletion API Call

**Endpoint:** `POST ${NERD_COMPLETION_BASE_URL}/v1/chat/completions`

**Headers:**
```
Authorization: Bearer <NERD_COMPLETION_API_KEY>
Content-Type: application/json
```

**Request body:**
```json
{
  "model": "claude-4-5-sonnet",
  "response_format": { "type": "json_object" },
  "messages": [
    { "role": "system", "content": "<extraction prompt>" },
    { "role": "user", "content": "<conversation text>" }
  ]
}
```

### Extraction System Prompt

```
You are a fact extractor for a team knowledge base.

Review this Claude Code conversation and extract 0-3 facts worth saving.

A fact is a decision, correction, gotcha, or convention that emerged from
session friction — something Claude got wrong, something the developer had
to explicitly steer, a config that bit, a non-obvious dependency, or a
decision reached and the reason behind it.

DO capture:
- Corrections the user made ("no, use X not Y")
- Gotchas hit (a config that bit, a flaky step, a non-obvious dependency)
- Conventions enforced ("always do X in this repo")
- Decisions reached and the reason behind them

DO NOT capture:
- General documentation (belongs in CLAUDE.md / docs)
- Ephemeral state ("the deploy is broken right now")
- Personal taste not affecting the team
- Things obvious from reading the code
- Anything already in the conversation context as a known rule

If nothing in the conversation fits, return { "facts": [] }.

Return JSON in this exact shape:
{
  "facts": [
    {
      "content": "one declarative sentence, concrete and future-searchable",
      "tags": ["category:<enum>", "kw1", "kw2", "kw3"]
    }
  ]
}

Tag rules:
- Exactly one category tag: category:gotcha | category:convention | category:tool | category:workaround | category:decision
- 2-4 keyword tags: alternative search terms NOT already present as words in the content
```

### Parsing the response

```typescript
const body = await res.json();
const raw = body.choices[0].message.content;
const parsed = JSON.parse(raw); // { facts: [{content, tags}] }
```

Validate that `parsed.facts` is an array before iterating. If parsing fails or shape is wrong, treat as a failure (see error handling).

---

## Saving Facts

For each fact, shell out to the existing CLI:

```typescript
execSync(
  `team-memory add ${JSON.stringify(fact.content)} --project ${project} --tags '${JSON.stringify(fact.tags)}'`,
  { stdio: "inherit" }
);
```

This reuses all existing validation, tag normalization, SQLite insert, and git-commit logic.

---

## State File

**Location:** `resolveRepoDir() + "/processed-sessions.json"`
(respects `TEAM_MEMORY_DIR` env var via existing `src/repo.ts`)

**Format:**
```json
{
  "processed": ["4d7b7062-04b1-475d-84a6-97b5c48123fe.jsonl"],
  "failed": {
    "bad-session-uuid.jsonl": 3
  }
}
```

- `processed`: filenames (UUID only, not full path) of successfully processed sessions.
- `failed`: filename → attempt count. Once count reaches **3**, the file is skipped on future runs without further incrementing.

On first run, **backfill** — all existing JSONL files not in `processed` or maxed in `failed` are eligible.

**Dry-run mode does not read or write this file.**

---

## Error Handling

| Failure | Behavior |
|---------|----------|
| `NERD_COMPLETION_API_KEY` not set | Exit immediately: `Error: NERD_COMPLETION_API_KEY is not set.` |
| HTTP error from NerdCompletion | Log warning with status + body. Increment `failed` count. Continue to next file. |
| Response JSON malformed / wrong shape | Same as HTTP error. |
| `team-memory add` subprocess fails | Log warning. Mark session as processed anyway (facts already partially saved). |
| No JSONL files found | Print `[extract-bg] no sessions found.` and exit 0. |

---

## CLI Registration

Add to `src/cli.ts`:

```typescript
program
  .command("extract-bg")
  .description("Extract facts from Claude Code session files using NerdCompletion")
  .option("--dry-run", "process one session interactively without saving anything")
  .action((opts) => runExtractBg({ dryRun: !!opts.dryRun }));
```

---

## Full Execution Flow (pseudocode)

```typescript
async function runExtractBg({ dryRun }: { dryRun: boolean }) {
  const apiKey = process.env.NERD_COMPLETION_API_KEY;
  if (!apiKey) { console.error("Error: NERD_COMPLETION_API_KEY is not set."); process.exit(1); }

  const baseUrl = process.env.NERD_COMPLETION_BASE_URL
    ?? "https://nerd-completion.staging-service.nr-ops.net";

  const stateFile = join(resolveRepoDir(), "processed-sessions.json");
  const state = dryRun ? null : loadState(stateFile);

  const sessionFiles = glob("~/.claude/projects/**/*.jsonl");
  let toProcess = dryRun
    ? [sessionFiles.sort(byMtime).at(-1)]              // most recent only
    : sessionFiles.filter(f =>
        !state.processed.includes(basename(f)) &&
        (state.failed[basename(f)] ?? 0) < 3
      );

  log(`found ${toProcess.length} session(s) to process`);

  for (const file of toProcess) {
    const project = deriveProject(file);

    // Step 1: parse
    if (dryRun && !(await confirm(`Parse ${file}?`))) { log("skipped."); return; }
    const text = extractConversationText(file);
    log(`extracted turns, ${text.length} chars`);

    // Step 2: API call
    if (dryRun && !(await confirm(`Send to NerdCompletion (${text.length} chars)?`))) { log("skipped API call."); return; }
    let facts: Fact[];
    try {
      facts = await callNerdCompletion(baseUrl, apiKey, text);
      log(`extracted ${facts.length} facts`);
    } catch (err) {
      log(`WARNING: API call failed: ${err.message}`);
      if (!dryRun) incrementFailure(state, basename(file));
      if (!dryRun) saveState(stateFile, state);
      continue;
    }

    // Step 3: save each fact
    for (const [i, fact] of facts.entries()) {
      if (dryRun) {
        printFact(i + 1, facts.length, fact, project);
        if (!(await confirm("Save this fact?"))) { log("skipped fact."); continue; }
        log(`would run: team-memory add "${fact.content}" --project ${project} --tags '${JSON.stringify(fact.tags)}'`);
      } else {
        log(`saving fact: "${fact.content}"`);
        execSync(`team-memory add ${JSON.stringify(fact.content)} --project ${project} --tags '${JSON.stringify(fact.tags)}'`);
      }
    }

    if (!dryRun) {
      state.processed.push(basename(file));
      saveState(stateFile, state);
    }
  }

  if (dryRun) {
    log("done. No changes written.");
  } else {
    execSync("team-memory sync --push", { stdio: "inherit" });
    log(`done. processed ${toProcess.length} session(s).`);
  }
}
```

---

## Open Questions

None — all decisions resolved. Ready for implementation.
