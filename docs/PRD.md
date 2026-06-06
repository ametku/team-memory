# PRD: Team Memory — Shared Long-Term Knowledge for Coding Agents

## Problem Statement

When a developer learns something during a coding session — a gotcha, a correction they had to make, an architectural decision — that knowledge dies with the session. It lives in one person's head or at best in their personal agent memory. When another team member encounters the same problem days later, they repeat the same mistakes, get the same wrong suggestions from their agent, and waste time rediscovering what a colleague already figured out.

There is no mechanism today for hard-won session lessons to flow automatically from one developer to another through their coding agents.

## Solution

A team-shared long-term memory system that:

1. **Extracts** facts (corrections, gotchas, decisions) from coding sessions automatically
2. **Stores** them in a team-shared git repository as the source of truth
3. **Surfaces** relevant facts proactively in every developer's coding sessions via pre-prompt injection
4. **Ranks** facts by trust score — frequently confirmed facts rise, ignored facts decay and get pruned

The system is agent-agnostic (works with Claude Code, Cursor, Copilot, Gemini CLI), requires no external servers for data storage, and uses familiar developer tools (git, SQLite, TypeScript).

## User Stories

1. As a developer, I want facts my teammate learned about our codebase to appear in my coding sessions, so that I don't repeat their mistakes.
2. As a developer, I want my coding agent to automatically propose facts worth saving at the end of a session, so that I don't have to remember to document things manually.
3. As a developer, I want to approve or reject proposed facts before they enter the shared store, so that low-quality or incorrect information doesn't pollute the team's knowledge.
4. As a developer, I want relevant facts injected into my agent's context automatically on every prompt, so that I benefit from team knowledge without having to search for it.
5. As a developer, I want facts to be concise and actionable, so that they enhance my agent's responses without wasting context window.
6. As a developer, I want to explicitly reject a bad fact via `team-memory reject`, so that it gets demoted in ranking and eventually pruned when multiple developers agree.
7. *(Removed — V1 has no explicit +1 upvote. Surface count serves as the implicit positive signal.)*
8. As a developer, I want facts pruned automatically when they accumulate ≥2 independent rejects, have never been surfaced after 6 months, or haven't been surfaced recently with low total usage, so that the knowledge base stays fresh and relevant.
9. As a developer, I want to use this system regardless of which coding agent I use (Claude Code, Cursor, Copilot), so that I'm not locked into a specific tool.
10. As a developer, I want all team knowledge stored locally (git repo + local SQLite), so that no sensitive codebase knowledge leaves our team's infrastructure.
11. As a developer, I want to query team facts manually via CLI, so that I can browse what the team knows about a topic.
12. As a developer, I want to add a fact manually via CLI, so that I can save knowledge even outside of a coding session.
13. As a developer, I want the pre-prompt retrieval to be fast (<100ms), so that it doesn't add noticeable latency to my coding sessions.
14. As a developer, I want to sync facts with my team via standard git push/pull, so that I don't need additional infrastructure.
15. As a developer, I want facts scoped to specific projects or team-wide, so that project-specific gotchas don't pollute unrelated work.
16. As a developer, I want the system to work offline (commit locally, push later), so that network issues don't block my workflow.
17. As a team lead, I want to see which facts are most used, so that I understand what knowledge gaps exist in our documentation.
18. As a new team member, I want to onboard by cloning the team-memory repo, so that I immediately benefit from all accumulated team knowledge.
19. As a developer, I want the MCP server to expose fact operations as tools, so that my agent can read/write facts mid-session when needed.
20. As a developer, I want facts tagged automatically during extraction, so that retrieval works well without manual categorization effort.
21. As a developer, I want the max surfaced facts per prompt capped at 3-5, so that my agent's context window isn't flooded.
22. As a developer, I want to edit an existing fact (fix a typo, update outdated info), so that facts stay accurate over time.

## Implementation Decisions

### Architecture: Per-Developer SQLite + Local Merged Index

- **Git repository** is the source of truth. Per-developer SQLite files: `facts/facts-<dev>.db` (authored facts) and `interactions/interactions-<dev>.db` (surface counts + explicit rejects). Each developer only writes to their own files → conflict-free.
- **Local merged index** (`merged_index.db`) is the fast-retrieval layer. Each developer has their own local-only index, rebuilt by ATTACHing all `.db` files from the repo and aggregating.
- Trust is **derived at index rebuild time**, not stored as a column on facts.
- See `ARCHITECTURE-V1.md` §1 for the full repo layout and SQL schemas.

### Fact Schema

Each fact is a row in `facts/facts-<dev>.db`:

```sql
CREATE TABLE facts (
  id TEXT PRIMARY KEY,           -- nanoid, 8 chars
  content TEXT NOT NULL,         -- the fact itself, concise and actionable
  project TEXT,                  -- optional project scope
  tags TEXT,                     -- JSON array, auto-generated by extraction agent
  created_at TEXT NOT NULL,      -- ISO 8601
  deleted_at TEXT                -- soft delete; physical deletion on prune
);
```

The author is implicit in which `facts-<dev>.db` file the fact lives in. Trust is not stored on the fact — it is derived at index rebuild time from aggregated interaction signals across all developers.

### Extraction Mechanism (V1)

- The session's own agent proposes facts at session end via a skill/hook.
- No separate extraction service or additional LLM call needed.
- Agent proposes 0-3 candidates; developer approves/edits/rejects inline.
- Approved facts are inserted into `facts-<dev>.db` with default trust = 1.0 (derived from zero interactions).

