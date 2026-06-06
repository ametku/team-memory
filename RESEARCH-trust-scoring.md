# Research: Trust Scoring Design

This document captures the decision trail for how Team Memory tracks trust in shared facts. It is the authoritative reference for *why* the trust model looks the way it does in `ARCHITECTURE-V1.md`. Update both together when the design changes.

## Problem

The original V1 sketch stored each fact as a YAML file with a single `trust_score: 1.0` field, mutated in place via increment/decrement. This raised three questions in review:

1. **Storage format** — could SQLite replace YAML so trust updates are cheap and re-indexing across multiple developers is natural?
2. **Sync mechanism** — if SQLite replaces YAML, how does the team continue to share facts?
3. **Signal gathering** — what events actually flow into the trust score, and how is pruning decided?

This file resolves each, in order.

## Decision 1: Storage format and sync mechanism

The single load-bearing constraint is that two developers must be able to add facts independently without binary merge conflicts. Several options were considered:

| Option | Description | Verdict |
|---|---|---|
| (a) Local `.db` per dev, pushed as binary blob through git | One canonical `.db`, last-write-wins on merge | Rejected — the first lost-fact incident kills team trust |
| (b) Central sync server (Litestream / Turso / rqlite) | Real DB replication | Rejected — violates "no external servers for data storage" principle |
| (c) **Per-developer `.db` files in git** | One `.db` per author; nobody writes to anyone else's file | **Accepted** |
| (d) Abandon team sync | Per-developer only | Rejected — kills the differentiator |

**Decision: option (c).** Two consequences fall out:

- Each developer owns a `facts-<dev>.db` file in git. Only that developer writes to it.
- Trust score *cannot* live as a column inside the fact row, because Alice would need to write to Bob's `facts-bob.db` to upvote Bob's fact. Trust must be derived from per-developer interaction tables instead.

**Tradeoff explicitly accepted:** SQLite files diff poorly in git — each commit changes binary pages. Mitigations: `VACUUM` before commit (deterministic page layout), separate fast-changing data (interactions) from slow-changing data (facts) into different files to keep churn isolated.

**Tradeoff explicitly accepted:** Facts are no longer human-readable in PRs. Manual edits go through a SQLite client or the `team-memory` CLI/MCP, not a text editor. The team agreed this is fine — facts are produced and consumed by the team-memory process, not edited by hand.

## Decision 2: Where do interaction signals live?

Three options for how cross-developer trust writes are recorded:

| Option | Description | Verdict |
|---|---|---|
| (a) Trust in author's `.db`, modified via PR | Heavy, kills the "no friction" goal | Rejected |
| (b) **Per-dev `interactions-<dev>.db`, trust derived at query time** | Each dev only writes their own interactions; trust = SUM across all devs | **Accepted** |
| (c) Append-only event log per dev | Same as (b), framed as event sourcing | Rejected — adds aggregation cost without benefit |

**Decision: option (b).** Each developer has an `interactions-<dev>.db` recording their signals on any fact (regardless of who authored it). At index rebuild time, the local merged index aggregates rows across all developers' `interactions-*.db` files. Trust is a derived value, not a stored column.

## Decision 3: What signals flow into trust?

This was the hardest branch. The original architecture said trust goes up "when a developer uses/confirms a fact" and down "when a developer dismisses it" — but both require explicit user action, and developers rarely rate things explicitly. Most facts would sit at zero forever and look prunable.

Options for signal gathering:

| Option | Description | Issue |
|---|---|---|
| (a) Explicit thumbs only | Sparse signal, most facts at 0 forever | Insufficient |
| (b) Surface event + explicit thumbs | Pre-prompt hook logs every injection; thumbs add explicit signal | Heavy git churn from surface events |
| (c) Heuristic positive: "agent cited fact + user didn't push back → +1" | Dense but requires citation detection | Detection is unsolvable cheaply (see below) |
| (d) All three | Maximally informed | Too complex for V1 |

### Why citation detection was rejected

(c) sounds attractive, but every detection mechanism breaks down:

| Detection | Failure mode |
|---|---|
| String match (fact content vs response) | Brittle — agents rephrase, match misses |
| Fact ID markers (`[used: f-abc]`) | Depends on agent compliance — fine on Claude Code, unreliable on Cursor/Copilot/Gemini, breaks the agent-agnostic principle |
| Embedding similarity | Architecture explicitly defers embeddings to V2 |
| LLM judge per response | Unacceptable cost/latency on the hot path |
| Trust-the-agent self-report | Reduces to fact ID markers |

There is no cheap, reliable, agent-agnostic citation detector available in V1. We chose to **drop citation detection entirely** rather than ship a fragile one.

