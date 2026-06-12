# QA: Project Opt-In (`team-memory opt-in`)

Assumes `TEAM_MEMORY_DIR` is set and `team-memory` is on PATH.

## Prerequisites — GitHub access

**Before a developer can push facts to the shared repo, they must be added as a collaborator or org member by the repo owner.**

`team-memory join` clones the repo and sets up all local infrastructure. But `team-memory sync --push` (and any `git push` to the remote) requires write access on GitHub. Cloning a public repo does not grant push permission.

**Repo owner runs once per new developer:**
```bash
# Add a specific collaborator
gh api repos/<org>/<repo>/collaborators/<username> -X PUT -f permission=push

# Or via GitHub UI:
# Settings → Collaborators → Add people
```

**Symptom if missing:**
```
remote: Permission to <org>/<repo>.git denied to <username>.
fatal: unable to access '...': The requested URL returned error: 403
```

**Until access is granted:** facts are committed locally in `facts-<dev>.db` and will sync automatically the next time `team-memory sync --push` succeeds. No facts are lost.

---

---

## Test 1: Opt in a project

```bash
cd ~/repos/my-service
team-memory opt-in
```

**Expected output:**
```
Opted in: /Users/you/repos/my-service
Created: /Users/you/repos/my-service/.claude/team-memory.md
Tip: commit .claude/team-memory.md so teammates are opted in too.
```

**Verify:**
```bash
cat ~/repos/my-service/.claude/team-memory.md
# Expected: content explaining the opt-in

cat $TEAM_MEMORY_DIR/opted-in-projects.json
# Expected: { "/Users/you/repos/my-service": "-Users-you-repos-my-service" }
```

---

## Test 2: Idempotent — running twice is safe

```bash
team-memory opt-in   # first run
team-memory opt-in   # second run
```

**Expected second run output:**
```
Already opted in: /Users/you/repos/my-service
```

No duplicate entries in `opted-in-projects.json`.

---

## Test 3: Not in a git repo → clear error

```bash
cd /tmp
team-memory opt-in
```

**Expected:** exits 1 with message:
```
Error: not in a git repository. Run this from your project directory.
```

---

## Test 4: extract-bg respects opt-in

```bash
# With no projects opted in (empty or missing registry)
rm $TEAM_MEMORY_DIR/opted-in-projects.json
NERD_COMPLETION_API_KEY=<key> team-memory extract-bg
```

**Expected:**
```
Warning: no projects opted in. Run `team-memory opt-in` from your project directory first.
```
No sessions processed.

```bash
# After opting in
team-memory opt-in
NERD_COMPLETION_API_KEY=<key> team-memory extract-bg --dry-run
```

**Expected:** only shows sessions from the opted-in project's directory. Sessions from other projects are silently skipped.

---

## Test 5: join auto-opts-in current project

```bash
cd ~/repos/my-service
team-memory join <repo-url>
```

**Verify after join:**
```bash
cat ~/repos/my-service/.claude/team-memory.md    # marker created
cat $TEAM_MEMORY_DIR/opted-in-projects.json       # project registered
```

---

## Test 6: Commit the marker so teammates are opted in

```bash
git -C ~/repos/my-service add .claude/team-memory.md
git -C ~/repos/my-service commit -m "chore: opt into team-memory"
git -C ~/repos/my-service push
```

When a teammate pulls and runs `team-memory join`, they see the marker and know the project is opted in. They run `team-memory opt-in` to register it in their local registry.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `extract-bg` skips all sessions | No projects opted in | Run `team-memory opt-in` from your project |
| `extract-bg` skips sessions from a specific repo | Repo not in registry | `cd <repo> && team-memory opt-in` |
| `opted-in-projects.json` missing | Never opted in | Run `team-memory opt-in` |
| Opt-in fails with "not in a git repo" | Running from wrong directory | `cd` into your project first |
