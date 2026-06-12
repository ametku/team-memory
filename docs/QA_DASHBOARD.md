# QA: `team-memory dashboard`

Assumes base setup is complete (`team-memory join` done, `TEAM_MEMORY_DIR` is set).

---

## Pre-flight

```bash
# Confirm TEAM_MEMORY_DIR is set
echo $TEAM_MEMORY_DIR
# Expected: path to your team-memory clone (e.g. /Users/you/.team-memory)

# Confirm the merged index exists (run sync first if not)
ls $TEAM_MEMORY_DIR/merged_index.db
# Expected: file exists

# If missing, rebuild it
team-memory sync
```

---

## Test 1: Basic generation

```bash
team-memory dashboard --no-open
```

**Expected output:**
```
Dashboard: <N> facts from <M> author(s) → /Users/you/.team-memory/dashboard.html
```

**Verify:**
```bash
ls -lh $TEAM_MEMORY_DIR/dashboard.html
# Expected: file exists, non-zero size (typically 100KB–1MB depending on fact count)
```

---

## Test 2: Opens in browser (default behaviour)

```bash
team-memory dashboard
```

**Expected:** `dashboard.html` is written **and** your default browser opens it automatically.

---

## Test 3: Team View — facts are visible

Open `dashboard.html` in a browser (or run Test 2 above).

1. The **Team View** is shown by default.
2. Stats bar shows total fact count, contributor count, and tag count.
3. Fact cards are listed sorted by trust (highest first).
4. Each card shows: content, author, tags as chips, trust score, surface count.

**Verify a specific fact:**
```bash
# Add a test fact
team-memory add "dashboard smoke test fact" --project test-project
team-memory rebuild-index

# Regenerate dashboard
team-memory dashboard --no-open

# Confirm fact appears in the HTML
grep "dashboard smoke test fact" $TEAM_MEMORY_DIR/dashboard.html
# Expected: line found
```

---

## Test 4: Search and filter

In the browser:

1. Type part of a fact's content into the search box — matching cards remain, others hide.
2. Select a project from the project dropdown — only facts scoped to that project (and team-wide facts) appear.
3. Change sort to **Date** — cards reorder by `created_at` descending.
4. Change sort to **Surfaces** — cards reorder by surface count descending.
5. Clear the search box — all facts return.

---

## Test 5: Tag navigation

1. Click any tag chip on a fact card.
2. **Expected:** navigates to the **Tags** view showing only facts with that tag, sorted by trust.
3. A related-tags sidebar shows tags that frequently appear alongside the current one.
4. Click **← All Tags** — returns to the full Tag Index.
5. In the Tag Index, each tag shows a count badge. Higher-frequency tags appear first.

---

## Test 6: Members view

1. Click **Members** in the top nav.
2. Sidebar lists all contributors with their fact counts.
3. Click a contributor — their profile loads on the right.
4. **Authored tab** shows facts they added, sorted by trust.
5. **Activity tab** shows the most-surfaced facts across the team.
6. Click a fact card's author name from Team View — navigates directly to that author's profile.

---

## Test 7: Fact card expand / reject command

1. Click any fact card — it expands to show full detail.
2. Expanded view shows: date added, last surfaced date, reject count.
3. A `team-memory reject <id>` command is shown.
4. Click it — text is copied to clipboard (`✓ Copied!` flash confirms).
5. Paste into terminal and run — the fact is rejected.

---

## Test 8: Regeneration picks up new facts

```bash
# Add a new fact
team-memory add "new fact added after initial dashboard" --project myrepo
team-memory rebuild-index

# Regenerate
team-memory dashboard --no-open

# Confirm it appears
grep "new fact added after initial dashboard" $TEAM_MEMORY_DIR/dashboard.html
# Expected: line found
```

This confirms the dashboard is always fresh — it reads all DBs at generation time.

---

## Test 9: WAL files are not committed

```bash
# After generating the dashboard, check git status in the team-memory repo
git -C $TEAM_MEMORY_DIR status
```

**Expected:** `dashboard.html`, `merged_index.db`, `*.db-shm`, and `*.db-wal` do NOT appear in the output. Only your `facts-<dev>.db` and `interactions-<dev>.db` changes show as committable.

---

## Test 10: `--no-open` flag for CI / non-interactive use

```bash
team-memory dashboard --no-open
```

**Expected:** file is written, no browser opens, process exits cleanly with code 0. Safe to use in scripts and automated pipelines.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `0 facts from 0 author(s)` | `merged_index.db` is empty or missing | Run `team-memory sync` then regenerate |
| Facts appear but no author names | `facts-*.db` files missing from `facts/` dir | Run `team-memory sync` to pull teammates' DBs |
| Browser doesn't open | `open` / `xdg-open` not on PATH | Use `--no-open` and open the file manually |
| `*.db-shm` shows in git status | `.gitignore` not present in team-memory repo | Add `*.db-shm` and `*.db-wal` to `.gitignore` |