### The core insight

> If a fact keeps matching queries, it's relevant. If it's wrong, someone will explicitly reject it.

Surface count alone is sufficient as a positive signal. We don't need to know whether the agent *used* the fact — we only need to know whether the fact *kept being relevant* to user queries. The pre-prompt hook already knows this, deterministically, with zero agent cooperation.

For negative signal, an explicit `reject` action is enough. Wrong facts produce wrong agent output, developers notice and run `team-memory reject <fact_id>`. We are explicitly betting that developer behavior delivers this signal — without it, bad facts persist.

### Final signal model

Two signals only:

1. **Surface signal (free, automatic).** Pre-prompt hook UPSERTs `(fact_id, surface_count++, last_surfaced_at = now)` into `interactions-<dev>.db` whenever it injects a fact. No agent cooperation required. Works identically across Claude Code, Cursor, Copilot, Gemini.

2. **Explicit reject (rare, manual).** Developer runs `team-memory reject <fact_id>` (or a slash command) when they catch the agent using a bad fact. Sets `explicit_score = -1` in the rejecting developer's `interactions-<dev>.db`.

No `+1` thumbs-up — the friction outweighs the marginal signal. Surface count is the de facto positive signal.

## Final design

### Repo layout

```
team-memory/
├── facts/
│   └── facts-<dev>.db          # only the author writes
├── interactions/
│   └── interactions-<dev>.db   # only the owner writes
├── config.yaml
└── README.md
```

Two separate `.db` files per developer keeps churn isolated: facts change rarely, interactions UPSERT on every prompt.

### Schemas

**`facts-<dev>.db`:**
```sql
CREATE TABLE facts (
  id TEXT PRIMARY KEY,           -- nanoid, 8 chars
  content TEXT NOT NULL,
  project TEXT,
  tags TEXT,                     -- JSON array
  created_at TEXT NOT NULL,
  deleted_at TEXT                -- soft delete; physical delete on prune commit
);
```

**`interactions-<dev>.db`:**
```sql
CREATE TABLE interactions (
  fact_id TEXT PRIMARY KEY,      -- references a fact authored by anyone
  surface_count INTEGER NOT NULL DEFAULT 0,
  last_surfaced_at TEXT NOT NULL,
  explicit_score INTEGER NOT NULL DEFAULT 0   -- only ever decremented to -1 in V1
);
```

One row per `(dev, fact_id)`. UPSERT semantics on every surface event.

### Write paths

