# Pre-prompt Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a Claude Code `UserPromptSubmit` hook that auto-injects relevant team facts into every prompt and logs surface signals.

**Architecture:** A new `src/preprompt.ts` module reads a JSON hook payload from stdin, queries `merged_index.db` via existing `queryFacts()`, logs surfaces via existing `logSurfaces()`, then outputs a JSON response with injected context. A `session-end` CLI command calls `commitInteractions()` to batch-commit accumulated surface UPSERTs. Both are wired into `src/cli.ts`.

**Tech Stack:** TypeScript, better-sqlite3, Vitest. Claude Code hooks protocol (stdin/stdout JSON). Existing: `queryFacts`, `logSurfaces`, `commitInteractions`, `resolveIndexPath`, `resolveRepoDir`, `getDeveloperName`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/preprompt.ts` | Create | Core hook logic: parse stdin, query, log, format output |
| `src/cli.ts` | Modify | Wire `preprompt-hook` and `session-end` commands |
| `src/__tests__/preprompt.test.ts` | Create | Unit + integration tests |

---

## Hook Protocol

Claude Code calls `UserPromptSubmit` hooks before each prompt. The CLI receives:

**stdin (JSON):**
```json
{
  "session_id": "abc123",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "user's prompt text"
}
```

**stdout (JSON):**
```json
{
  "continue": true,
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "--- Team Memory Facts ---\n[fact-id] fact content\n..."
  }
}
```

If `merged_index.db` is missing or no facts match, output `{"continue": true}` (no `additionalContext`).

**Hook registration** in `.claude/settings.json`:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "team-memory preprompt-hook" }]
      }
    ]
  }
}
```

---

## Task 1: Core preprompt module — input parsing + query + output

**Files:**
- Create: `src/preprompt.ts`
- Create: `src/__tests__/preprompt.test.ts`

### What this does
Reads a JSON hook payload from stdin, extracts `prompt`, queries `merged_index.db`, and returns a formatted JSON response. The exported `runPrepromptHook()` is the testable unit; `main()` handles stdin/stdout plumbing for the CLI.

- [ ] **Step 1: Write the failing test for `runPrepromptHook` — returns facts when index exists**

Create `src/__tests__/preprompt.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openFactsDb, insertFact } from "../facts-db.js";
import { rebuildIndex } from "../merged-index.js";
import { openInteractionsDb } from "../interactions-db.js";
import { runPrepromptHook } from "../preprompt.js";

describe("runPrepromptHook", () => {
  let repoDir: string;
  let indexPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "team-memory-preprompt-"));
    mkdirSync(join(repoDir, "facts"));
    mkdirSync(join(repoDir, "interactions"));
    indexPath = join(repoDir, "merged_index.db");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true });
  });

  function seedAndBuild(facts: { content: string }[]) {
    const db = openFactsDb(join(repoDir, "facts"), "alice");
    for (const f of facts) insertFact(db, f);
    db.close();
    rebuildIndex(repoDir, indexPath);
  }

  test("returns matching facts as additionalContext", () => {
    seedAndBuild([
      { content: "Use viper for config parsing in Go services" },
      { content: "Stripe webhooks must be idempotent" },
    ]);

    const result = runPrepromptHook({ prompt: "viper config", indexPath, repoDir, developer: "alice" });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput?.additionalContext).toContain("viper");
  });

  test("returns continue:true with no additionalContext when index missing", () => {
    const result = runPrepromptHook({ prompt: "anything", indexPath: "/nonexistent/merged_index.db", repoDir, developer: "alice" });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  test("returns continue:true with no additionalContext when no facts match", () => {
    seedAndBuild([{ content: "Stripe webhooks must be idempotent" }]);

    const result = runPrepromptHook({ prompt: "viper config golang", indexPath, repoDir, developer: "alice" });

    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx vitest run src/__tests__/preprompt.test.ts
```
Expected: FAIL — `Cannot find module '../preprompt.js'`

- [ ] **Step 3: Implement `src/preprompt.ts`**

