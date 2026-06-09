# Spec: `team-memory extract-bg` — Background Fact Extraction Agent

**Date:** 2026-06-09
**Status:** Ready for implementation
**Stack:** TypeScript (existing team-memory CLI)

---

## Overview

`team-memory extract-bg` is a new CLI subcommand that scans Claude Code session JSONL files, calls NerdCompletion to extract 0–3 facts per session, and saves them via the existing `team-memory add` CLI. It runs on-demand (manually or via cron) — no daemon, no file watcher.

---

## Architecture

```
team-memory extract-bg
      │
      ├── 1. Load state file: resolveRepoDir() + "/processed-sessions.json"
      │
      ├── 2. Scan ~/.claude/projects/ for *.jsonl files
      │
      ├── 3. For each file not in state["processed"] and not maxed in state["failed"]:
      │       a. Parse JSONL → extract conversation text (user + assistant turns only)
      │       b. POST to NerdCompletion /v1/chat/completions
      │              model: claude-4-5-sonnet
      │              response_format: { type: "json_object" }
      │              messages: [system: extraction prompt, user: conversation text]
      │       c. Parse JSON → { facts: [{content, tags}] }
      │       d. Derive --project from JSONL directory path
      │       e. For each fact: execSync("team-memory add ...")
      │       f. Update state file (mark processed or increment failure count)
      │
      └── 4. execSync("team-memory sync --push")
```

---

## File Location in Codebase

| File | Purpose |
|------|---------|
| `src/extract-bg.ts` | Main implementation |
| `src/cli.ts` | Register new `extract-bg` subcommand |

No new dependencies required beyond Node.js built-ins (`fs`, `path`, `child_process`).

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
  `team-memory add ${JSON.stringify(fact.content)} --project ${project} --tags ${JSON.stringify(JSON.stringify(fact.tags))}`,
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

---

## Error Handling

| Failure | Behavior |
|---------|----------|
| `NERD_COMPLETION_API_KEY` not set | Exit immediately with message: `Error: NERD_COMPLETION_API_KEY is not set.` |
| HTTP error from NerdCompletion | Log warning with status code. Increment `failed` count. Leave unprocessed. Continue to next file. |
| Response JSON malformed / wrong shape | Same as HTTP error. |
| `team-memory add` subprocess fails | Log warning. Mark session as processed anyway (facts already partially saved). |
| No JSONL files found | Print `No sessions found.` and exit 0. |

---

## CLI Registration

Add to `src/cli.ts`:

```typescript
program
  .command("extract-bg")
  .description("Extract facts from Claude Code session files using NerdCompletion")
  .action(runExtractBg);
```

---

## Full Execution Flow (pseudocode)

```typescript
async function runExtractBg() {
  const apiKey = process.env.NERD_COMPLETION_API_KEY;
  if (!apiKey) { console.error("Error: NERD_COMPLETION_API_KEY is not set."); process.exit(1); }

  const baseUrl = process.env.NERD_COMPLETION_BASE_URL
    ?? "https://nerd-completion.staging-service.nr-ops.net";

  const stateFile = join(resolveRepoDir(), "processed-sessions.json");
  const state = loadState(stateFile); // { processed: [], failed: {} }

  const sessionFiles = glob("~/.claude/projects/**/*.jsonl");
  const toProcess = sessionFiles.filter(f =>
    !state.processed.includes(basename(f)) &&
    (state.failed[basename(f)] ?? 0) < 3
  );

  for (const file of toProcess) {
    const text = extractConversationText(file);    // parse JSONL → [USER]/[ASSISTANT] text
    const project = deriveProject(file);           // last segment of encoded dir name

    try {
      const facts = await callNerdCompletion(baseUrl, apiKey, text);
      for (const fact of facts) {
        execSync(`team-memory add ${JSON.stringify(fact.content)} --project ${project} --tags '${JSON.stringify(fact.tags)}'`);
      }
      state.processed.push(basename(file));
    } catch (err) {
      console.warn(`Warning: failed to process ${basename(file)}: ${err.message}`);
      state.failed[basename(file)] = (state.failed[basename(file)] ?? 0) + 1;
    }

    saveState(stateFile, state);
  }

  execSync("team-memory sync --push", { stdio: "inherit" });
}
```

---

## Open Questions

None — all decisions resolved. Ready for implementation.