| Trigger | Who writes | Action |
|---|---|---|
| Developer adds new fact | `team-memory add` (CLI/MCP) | INSERT into `facts-<dev>.db`, commit + push |
| Pre-prompt hook injects fact `f-X` | hook (automatic) | UPSERT `interactions-<dev>.db`: `surface_count += 1`, `last_surfaced_at = now()` |
| Developer rejects a fact | `team-memory reject <fact_id>` | UPSERT `interactions-<dev>.db`: `explicit_score = -1`, commit + push |
| Pruning decides to delete `f-Y` | `team-memory prune` (run by the fact's author) | DELETE row from `facts-<author>.db`, commit + push |

Every write lands in the developer's own `.db`. Zero cross-developer write contention.

### Read path (every prompt)

Pre-prompt hook queries the **local merged index** (single SQLite DB on the developer's machine, rebuilt on `git pull`):

```sql
SELECT id, content, trust
FROM facts_view
WHERE facts_view MATCH ?
ORDER BY (bm25(facts_view) * trust) DESC
LIMIT 5;
```

`trust` is precomputed at index rebuild time, not per query. Hot-path latency target (<10ms) is preserved.

### Local merged index rebuild (post-merge hook)

Triggered when `git pull` finishes. ATTACHes every `.db` in the repo, aggregates, writes a single local `merged_index.db`:

```sql
ATTACH 'facts/facts-alice.db' AS alice;
ATTACH 'facts/facts-bob.db'   AS bob;
ATTACH 'interactions/interactions-alice.db' AS ialice;
ATTACH 'interactions/interactions-bob.db'   AS ibob;

-- 1. Unified facts (only non-deleted)
CREATE TABLE facts_merged AS
  SELECT * FROM alice.facts WHERE deleted_at IS NULL
  UNION ALL
  SELECT * FROM bob.facts   WHERE deleted_at IS NULL;

-- 2. Aggregate interactions across all developers
CREATE TABLE trust_merged AS
  SELECT
    fact_id,
    SUM(surface_count)     AS total_surfaces,
    MAX(last_surfaced_at)  AS last_surfaced_anywhere,
    SUM(explicit_score)    AS net_explicit
  FROM (
    SELECT * FROM ialice.interactions
    UNION ALL
    SELECT * FROM ibob.interactions
  )
  GROUP BY fact_id;

-- 3. Build FTS5 index, exclude rejected facts, precompute trust
CREATE VIRTUAL TABLE facts_view USING fts5(
  id UNINDEXED, content, tags, project, trust UNINDEXED
);

INSERT INTO facts_view (id, content, tags, project, trust)
SELECT
  f.id, f.content, f.tags, f.project,
  COALESCE(
    (1 + log(1 + t.total_surfaces)) * MAX(0.1, 1 + 0.5 * t.net_explicit),
    1.0
  )
FROM facts_merged f
LEFT JOIN trust_merged t ON f.id = t.fact_id
WHERE COALESCE(t.net_explicit, 0) > -2;   -- rejected facts are excluded
```

This rebuild is the **only place trust is computed**. Per-prompt query is a single FTS5 read.

### Trust formula

```
trust = (1 + log(1 + total_surfaces)) * max(0.1, 1 + 0.5 * net_explicit)
```

- New facts (no interactions yet) get a neutral `trust = 1.0` so they can be discovered.
- Surface count contributes log-scaled — a fact surfaced 100 times doesn't dominate one surfaced 10 times.
- One reject (`net_explicit = -1`) halves the multiplier; the floor of 0.1 prevents negative weights from inverting the ranking.
- Two rejects (`net_explicit ≤ -2`) → fact is excluded from the index and queued for deletion.

### Prune rules

Run by `team-memory prune`. Each developer prunes only their own authored facts.

| Condition | Action |
|---|---|
| `net_explicit ≤ -2` | Delete now (≥2 independent rejects) |
| `total_surfaces == 0` AND `age > 6 months` | Delete (never matched any query) |
| `last_surfaced_anywhere > 6 months ago` AND `total_surfaces < 5` | Delete (briefly relevant, now stale) |
| Otherwise | Keep — including old facts with positive surface history |

The original V1 rule ("old + low trust = prune") was rejected: a 2-year-old fact with high surface count is *evergreen knowledge*, not stale. Age alone is not the prune signal.

The two-reject floor protects against single-developer mistakes. One developer rejecting a fact only demotes ranking; deletion requires independent corroboration.

### Lifecycle example

1. **Day 0** — Alice runs `team-memory add "Use viper for config parsing"`. Inserted into `facts-alice.db`. Pushed.
2. **Day 0–30** — Bob, Carol, Alice all get prompts where FTS matches. Their pre-prompt hooks UPSERT into their respective `interactions-*.db`. Surface counts grow.
3. **Day 12** — Bob notices the agent cited the fact incorrectly for a Python service. Runs `team-memory reject f-a1b2c3`. Bob's `interactions-bob.db` records `explicit_score = -1`.
4. **Day 30** — Carol also rejects. `net_explicit = -2`. On the next pull + index rebuild, the fact is excluded from `facts_view`.
5. **Day 31** — Alice runs `team-memory prune`. Sees `net_explicit ≤ -2`, deletes from `facts-alice.db`, pushes.
6. **Day 32+** — Fact is gone from the team. Orphan interaction rows in Bob's and Carol's files are harmless and get cleaned up at the next interactions VACUUM.

## Tradeoffs explicitly accepted

1. **Bad facts persist until explicitly rejected.** No automatic negative signal. Bet on developer behavior. If rejection rates are too low in practice, V2 can add heuristic detection.

2. **Binary `.db` files in git aren't human-reviewable in PRs.** Mitigation: all writes go through the `team-memory` CLI/MCP; no manual editing expected.

3. **Single-developer rejects don't trigger deletion.** They demote ranking but require a second independent reject to delete. Right floor against single-user mistakes; wrong if a single developer has unique context the team lacks. Acceptable for V1.

4. **Surface count records every injection in git.** Every prompt produces a UPSERT, every UPSERT eventually pushes. Mitigation: aggregation (one row per fact, not one row per surface), `VACUUM` before commit, batched commits (e.g., commit `interactions-<dev>.db` once per session, not per prompt).

5. **Cross-agent compliance is no longer a concern.** Because we removed citation detection, the trust system works identically on any agent that supports a pre-prompt hook. The agent-agnostic principle is preserved.

## Open questions for V2

1. Heuristic positive signals to complement surface count (citation detection via embeddings, structured agent self-report)
2. Decay of stale interactions (do 1-year-old surface events count as much as last week's?)
3. Per-project trust scoping (a fact useful for `payments-service` may be irrelevant for `frontend`)
4. Reverse-lookup: can a developer see *which* of their interactions caused a fact to be deleted?
5. Reject reasons — should `explicit_score = -1` carry a reason string for auditability?