```typescript
import { existsSync } from "fs";
import { queryFacts } from "./query.js";
import { logSurfaces } from "./surface-logging.js";

export interface PrepromptInput {
  prompt: string;
  indexPath: string;
  repoDir: string;
  developer: string;
}

export interface PrepromptOutput {
  continue: true;
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

export function runPrepromptHook(input: PrepromptInput): PrepromptOutput {
  const { prompt, indexPath, repoDir, developer } = input;

  if (!existsSync(indexPath)) {
    return { continue: true };
  }

  const results = queryFacts({ indexPath, query: prompt, limit: 5 });

  if (results.length === 0) {
    return { continue: true };
  }

  logSurfaces(repoDir + "/interactions", developer, results.map((r) => r.id));

  const lines = ["--- Team Memory Facts ---"];
  for (const r of results) {
    lines.push(`[${r.id}] ${r.content}`);
  }
  const additionalContext = lines.join("\n");

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

export function main(): void {
  let raw = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let prompt = "";
    try {
      const payload = JSON.parse(raw);
      prompt = payload.prompt ?? "";
    } catch {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const indexPath = process.env.TEAM_MEMORY_INDEX_PATH
      ?? require("path").join(require("os").homedir(), ".cache", "team-memory", "merged_index.db");
    const repoDir = process.env.TEAM_MEMORY_DIR
      ?? require("path").join(require("os").homedir(), ".team-memory");
    const developer = process.env.TEAM_MEMORY_DEVELOPER ?? (() => {
      try {
        return require("child_process").execSync("git config user.name", { encoding: "utf-8" }).trim();
      } catch { return "unknown"; }
    })();

    const result = runPrepromptHook({ prompt, indexPath, repoDir, developer });
    process.stdout.write(JSON.stringify(result));
  });
}
```

> **Note:** The `main()` function uses `require()` for path/os/child_process to keep it simple — these are Node.js built-ins that don't need dynamic imports. If the project enforces ESM-only, replace with static imports at the top of the file.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run src/__tests__/preprompt.test.ts
```
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/preprompt.ts src/__tests__/preprompt.test.ts
git commit -m "feat: add preprompt hook module"
```

---

## Task 2: Fix `logSurfaces` dir argument — interactions subdir vs repoDir

**Files:**
- Modify: `src/preprompt.ts` (fix the interactions dir path)
- Modify: `src/__tests__/preprompt.test.ts` (add surface logging assertion)

### Context
`logSurfaces(dir, developer, factIds)` opens `interactions-<dev>.db` at `join(dir, "interactions-<dev>.db")`. In the hook, interactions live in `join(repoDir, "interactions", "interactions-<dev>.db")`. Need to pass `join(repoDir, "interactions")` as `dir`.

- [ ] **Step 1: Add surface-logging assertion test**

Append to the `describe("runPrepromptHook"` block in `src/__tests__/preprompt.test.ts`:

```typescript
  test("logs surface counts for returned facts", () => {
    seedAndBuild([{ content: "Use viper for config parsing" }]);

    runPrepromptHook({ prompt: "viper", indexPath, repoDir, developer: "alice" });

    const db = openInteractionsDb(join(repoDir, "interactions"), "alice");
    const rows = db.prepare("SELECT * FROM interactions").all() as { fact_id: string; surface_count: number }[];
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].surface_count).toBe(1);
  });
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx vitest run src/__tests__/preprompt.test.ts
```
Expected: FAIL on the new test — the db file will be in wrong location.

- [ ] **Step 3: Fix the `repoDir` → interactions subdir in `preprompt.ts`**

Change the `logSurfaces` call in `runPrepromptHook`:

```typescript
// OLD:
logSurfaces(repoDir + "/interactions", developer, results.map((r) => r.id));

// NEW:
import { join } from "path";
// (add join import at top of file)
logSurfaces(join(repoDir, "interactions"), developer, results.map((r) => r.id));
```

Full updated `src/preprompt.ts` header (add `join` import):
```typescript
import { existsSync } from "fs";
import { join } from "path";
import { queryFacts } from "./query.js";
import { logSurfaces } from "./surface-logging.js";
```