### Retrieval Mechanism

- **Pre-prompt hook** fires on every user prompt (agent-specific: `UserPromptSubmit` in Claude Code).
- Hook queries local SQLite FTS using the user's message text as query key.
- Top 3-5 facts (ranked by `bm25 * trust`) injected as system context.
- Must complete in <100ms (SQLite FTS5 queries are ~1-5ms).

### Trust Model

Trust is **derived, not stored**. Two signals feed it:

1. **Surface count (automatic):** The pre-prompt hook UPSERTs `surface_count += 1` in `interactions-<dev>.db` every time it injects a fact. Free, deterministic, agent-agnostic.
2. **Explicit reject (manual):** `team-memory reject <fact_id>` sets `explicit_score = -1` in the rejecting developer's `interactions-<dev>.db`.

No explicit `+1` upvote — surface count is the de facto positive signal. Trust is computed at index rebuild time:

```
trust = (1 + log(1 + total_surfaces)) * max(0.1, 1 + 0.5 * net_explicit)
```

**Pruning rules** (each developer prunes only their own authored facts):
- `net_explicit ≤ -2` → delete now (≥2 independent rejects)
- `total_surfaces == 0` AND age > 6 months → delete (never matched any query)
- `last_surfaced_anywhere > 6 months ago` AND `total_surfaces < 5` → delete (briefly relevant, now stale)
- Otherwise → keep (including old facts with positive surface history)

See `RESEARCH-trust-scoring.md` for the full decision trail.

### Write Path

1. Session ends → extraction skill fires
2. Agent proposes fact candidates
3. Developer approves
4. CLI INSERTs row into `facts/facts-<dev>.db` in local git clone
5. CLI VACUUMs and auto-commits
6. Developer pushes when ready (no auto-push)
7. Other developers pull → post-merge hook rebuilds their merged index

### Interfaces

- **CLI** (`team-memory`): `query`, `add`, `reject`, `rebuild-index`, `prune`, `sync`
- **MCP Server**: thin wrapper exposing `search_facts`, `add_fact`, `reject_fact`, `list_facts` as tools
- **Pre-prompt hook**: shell script/binary that calls `team-memory query` and formats output for injection

### Tech Stack

- TypeScript / Node.js for CLI and MCP server
- `better-sqlite3` for SQLite bindings (supports ATTACH DATABASE)
- SQLite FTS5 for full-text search
- nanoid for ID generation
- Per-developer SQLite files for fact and interaction storage (conflict-free writes via per-author ownership)

### Local Setup

- Git clone at `~/.team-memory/` (configurable path)
- Per-developer SQLite files (`facts-<dev>.db`, `interactions-<dev>.db`) auto-created on first `team-memory add`
- Local-only `merged_index.db` auto-created and rebuilt on `git pull`
- Post-merge git hook triggers automatic index rebuild

## Testing Decisions

### What makes a good test

Tests exercise external behavior through the highest available seam. They verify observable outcomes (DB rows created, query results returned, scores changed) — not internal implementation details. Tests use real SQLite databases in temp directories, not mocks.

### Testing seams (highest to lowest)

1. **CLI commands** (primary seam) — integration tests that invoke `team-memory query/add/rebuild-index/prune` as subprocesses and verify outputs + side effects (files created, DB state, git commits). Most tests live here.
2. **SQLite index layer** — given a set of `facts-*.db` and `interactions-*.db` files, verify ATTACH + aggregation + FTS rebuild produces correct merged index. Tests ranking, trust derivation, and FTS relevance.
3. **MCP tool handlers** — given tool call inputs, verify correct results returned (thin wrapper, so fewer tests needed).
4. **Trust derivation logic** — unit tests for the trust formula, surface UPSERT, reject UPSERT, and the three prune predicates.
5. **Fact extraction skill** — given mock session context, verify well-formed fact candidate rows for INSERT are produced.

### Prior art

Standard Node.js test patterns: Vitest or Jest with temp directories for file I/O, in-memory SQLite for fast unit tests, subprocess spawning for CLI integration tests.

## Out of Scope

- **Explicit +1 upvote signal** — V2. Surface count is the implicit positive signal in V1.
- **Agent-side citation detection** — V2. No cheap, reliable, agent-agnostic detector available.
- **Semantic/vector search** — V2 enhancement. V1 uses FTS5 only.
- **Session transcript analysis by separate LLM** — V2. V1 uses the session's own agent.
- **Multi-agent hook adapters** — V1 targets Claude Code only. Cursor/Copilot/Gemini adapters are V2.
- **Dashboard/UI** — no web interface for browsing facts. CLI only for V1.
- **Conflict detection** — contradicting facts are not automatically detected in V1.
- **Team analytics** — no usage dashboards in V1.
- **Authentication/access control** — relies on git repo permissions.
- **Fact expiry dates** — only surface/reject-based pruning, no hard TTL.
- **Reject reasons** — V2. `explicit_score = -1` carries no reason string in V1.

## Further Notes

- The system is designed for teams of 3-15 developers. At larger scale, the flat facts directory and FTS approach may need rethinking.
- Git as sync mechanism means eventual consistency — there's a window between when a fact is committed and when teammates pull it.
- The "no external servers" constraint applies to data storage. Processing (the session agent proposing facts) uses whatever model the developer is already running.
- The post-merge hook for index rebuild means developers don't need to remember to run `rebuild-index` — it happens automatically on `git pull`.
- Facts about renamed/deleted code will naturally decay via the trust scoring system — if no one confirms them, they'll eventually get pruned.
