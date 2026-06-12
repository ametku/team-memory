# Team Memory — V1 Architecture

A team-shared long-term memory system for coding agents. Facts learned by one developer become available to all team members in future sessions.

> **See also:** [`RESEARCH-trust-scoring.md`](./RESEARCH-trust-scoring.md) for the full decision trail behind the trust model summarized below.

## Core Value Proposition

**The gap this fills:** Developer A learns a lesson during a Claude session (a gotcha, a correction, an explicit decision). Today, that knowledge dies with the session or lives only in A's personal memory. Developer B hits the same issue next week. Team Memory makes A's hard-won lessons available to B automatically.

**Differentiator from existing systems:**
- CLAUDE.md / project docs = static, manually maintained conventions
- Per-user auto-memory (~/.claude/projects/.../memory/) = personal, not shared
- **Team Memory = shared lessons, automatically extracted, surfaced proactively**

## What is a "Fact"

A fact is a **decision, correction, gotcha, or convention that emerged from session friction** — something Claude got wrong, or something a developer had to explicitly steer.

### Examples of valid facts:
- "Use viper for all config parsing — json.Unmarshal only for API response bodies"
- "The deploy pipeline flakes on integration step — retry once before investigating"
- "Don't use `panic()` in the payments service — explicit error returns only"
- "Stripe webhook handler must be idempotent — we've had duplicate delivery issues"

### NOT facts:
- General documentation (belongs in CLAUDE.md or docs)
- Ephemeral state ("deploy is broken right now")
- Personal preferences that don't affect the team

## Design Principles

1. **Agent-agnostic** — works with Claude Code, Cursor, Copilot, Gemini CLI, any agent
2. **No external servers for data storage** — all data stored locally or in team-hosted git
3. **Zero-friction extraction** — the session's own agent proposes facts, developer approves
4. **Proactive retrieval** — relevant facts injected automatically, agent doesn't need to "know" to ask
5. **Trust builds organically** — facts earn ranking through real-world surface history; bad facts are explicitly rejected

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                       Developer's Machine                          │
│                                                                   │
│  ┌─────────────┐     ┌──────────────┐     ┌────────────────────┐ │
│  │ Coding Agent│────▶│ Pre-prompt   │────▶│ merged_index.db    │ │
│  │ (any agent) │     │ Hook         │     │ (FTS5, local only) │ │
│  └─────────────┘     │  - retrieve  │     └─────────┬──────────┘ │
│         │            │  - log       │               │            │
│         │            │    surface   │     rebuilt from ATTACH    │
│         │ session    └──────┬───────┘     of all .db files       │
│         ▼ end               │                       │            │
│  ┌─────────────┐            ▼                       │            │
│  │ Extraction  │     ┌──────────────────────────────┴────────┐   │
│  │ Skill       │────▶│ ~/.team-memory/ (git clone)           │   │
│  └─────────────┘     │  facts/facts-<dev>.db                 │   │
│         ▲            │  interactions/interactions-<dev>.db   │   │
│         │            └─────────────────────┬─────────────────┘   │
│  ┌─────────────┐                           │                     │
│  │ MCP Server  │◀── thin wrapper over CLI ─┘                     │
│  └─────────────┘                                                 │
└──────────────────────────────────────────┬───────────────────────┘
                                           │ git push/pull
                                           ▼
                                 ┌────────────────────┐
                                 │ Remote Git Repo    │
                                 │ (GitHub/GitLab)    │
                                 │ Team-shared truth  │
                                 └────────────────────┘