And update the `main()` function's directory references to use `join` properly (replace the `require("path").join` calls):
```typescript
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
// Remove the require() calls in main() and use the already-imported modules
```

Full corrected `main()`:
```typescript
export function main(): void {
  let raw = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => { raw += chunk; });
  process.stdin.on("end", () => {
    let prompt = "";
    try {
      const payload = JSON.parse(raw);
      prompt = payload.prompt ?? "";
    } catch {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const indexPath = process.env.TEAM_MEMORY_INDEX_PATH
      ?? join(homedir(), ".cache", "team-memory", "merged_index.db");
    const repoDir = process.env.TEAM_MEMORY_DIR
      ?? join(homedir(), ".team-memory");
    const developer = process.env.TEAM_MEMORY_DEVELOPER ?? (() => {
      try {
        return execSync("git config user.name", { encoding: "utf-8" }).trim();
      } catch { return "unknown"; }
    })();

    const result = runPrepromptHook({ prompt, indexPath, repoDir, developer });
    process.stdout.write(JSON.stringify(result));
  });
}
```

- [ ] **Step 4: Run tests to confirm all pass**

```bash
npx vitest run src/__tests__/preprompt.test.ts
```
Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/preprompt.ts src/__tests__/preprompt.test.ts
git commit -m "fix: pass interactions subdir to logSurfaces in preprompt hook"
```

---

## Task 3: Wire CLI commands — `preprompt-hook` and `session-end`

**Files:**
- Modify: `src/cli.ts`

### What this adds
- `team-memory preprompt-hook` — reads stdin JSON, calls `runPrepromptHook`, writes JSON to stdout
- `team-memory session-end` — calls `commitInteractions()` to batch-commit accumulated surfaces
- Both commands appear in `--help` output

- [ ] **Step 1: Write the failing CLI smoke test**

Append to `src/__tests__/smoke.test.ts` (at the end, inside the outer `describe` or as a new describe block):

```typescript
describe("team-memory preprompt-hook", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-preprompt-cli-"));
    mkdirSync(join(dir, "facts"));
    mkdirSync(join(dir, "interactions"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  test("outputs continue:true JSON with no index", () => {
    const input = JSON.stringify({ prompt: "test", hook_event_name: "UserPromptSubmit" });
    const output = execFileSync(
      "node",
      [CLI_PATH, "preprompt-hook"],
      {
        encoding: "utf-8",
        input,
        env: {
          ...process.env,
          TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db"),
          TEAM_MEMORY_DIR: dir,
          TEAM_MEMORY_DEVELOPER: "alice",
        },
      }
    );
    const parsed = JSON.parse(output);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });
});

describe("team-memory session-end", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-session-end-"));
    execSync("git init", { cwd: dir });
    execSync("git config user.name 'Test'", { cwd: dir });
    execSync("git config user.email 'test@test.com'", { cwd: dir });
    execSync("git commit --allow-empty -m 'init'", { cwd: dir });
    mkdirSync(join(dir, "interactions"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  test("exits 0 with no interactions db", () => {
    expect(() =>
      execFileSync("node", [CLI_PATH, "session-end"], {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "alice" },
      })
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npx vitest run src/__tests__/smoke.test.ts
```
Expected: FAIL — `Unknown command: preprompt-hook` and `Unknown command: session-end`

- [ ] **Step 3: Add imports to `src/cli.ts`**

At the top of `src/cli.ts`, add:
```typescript
import { runPrepromptHook } from "./preprompt.js";
import { commitInteractions } from "./surface-logging.js";
```

- [ ] **Step 4: Update USAGE string in `src/cli.ts`**

Replace the `Commands:` block in `USAGE` to include the two new commands:
```typescript
const USAGE = `team-memory — shared long-term memory for coding agents

Usage:
  team-memory <command> [options]

Commands:
  add <content>        Add a new fact
  query <text>         Search facts by relevance
  reject <fact_id>     Mark a fact as incorrect
  rebuild-index        Rebuild the local merged index
  prune                Remove stale or rejected facts
  sync                 Pull from remote and rebuild index
  install-hook         Install post-merge git hook for auto-rebuild
  preprompt-hook       Claude Code UserPromptSubmit hook (reads stdin JSON, writes stdout JSON)
  session-end          Commit accumulated surface interactions to git

Options:
  --help               Show this help message
  --version            Show version
`;
```

- [ ] **Step 5: Add `preprompt-hook` command handler in `src/cli.ts`**

Add before the final `process.stderr.write` / `process.exit(1)` at the end of `main()`:

```typescript
  if (command === "preprompt-hook") {
    let raw = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => { raw += chunk; });
    process.stdin.on("end", () => {
      let prompt = "";
      try {
        const payload = JSON.parse(raw);
        prompt = payload.prompt ?? "";
      } catch {
        process.stdout.write(JSON.stringify({ continue: true }));
        return;
      }
      const indexPath = resolveIndexPath();
      const repoDir = resolveRepoDir();
      const developer = (() => {
        try { return getDeveloperName(); } catch { return "unknown"; }
      })();
      const result = runPrepromptHook({ prompt, indexPath, repoDir, developer });
      process.stdout.write(JSON.stringify(result));
    });
    return;
  }
```

- [ ] **Step 6: Add `session-end` command handler in `src/cli.ts`**

Add immediately after the `preprompt-hook` block:

```typescript
  if (command === "session-end") {
    const repoDir = resolveRepoDir();
    const developer = getDeveloperName();
    commitInteractions(join(repoDir, "interactions"), developer);
    return;
  }
```

> **Note:** `commitInteractions` currently takes `(dir, developer)` where it opens `interactions-<dev>.db` inside `dir`. Verify this matches `src/surface-logging.ts` — if it opens `join(dir, "interactions-<dev>.db")` directly, pass `join(repoDir, "interactions")` here.

Add `join` import to `src/cli.ts` if not already present:
```typescript
import { join } from "path";
```

- [ ] **Step 7: Build and run smoke tests**

```bash
npm run build && npx vitest run src/__tests__/smoke.test.ts
```
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts
git commit -m "feat: wire preprompt-hook and session-end CLI commands"
```

---

## Task 4: Integration test — end-to-end hook call with real facts

**Files:**
- Create: `src/__tests__/preprompt-integration.test.ts`

### What this tests
Simulates a full hook invocation: seed facts → rebuild index → pipe JSON to the CLI → verify output contains matched facts and surface counts are updated.

- [ ] **Step 1: Write the integration test**

Create `src/__tests__/preprompt-integration.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { execFileSync, execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { resolve } from "path";
import { openFactsDb, insertFact } from "../facts-db.js";
import { openInteractionsDb } from "../interactions-db.js";
import { rebuildIndex } from "../merged-index.js";

const CLI_PATH = resolve(import.meta.dirname, "../../dist/cli.js");

describe("preprompt-hook integration", () => {
  let repoDir: string;
  let indexPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "tm-preprompt-int-"));
    mkdirSync(join(repoDir, "facts"));
    mkdirSync(join(repoDir, "interactions"));
    indexPath = join(repoDir, "merged_index.db");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true });
  });

  test("injects matching facts into additionalContext", () => {
    const db = openFactsDb(join(repoDir, "facts"), "bob");
    const fact = insertFact(db, { content: "Use viper for config parsing in Go services" });
    db.close();
    rebuildIndex(repoDir, indexPath);

    const hookInput = JSON.stringify({
      session_id: "test-session",
      hook_event_name: "UserPromptSubmit",
      prompt: "how do we handle config viper",
    });

    const output = execFileSync("node", [CLI_PATH, "preprompt-hook"], {
      encoding: "utf-8",
      input: hookInput,
      env: {
        ...process.env,
        TEAM_MEMORY_INDEX_PATH: indexPath,
        TEAM_MEMORY_DIR: repoDir,
        TEAM_MEMORY_DEVELOPER: "bob",
      },
    });

    const parsed = JSON.parse(output);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("viper");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(fact.id);
  });

  test("surface count incremented after hook call", () => {
    const db = openFactsDb(join(repoDir, "facts"), "bob");
    const fact = insertFact(db, { content: "Stripe webhooks must be idempotent" });
    db.close();
    rebuildIndex(repoDir, indexPath);

    const hookInput = JSON.stringify({
      session_id: "test-session",
      hook_event_name: "UserPromptSubmit",
      prompt: "stripe webhook payment",
    });

    execFileSync("node", [CLI_PATH, "preprompt-hook"], {
      encoding: "utf-8",
      input: hookInput,
      env: {
        ...process.env,
        TEAM_MEMORY_INDEX_PATH: indexPath,
        TEAM_MEMORY_DIR: repoDir,
        TEAM_MEMORY_DEVELOPER: "bob",
      },
    });

    const idb = openInteractionsDb(join(repoDir, "interactions"), "bob");
    const row = idb
      .prepare("SELECT surface_count FROM interactions WHERE fact_id = ?")
      .get(fact.id) as { surface_count: number } | undefined;
    idb.close();

    expect(row?.surface_count).toBe(1);
  });

  test("no additionalContext when no facts match", () => {
    const db = openFactsDb(join(repoDir, "facts"), "bob");
    insertFact(db, { content: "Stripe webhooks must be idempotent" });
    db.close();
    rebuildIndex(repoDir, indexPath);

    const hookInput = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "kubernetes pod autoscaling",
    });

    const output = execFileSync("node", [CLI_PATH, "preprompt-hook"], {
      encoding: "utf-8",
      input: hookInput,
      env: {
        ...process.env,
        TEAM_MEMORY_INDEX_PATH: indexPath,
        TEAM_MEMORY_DIR: repoDir,
        TEAM_MEMORY_DEVELOPER: "bob",
      },
    });

    const parsed = JSON.parse(output);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });
});
```

- [ ] **Step 2: Build and run integration tests**

```bash
npm run build && npx vitest run src/__tests__/preprompt-integration.test.ts
```
Expected: 3 passing tests.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/preprompt-integration.test.ts
git commit -m "test: add preprompt hook integration tests"
```

---

## Task 5: Register hook in `.claude/settings.json`

**Files:**
- Modify: `.claude/settings.json` (create if not present)

> **Note:** This assumes `team-memory` is on PATH after `npm install -g` or is run via `npx`. Adjust the command if installed differently.

- [ ] **Step 1: Create/update `.claude/settings.json`**

Check if `.claude/settings.json` exists. If it does NOT exist, create it. If it exists, merge the `hooks` key in.

Final `.claude/settings.json`:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "team-memory preprompt-hook"
          }
        ]
      }
    ]
  }
}
```

> **Note:** `settings.local.json` already has permissions/MCP config — do NOT put hooks in `settings.local.json`. Hooks belong in the committed `settings.json`.

- [ ] **Step 2: Run the full test suite to confirm no regressions**

```bash
npm run build && npx vitest run
```
Expected: all ~110+ tests pass (plus new ones).

- [ ] **Step 3: Commit**

```bash
git add .claude/settings.json
git commit -m "feat: register preprompt-hook in Claude Code UserPromptSubmit hook"
```

---

## Spec Coverage Self-Review

| Acceptance Criterion | Task |
|---|---|
| Claude Code `UserPromptSubmit` hook | Task 3 (CLI command), Task 5 (settings.json registration) |
| Queries `merged_index.db` with prompt as FTS key | Task 1 (`queryFacts` call) |
| Injects top 3-5 matching facts | Task 1 (limit=5 in `queryFacts`) |
| Calls `logSurfaces()` for each injected fact | Task 2 (surface logging test + fix) |
| Hook execution <100ms | Not tested explicitly — FTS + UPSERT are both <5ms per issue spec |
| Surface UPSERTs NOT auto-committed | Task 1 (`logSurfaces` does not commit) |
| Session-end commit mechanism | Task 3 (`session-end` command → `commitInteractions`) |
| Graceful when no `merged_index.db` | Task 1 (`existsSync` guard, returns `{continue:true}`) |
| Graceful when no facts match | Task 1 (empty results → no `additionalContext`) |
| Clean output format | Task 1 (JSON with `additionalContext` text block) |
| Integration test | Task 4 |