```

## Components

### 1. Git Repository (Source of Truth)

**Purpose:** Durable storage and team sync mechanism.

**Structure:**
```
team-memory/
├── facts/
│   ├── facts-alice.db              # only Alice writes
│   ├── facts-bob.db                # only Bob writes
│   └── ...
├── interactions/
│   ├── interactions-alice.db       # only Alice writes
│   ├── interactions-bob.db         # only Bob writes
│   └── ...
├── config.yaml                     # team-level settings (prune thresholds, FTS config)
└── README.md
```

**Decisions:**
- **Per-developer SQLite files, not YAML.** Each developer owns one `facts-<dev>.db` (their authored facts) and one `interactions-<dev>.db` (their surface counters and explicit rejects). Nobody writes to anyone else's file → zero binary merge conflicts.
- **Two files per developer**, not one. Facts change rarely; interactions UPSERT on every prompt. Splitting them isolates churn so the heavy-write file doesn't bloat the slow-write history.
- Short random IDs (nanoid-style, 8 chars) for facts. Human-friendly in git logs.
- Facts are **not** human-readable in PRs. All writes go through the `team-memory` CLI/MCP. Manual fixes use a SQLite client.
- `VACUUM` runs before commit to keep page layout deterministic and minimize binary diff size.

**Schema — `facts-<dev>.db`:**
```sql
CREATE TABLE facts (
  id TEXT PRIMARY KEY,           -- nanoid, 8 chars
  content TEXT NOT NULL,         -- the fact itself, concise and actionable
  project TEXT,                  -- optional project scope
  tags TEXT,                     -- JSON array: ["category:<enum>", "kw1", "kw2", ...] (see #18)
  created_at TEXT NOT NULL,      -- ISO 8601
  deleted_at TEXT                -- soft delete; physical row deletion on next prune commit
);
```

**Schema — `interactions-<dev>.db`:**
```sql
CREATE TABLE interactions (
  fact_id TEXT PRIMARY KEY,                       -- references a fact authored by anyone
  surface_count INTEGER NOT NULL DEFAULT 0,       -- # of times this dev's hook injected the fact
  last_surfaced_at TEXT NOT NULL,                 -- ISO 8601
  explicit_score INTEGER NOT NULL DEFAULT 0       -- only ever set to -1 in V1 (reject)
);
```

`source.author` is implicit in which `facts-<dev>.db` file the fact lives in.

**Tag Structure** ([PRD: Fact Metadata and Tagging System — #18](https://github.com/ametku/team-memory/issues/18)):

The `tags` JSON array uses a hybrid format — one prefixed category + 3-5 freeform keyword tags:
- **Category** (required, first element): `category:gotcha | category:convention | category:tool | category:workaround | category:decision`
- **Freeform keywords** (3-5, unprefixed): retrieval synonyms NOT already in the fact content

Example: `["category:gotcha", "networking", "db-connection", "rancher"]`

Tag normalization happens at index rebuild time, not at insert. FTS5 indexes tags with equal weight to content and project. Future facets use their own prefix (e.g., `severity:high`).

### 2. Local Merged Index (Query)

**Purpose:** Fast local retrieval for pre-prompt injection.

**Decisions:**
- Each developer has a local-only `merged_index.db` (NOT in git, NOT shared).
- The merged index is an **index over all developers' source-of-truth `.db` files**, not the source of truth itself.
- Rebuilt on `git pull` via post-merge hook by ATTACHing every `facts-*.db` and `interactions-*.db` and aggregating.
- Trust score is **precomputed at rebuild time** as a column on the FTS row, not recomputed per query.
- Full-text search via SQLite FTS5 on: fact content + tags + project.
- Query time target: <10ms (a single FTS5 read against a local DB).

**Rebuild logic** (run inside post-merge hook):
1. ATTACH every `facts/facts-*.db` and `interactions/interactions-*.db`.
2. UNION facts from all authors where `deleted_at IS NULL`.
3. UNION interactions from all developers, GROUP BY `fact_id`, aggregate to `(total_surfaces, last_surfaced_anywhere, net_explicit)`.
4. Build FTS5 virtual table with precomputed `trust` column.
5. Exclude facts with `net_explicit ≤ -2` (queued for deletion).

**V2 enhancement:** Semantic/vector search with session transcript understanding.

### 3. Pre-prompt Hook (Retrieval + Surface Logging)

**Purpose:** Automatically inject relevant facts into agent context on every prompt, and record surface signal.

**How it works:**
1. Developer sends a prompt to their coding agent.
2. Pre-prompt hook fires (e.g., Claude Code's `UserPromptSubmit`).
3. Hook queries `merged_index.db` FTS5 using the user's message as query key.
4. Top 3-5 matching facts injected as system context, ranked by `bm25 * trust`.
5. For each injected fact, hook UPSERTs `interactions-<dev>.db`: `surface_count += 1`, `last_surfaced_at = now()`.
6. Agent sees the facts alongside the user's prompt.

**Decisions:**
- Hook-based, not agent-initiated (reliable, agent doesn't need to "remember" to ask).
- FTS query key = user's current message + active file paths (if available).
- Max 3-5 facts per prompt (avoid context pollution).
- Must complete in <100ms (direct FTS5 read is ~1-5ms; UPSERT is ~1ms).
- Surface UPSERTs are batched and committed once per session (not per prompt) to keep git history clean.
- Agent-specific trigger mechanism (each agent framework has its own hooks).

### 4. Extraction Skill (Writing Facts)

**Purpose:** Propose fact candidates at session end.

**How it works:**
1. Session ends (or developer triggers manually).
2. The session's own agent (not a separate service) runs the extraction skill.
3. Agent reviews the conversation context and proposes 0-3 fact candidates.
4. Developer approves/edits/rejects inline.
5. Approved facts are inserted into `facts-<dev>.db` via the CLI.

**Decisions:**
- No separate extraction service or LLM call needed for V1.
- The session's own agent has full context already.
- Triggered by a session-end hook or skill.
- Zero infrastructure beyond the hook itself.
- V2: separate transcript analysis agent for higher quality extraction.

### 5. CLI Tool

**Purpose:** Core interface for all operations.

**Commands:**
- `team-memory query <text>` — FTS search against `merged_index.db`, returns matching facts.
- `team-memory add <content> [--project X] [--tags a,b,c]` — INSERT into `facts-<dev>.db`, commit.
- `team-memory reject <fact_id>` — UPSERT `explicit_score = -1` for that `fact_id` in `interactions-<dev>.db`, commit.
- `team-memory rebuild-index` — rebuild `merged_index.db` from all `.db` files in the repo.
- `team-memory prune` — apply prune rules to facts you authored; DELETE qualifying rows from `facts-<dev>.db`, commit.
- `team-memory sync` — git pull + rebuild index + (optional) git push pending commits.
- `team-memory dashboard [--no-open]` — generate `dashboard.html` and open in browser.
- `team-memory opt-in` — opt the current project into team-memory fact extraction.

### 6. Dashboard

**Purpose:** A locally generated, self-contained static HTML page that makes the team's shared fact store browsable and inspectable without needing to know what to search for.

**How it works:**
1. `team-memory dashboard` reads `merged_index.db` (facts + trust scores), all `facts-*.db` (author attribution + dates), and all `interactions-*.db` (surface counts + reject counts).
2. All HTML is pre-rendered in TypeScript — the page is fully readable without JavaScript.
3. JavaScript adds interactivity: filtering, sorting, tab switching, tag navigation, fact card expand/collapse.
4. Output is written to `${TEAM_MEMORY_DIR}/dashboard.html` (a single self-contained file — no server, no dependencies).
5. The file is opened in the default browser automatically (`open` on macOS, `xdg-open` on Linux). Use `--no-open` to skip this.

**Three views:**
- **Team View** — all facts from every author, sortable by trust (default), date added, or surface count. Keyword search and project filter.
- **Members View** — per-developer profile with two tabs: Authored (facts they added, sorted by trust) and Activity (most-surfaced facts). Sidebar lists all contributors.
- **Tags View** — Tag Index showing all tags weighted by frequency. Clicking any tag shows all facts carrying it, sorted by trust, with a related-tags sidebar derived from co-occurrence.

**Fact card expanded detail:** full content, author, project, all tags (clickable), trust score, surface count, reject count, date added, last surfaced date, and a copyable `team-memory reject <id>` command.

**Decisions:**
- Output path is `${TEAM_MEMORY_DIR}/dashboard.html` — lives next to the facts, not in a cache dir. Excluded from git via `.gitignore`.
- All card HTML is pre-rendered server-side (TypeScript) so tests can assert on literal content without a browser. JS re-renders only the filtered/sorted list on user interaction.
- `dashboard.html` is gitignored — it is regenerated on demand, not shared. Run `team-memory dashboard` after `team-memory sync` for an up-to-date view.
- `--no-open` flag skips the browser launch — used in tests and CI.
- No external dependencies — inline CSS and vanilla JS only.

### 7. Project Opt-In

**Purpose:** Ensure `extract-bg` and `extract-slack` only process Claude sessions from repos the developer has explicitly enrolled in team-memory. Prevents personal projects, sensitive repos, and unrelated work from feeding the shared fact store.

**Mechanism:**

- **Marker file** — `.claude/team-memory.md` in the project root signals opt-in. Commit this file so all teammates are opted in automatically.
- **Registry** — `${TEAM_MEMORY_DIR}/opted-in-projects.json` maps absolute project paths to their Claude-encoded session directory names. Machine-specific; gitignored.

**How to opt in a project:**
```bash
cd ~/repos/my-service
team-memory opt-in
# → creates .claude/team-memory.md
# → registers project in opted-in-projects.json
```

**`join` and `init` auto-opt-in** the current working directory, so the first-run experience requires no extra steps.

**`extract-bg` behaviour:**
- Loads `opted-in-projects.json` at startup.
- Filters session files to only those whose parent directory name matches a registered encoded path.
- If no projects are opted in, prints a clear warning and exits without processing anything.

**Decisions:**
- **File over env var** — a committed `.claude/team-memory.md` is discoverable, reviewable, and team-auditable. An env var is invisible.
- **Registry for `extract-bg`** — Claude session directories use path encoding (`/` → `-`) that is ambiguous for paths containing dashes. Rather than decoding, the registry stores the pre-computed encoded name from the known absolute path at opt-in time. `extract-bg` compares directory names directly against registry values — no ambiguous decoding.
- **`realpathSync` throughout** — handles macOS `/var` → `/private/var` symlinks so paths are consistent between `mktemp` and `git rev-parse --show-toplevel`.

### 8. MCP Server

**Purpose:** Thin wrapper over CLI, exposing tools for agents that support MCP.

**Tools exposed:**
- `search_facts(query)` — same as `team-memory query`.
- `add_fact(content, project?, tags?)` — same as `team-memory add`.
- `reject_fact(fact_id)` — same as `team-memory reject`.
- `list_facts(project?, min_trust?)` — browse facts with filters.

**Decisions:**
- MCP server is optional — hooks + CLI work independently.
- Allows agents to interact with facts mid-session (not just at boundaries).
- Same underlying logic, two interfaces (CLI and MCP).
- Replaced the original `update_trust(fact_id, delta)` with `reject_fact(fact_id)` — V1 has only one explicit signal direction (reject); positive trust comes from surface count, not explicit upvotes.

## Trust Model

**Purpose:** Surface high-value facts more often, prune wrong or stale ones.

> Full design rationale: [`RESEARCH-trust-scoring.md`](./RESEARCH-trust-scoring.md). The summary below is the implementation contract.

**Core insight:** *If a fact keeps matching queries, it's relevant. If it's wrong, someone will explicitly reject it.* No agent-side citation detection in V1.

**Two signals only:**

1. **Surface signal (free, automatic).** Pre-prompt hook UPSERTs `(fact_id, surface_count++, last_surfaced_at = now)` into `interactions-<dev>.db` whenever it injects a fact. Cheap, deterministic, agent-agnostic.

2. **Explicit reject (rare, manual).** Developer runs `team-memory reject <fact_id>` when they catch the agent using a bad fact. Sets `explicit_score = -1` in their `interactions-<dev>.db`.

No `+1` thumbs-up — surface count is the de facto positive signal.

**Trust score (computed at index rebuild time, not per query):**

```
trust = (1 + log(1 + total_surfaces)) * max(0.1, 1 + 0.5 * net_explicit)
```

Where the aggregates are taken across **all developers' `interactions-*.db` files**:
- `total_surfaces = SUM(surface_count)`
- `net_explicit = SUM(explicit_score)`

A new fact with no interactions yet defaults to `trust = 1.0` so it can be discovered.

**Ranking:** at retrieval time, FTS5 results are ordered by `bm25(facts_view) * trust DESC`, top 5 returned.

**Pruning** (run by `team-memory prune`; each developer prunes only their own authored facts):

| Condition | Action |
|---|---|
| `net_explicit ≤ -2` | Delete now (≥2 independent rejects) |
| `total_surfaces == 0` AND fact age > 6 months | Delete (never matched any query) |
| `last_surfaced_anywhere > 6 months ago` AND `total_surfaces < 5` | Delete (briefly relevant, now stale) |
| Otherwise | Keep |

The two-reject floor protects against single-developer mistakes. One reject demotes ranking; deletion requires independent corroboration.

Facts excluded by `net_explicit ≤ -2` are removed from `facts_view` immediately at index rebuild time, so they stop surfacing even before the author gets around to running `prune`.

## Write Path (End-to-End)

```
1. Session ends → extraction skill fires
2. Agent proposes: "Save this fact? 'Use viper for config parsing'"
3. Developer approves (or edits)
4. CLI INSERTs row into ~/.team-memory/facts/facts-<dev>.db (local git clone)
5. CLI VACUUMs and commits the file (auto-commit on approval)
6. Developer pushes when ready (manual, or periodic auto-push)
7. Other developers pull → post-merge hook rebuilds merged_index.db
8. Fact now surfaceable in their pre-prompt hook queries (with default trust = 1.0)
```

Reject path is symmetric: `team-memory reject f-X` → UPSERT into `interactions-<dev>.db` → VACUUM → commit → push.

## Read Path (End-to-End)

```
1. Developer types a prompt in their coding agent
2. Pre-prompt hook fires
3. Hook queries merged_index.db: FTS5 MATCH on prompt, ORDER BY bm25 * trust, LIMIT 5
4. Hook UPSERTs surface_count in interactions-<dev>.db for each returned fact
5. Top facts injected into agent's context as system-level information
6. Agent responds with team knowledge available
7. End of session: surface_count UPSERTs are committed in one batch
```

## Tech Stack

| Component | Technology | Reason |
|-----------|-----------|--------|
| CLI + MCP Server | TypeScript / Node.js | Best MCP SDK support, familiar ecosystem |
| SQLite bindings | better-sqlite3 | Fast, synchronous, reliable; supports `ATTACH DATABASE` |
| FTS | SQLite FTS5 | Built-in, no external deps |
| ID generation | nanoid (8 chars) | Short, collision-unlikely at team scale |
| Fact / interaction storage | SQLite (per-developer files) | Cheap UPSERTs, conflict-free per-author writes, natural cross-dev aggregation via ATTACH |
| Sync | Git (push/pull) | Familiar, works offline, access control via GitHub |

## Local Setup (Per Developer)

- Git clone of team-memory repo at `~/.team-memory/` (configurable).
- Per-developer SQLite files: `facts/facts-<dev>.db` and `interactions/interactions-<dev>.db` — auto-created on first `team-memory add`.
- Local-only `merged_index.db` — auto-created, auto-rebuilt on `git pull`.
- Pre-prompt hook configured in their agent (agent-specific setup).
- MCP server optionally running locally.
- Post-merge git hook installed in `~/.team-memory/.git/hooks/post-merge` to trigger `team-memory rebuild-index`.

## Idle Extract-Facts Hook

**Purpose:** Automatically trigger `/extract-facts` when a session has been idle for 45 seconds, so facts are never lost even if the developer forgets to run it manually before exiting.

**Mechanism:** A `Stop` hook with `asyncRewake: true` installed in `~/.claude/settings.json` by `team-memory join`/`init`.

**Policy:**
- Fires only when **both** conditions are true:
  1. Session has been idle ≥45 seconds (no new Claude response since the hook started)
  2. At least 30 minutes have elapsed since `/extract-facts` last ran
- This prevents interruptions during active work while ensuring facts are captured after any sustained idle period.

**How it works:**
```
Claude responds → Stop hook fires (async, non-blocking)
  → records timestamp to /tmp/tm-activity-$PPID  (THIS session only)
  → sleeps 45 seconds

After 45s:
  ├── Still idle (this session) AND 30min cooldown elapsed?
  │     → exit 2 → asyncRewake fires
  │     → Claude wakes: "Session idle 45s. Run /extract-facts."
  │     → /extract-facts runs automatically
  └── Active OR ran recently → exit 0 → nothing happens
```

**Files used (all scoped to `$PPID` — fully isolated per session):**
- `/tmp/tm-activity-$PPID` — last Claude response timestamp for THIS session only
- `/tmp/tm-extracted-ppid-$PPID` — last extract-facts run for THIS session (30-min cooldown)
- `/tmp/tm-idle.log` — global human-readable log of all hook decisions for debugging

**Multi-session behaviour:**
Each Claude Code session has a unique parent PID (`$PPID`). All state files are scoped to this PID so concurrent sessions never interfere — Session B being active does not prevent Session A from detecting its own idle and firing extract-facts.

**Decisions:**
- `asyncRewake: true` handles background execution — do NOT use `&` in the command, as it causes the main process to exit 0 immediately and the asyncRewake never fires. This is the documented official mechanism for idle wake-up in Claude Code hooks.
- `CLAUDE_SESSION_ID` is not injected into hook environments — `$PPID` is used instead as the session identifier.
- Both the activity file and cooldown file must be `$PPID`-scoped — scoping only one causes cross-session interference (e.g. Session B's responses resetting Session A's idle timer).
- Plain `echo` output from hooks is silently swallowed — hook output must be JSON `{"systemMessage": "..."}` to surface to the user.

## Sync Mechanism

- **Standard git push/pull** — no custom sync infra.
- **Conflict-free writes** — each developer only writes to their own `.db` files. No two devs write to the same file.
- **Binary diffs are imperfect but bounded** — `VACUUM` before commit normalizes page layout; UPSERTs on a fixed-size row set produce small deterministic deltas.
- **Offline-friendly** — commit locally, push when connected.
- **Index rebuild** — triggered by post-merge git hook after pull.
- **Batched commits** — surface-count UPSERTs accumulate during a session and commit once at session end, not per prompt.
- **No auto-push** — developer pushes when ready.

### GitHub access requirement

`team-memory join` clones the repo and sets up all local infrastructure (per-dev DBs, merged index, hooks). However, **pushing facts requires write access on GitHub** — cloning a public repo does not grant push permission.

Each new developer must be added as a collaborator or org member by the repo owner before `team-memory sync --push` will succeed:

```bash
# Repo owner adds a new developer
gh api repos/<org>/<repo>/collaborators/<username> -X PUT -f permission=push
```

Until access is granted, facts accumulate in the developer's local `facts-<dev>.db` and sync automatically once write access is available. No facts are lost.

## Scope Boundaries

### V1 (Build Now)
- Git repo with per-developer SQLite `.db` files (`facts-<dev>.db`, `interactions-<dev>.db`)
- CLI tool (query, add, reject, rebuild-index, prune, sync)
- Local merged index built via SQLite ATTACH + FTS5
- Pre-prompt hook for Claude Code (one agent to start) — both retrieval and surface logging
- Session-end extraction skill (agent proposes facts)
- Trust model: surface count + explicit reject; trust precomputed at index rebuild
- MCP server (thin wrapper over CLI)

### V2 (Later)
- Semantic/vector search (embeddings for better retrieval)
- Session transcript analysis for higher-quality extraction
- Multi-agent hook adapters (Cursor, Copilot, Gemini CLI)
- Heuristic positive signal (citation detection) to complement surface count
- Decay of stale interactions
- Per-project trust scoping
- Reject reasons (audit trail for `explicit_score = -1`)
- Dashboard/UI for browsing and managing facts
- Conflict detection (contradicting facts)
- Team analytics (most-used facts, knowledge gaps)

## Open Questions (Deferred)

1. How does a new team member onboard? (Clone repo + run setup script?)
2. What if two facts contradict each other?
3. How many facts before FTS degrades? (Likely fine up to 10k+)
4. Should facts have an expiry date independent of trust?
5. How to handle facts about deleted/renamed code?
6. What's the right batching cadence for surface-count commits — per-session, hourly, daily?
7. If a developer leaves the team, what happens to `facts-<dev>.db` and `interactions-<dev>.db`? (Archive? Reattribute? Delete?)
