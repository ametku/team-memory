# team-memory Demo Guide

A step-by-step walkthrough demonstrating every feature using two real developers,
two real video repos, and a shared memory repo.

---

## What you'll prove

| Claim | Where it shows up |
|---|---|
| Facts extracted from real sessions | `/extract-facts` at end of Senior session |
| Facts surfacing for a different developer | Junior session — facts appear as context |
| Same fact surfacing multiple times | Each Junior prompt that matches a fact increments surface count |
| Cross-developer memory | Senior writes, Junior reads |
| Trust growing with surfaces | Dashboard trust bar gets longer each run |
| Dashboard with real data | All facts, authors, categories visible |

---

## Accounts & repos

| Role | GitHub | Email | SSH key |
|---|---|---|---|
| Senior dev | `avinash-newrelic` | mavinash@newrelic.com | `~/.ssh/id_ed25519` |
| Junior dev | `avinashnr-dev` | avinash.newrelic@gmail.com | `~/.ssh/id_ed25519_personal` |

**Video repos (work on these):**
- `~/Documents/Repos/video-agents/video-core-js` → `github.com/newrelic/video-core-js`
- `~/Documents/Repos/video-agents/video-videojs-js` → `github.com/newrelic/video-videojs-js`

**CLI source (team-memory code):**
- `~/Documents/Repos/hckthn/parent/team-memory` on branch `integration/all-features`

---

## Phase 0 — One-time machine setup

### 0.1 — Verify SSH for second account

The personal key (`id_ed25519_personal`) must be added to the `avinashnr-dev` GitHub account.

```bash
# Copy the personal public key
cat ~/.ssh/id_ed25519_personal.pub
# → paste this into https://github.com/settings/keys while logged in as avinashnr-dev

# Verify it works
ssh -T git@github-personal
# Expected: Hi avinashnr-dev! You've successfully authenticated...
```

Your `~/.ssh/config` already has the right alias:
```
Host github-personal
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_personal
```

### 0.2 — Build the latest CLI (integration/all-features)

```bash
cd ~/Documents/Repos/hckthn/parent/team-memory
git checkout integration/all-features
git pull
npm install
npm run build
npm link

team-memory --version   # → 0.2.0
```

### 0.3 — Set up shell profiles for each user context

Add these functions to `~/.zshrc` so you can switch context instantly:

```bash
# Switch to Senior developer context
function tm-senior() {
  export TEAM_MEMORY_DIR=~/Desktop/demo-memory
  export TEAM_MEMORY_DEVELOPER="Aravind Metku"
  export GIT_AUTHOR_NAME="Aravind Metku"
  export GIT_AUTHOR_EMAIL="mavinash@newrelic.com"
  export GIT_COMMITTER_NAME="Aravind Metku"
  export GIT_COMMITTER_EMAIL="mavinash@newrelic.com"
  echo "✓ Context: Senior (Aravind Metku / avinash-newrelic)"
}

# Switch to Junior developer context
function tm-junior() {
  export TEAM_MEMORY_DIR=~/Desktop/demo-memory
  export TEAM_MEMORY_DEVELOPER="Junior Dev"
  export GIT_AUTHOR_NAME="Junior Dev"
  export GIT_AUTHOR_EMAIL="avinash.newrelic@gmail.com"
  export GIT_COMMITTER_NAME="Junior Dev"
  export GIT_COMMITTER_EMAIL="avinash.newrelic@gmail.com"
  echo "✓ Context: Junior (avinashnr-dev)"
}

source ~/.zshrc
```

---

## Phase 1 — Create the shared demo memory repo

**Run as: Senior (avinash-newrelic)**

```bash
tm-senior

# Create and initialize the shared memory repo on GitHub
team-memory init --org avinash-newrelic --repo nrvideo-team-memory --dir ~/Desktop/demo-memory
```

Expected output:
```
Initialized avinash-newrelic/nrvideo-team-memory → ~/Desktop/demo-memory

What was set up:
  • Git repo: ~/Desktop/demo-memory
  • Per-dev facts DB: .../facts/facts-Aravind Metku.db
  • Per-dev interactions DB: .../interactions/interactions-Aravind Metku.db
  • Merged index: .../merged_index.db
  • Post-merge hook: installed
  • Claude hooks: UserPromptSubmit + SessionStart + SessionEnd + Stop(idle)
  • Skill: ~/.claude/skills/extract-facts/SKILL.md
```

**Make it public** (so Junior can join without a collaborator invite):
```bash
gh repo edit avinash-newrelic/nrvideo-team-memory --visibility public
```

**Add Junior as collaborator** (needed to push facts):
```bash
gh api repos/avinash-newrelic/nrvideo-team-memory/collaborators/avinashnr-dev \
   -X PUT -f permission=push
```

---

## Phase 2 — Opt-in the video repos

**Run as: Senior, from each video repo directory**

```bash
tm-senior

# Opt in video-core-js
cd ~/Documents/Repos/video-agents/video-core-js
team-memory opt-in
git add .claude/team-memory.md
git commit -m "chore: opt into team-memory"
# Note: skip push if you don't have write access to newrelic/video-core-js
# The opt-in still works locally for extraction

# Opt in video-videojs-js
cd ~/Documents/Repos/video-agents/video-videojs-js
team-memory opt-in
git add .claude/team-memory.md
git commit -m "chore: opt into team-memory"
```

Verify:
```bash
cat ~/Desktop/demo-memory/opted-in-projects.json
# Should show both video repos registered
```

---

## Phase 3 — Senior Claude session (extract facts)

**Open Claude Code. Rename the session: "Senior — video-core-js"**

Open Claude Code in `video-core-js`:
```bash
cd ~/Documents/Repos/video-agents/video-core-js
# Open Claude Code here (terminal or desktop app)
```

> Make sure `TEAM_MEMORY_DIR=~/Desktop/demo-memory` is in your shell before opening Claude Code.

### Work to do in this session (creates facts worth saving):

Paste these prompts one by one into Claude Code — they are designed to generate interesting corrections and decisions:

**Prompt 1** (triggers a gotcha correction):
```
How should I calculate rebuffering ratio for the quality metrics? Should I average per-session ratios?
```
*When Claude responds, correct it:*
```
No — don't average per-session. Rebuffering ratio is total buffer time divided by total play time across all sessions (ratio of sums, not average of ratios). Long sessions must weight more.
```

**Prompt 2** (triggers a convention):
```
I need to query the latest attribute value from a heartbeat-based metric. Should I use sum() or avg() in NRQL?
```
*After Claude responds, add:*
```
The SDK sends cumulative snapshot attributes per heartbeat. Always use latest() for running totals in session queries, never sum() or avg().
```

**Prompt 3** (triggers a decision):
```
For the error KPI in the dashboard, should we count all errors or only fatal ones?
```
*Steer Claude to the right answer:*
```
Fatal errors only, as a view-based percentage. Warning-level signals exist in the schema but are not used in any KPI.
```

**Prompt 4** (creates a tool/workaround fact):
```
How do I handle the rebuffering calculation when timeSinceRequested is the correct attribute vs bufferingTime?
```
*After response, note:*
```
Use timeSinceRequested for playback failures, not bufferingTime — they measure different things and the NR-533380 bug showed mixing them breaks the calculation.
```

### Extract facts at end of session

At the end, either:
- Wait 2 minutes idle → idle hook triggers extract-bgc automatically (background), OR
- Run manually: `/extract-facts`

When `/extract-facts` runs, Claude will propose facts. **Approve all of them.**

---

## Phase 4 — Junior joins the shared repo

**Open a new terminal. Switch to Junior context.**

```bash
tm-junior

# Join the shared repo
team-memory join https://github.com/avinash-newrelic/nrvideo-team-memory.git \
  --dir ~/Desktop/demo-memory
```

Expected output:
```
Joined https://... → ~/Desktop/demo-memory

What was set up:
  • Git repo cloned: ~/Desktop/demo-memory
  • Per-dev facts DB: .../facts/facts-Junior Dev.db
  • Per-dev interactions DB: .../interactions/interactions-Junior Dev.db
  ...
  • Claude hooks: UserPromptSubmit + SessionStart + SessionEnd + Stop(idle)
  • Skill: ~/.claude/skills/extract-facts/SKILL.md
```

**Opt in the video repos as Junior:**
```bash
cd ~/Documents/Repos/video-agents/video-core-js
TEAM_MEMORY_DIR=~/Desktop/demo-memory \
TEAM_MEMORY_DEVELOPER="Junior Dev" \
team-memory opt-in

cd ~/Documents/Repos/video-agents/video-videojs-js
TEAM_MEMORY_DIR=~/Desktop/demo-memory \
TEAM_MEMORY_DEVELOPER="Junior Dev" \
team-memory opt-in
```

---

## Phase 5 — Junior Claude session (facts surface)

**Open a NEW Claude Code window/session. Rename: "Junior — video-core-js"**

Open in `video-core-js`:
```bash
cd ~/Documents/Repos/video-agents/video-core-js
# Open Claude Code — TEAM_MEMORY_DIR must be set in the shell
```

> The `SessionStart` hook will notify if facts are pending.

### Prompts designed to surface the Senior's facts

Each prompt below will trigger FTS5 matches against the facts Senior saved.
You will see `--- Team Memory Facts ---` injected before Claude responds.

**Surfaces the rebuffering ratio fact:**
```
How do I calculate rebuffering ratio across multiple sessions?
```

**Surfaces the NRQL running totals fact:**
```
What NRQL aggregation should I use for cumulative SDK attributes from heartbeat events?
```

**Surfaces the error KPI fact:**
```
Should the error rate KPI include warning errors or only fatal errors?
```

**Surfaces the timeSinceRequested fact:**
```
I'm calculating playback failure metrics — which SDK attribute should I use for the duration?
```

**Surfaces multiple facts at once (broader query):**
```
I'm building the video quality metrics dashboard — what are the key gotchas with KPI calculations?
```

### Verify fact injection is happening

After each prompt, run in terminal:
```bash
sqlite3 ~/Desktop/demo-memory/interactions/interactions-Junior\ Dev.db \
  "SELECT fact_id, surface_count FROM interactions ORDER BY surface_count DESC;"
# Surface counts increasing each time a fact is injected
```

---

## Phase 6 — Add Junior facts from video-videojs-js

**Junior continues in video-videojs-js session**

```bash
cd ~/Documents/Repos/video-agents/video-videojs-js
# Open Claude Code here as Junior
```

**Prompts that will generate Junior's own facts:**

```
How does the VideoJS plugin handle the player ready state before tracking starts?
```
*Correct Claude:*
```
Always wait for the 'ready' event before initializing the tracker — calling tracker methods before 'ready' causes silent failures on iOS Safari.
```

```
Should I use videojs.players or videojs() to get the player instance for tracking?
```
*Confirm the convention:*
```
Use videojs.players[id] to get an existing player instance — videojs() creates a new one if the element doesn't exist yet.
```

At end of session: **`/extract-facts`** → approve both.

---

## Phase 7 — Senior syncs Junior's facts

**Back in Senior's terminal:**

```bash
tm-senior
team-memory sync   # pulls Junior's facts, rebuilds index
```

Now Senior queries and gets Junior's facts too:
```bash
team-memory query "videojs player ready tracking"
# → [xxxx] (trust: 1.00) Always wait for the 'ready' event...

team-memory query "fatal errors KPI quality"
# → [xxxx] (trust: 2.39) Fatal errors only, view-based percentage...
# trust grew because this fact was surfaced twice by Junior
```

---

## Phase 8 — Generate the dashboard

```bash
tm-senior
team-memory dashboard
# Opens ~/Desktop/demo-memory/dashboard.html in browser
```

**What to show in the dashboard:**

1. **Stats bar**: X facts, 2 contributors (Aravind Metku, Junior Dev), N keywords, today's date
2. **Category pills**: Click "gotcha" — filters to gotcha facts only
3. **Trust bars**: Facts surfaced by Junior have longer trust bars
4. **Author avatars**: Two distinct colored avatars
5. **Members tab → Aravind Metku → Activity**: Shows facts Junior surfaced in his sessions
6. **Members tab → Junior Dev → Authored**: Junior's videojs facts
7. **Tags tab**: Click `category:gotcha` — all gotcha facts with co-occurrence graph
8. **Expand a card**: Shows relative time added, last surfaced, reject command

---

## Phase 9 — Prove repeated surfacing grows trust

**Run Junior session again, same prompts:**

```bash
cd ~/Documents/Repos/video-agents/video-core-js
echo '{"prompt":"rebuffering ratio calculation across sessions"}' | \
  TEAM_MEMORY_DIR=~/Desktop/demo-memory \
  TEAM_MEMORY_DEVELOPER="Junior Dev" \
  bash -c "cd $(pwd) && team-memory preprompt-hook" | \
  python3 -c "
import sys,json
d=json.loads(sys.stdin.buffer.read())
ctx=d.get('hookSpecificOutput',{}).get('additionalContext','(no facts injected)')
print(ctx)
"
```

Then rebuild index and show trust increased:
```bash
team-memory rebuild-index 2>&1
sqlite3 ~/Desktop/demo-memory/merged_index.db \
  "SELECT id, trust FROM facts_view ORDER BY trust DESC LIMIT 5;"
# Trust scores growing for repeatedly-surfaced facts
```

Regenerate dashboard and show larger trust bars:
```bash
team-memory dashboard
```

---

## Phase 10 — extract-bgc (background mining past sessions)

```bash
tm-senior
team-memory extract-bgc --dry-run
# Shows progress: [1/20] ████░░ 5% | video-core-js
# Lists facts it would queue

# Actually run it:
team-memory extract-bgc
# Facts queued to ~/Desktop/demo-memory/pending-facts.json

# Review and approve:
cd ~/Documents/Repos/video-agents/video-core-js
team-memory review-pending
# Shows each fact with source: Claude session (by Aravind Metku)
# y to approve → saved + pushed
```

---

## Switching between users — cheat sheet

| Action | Command |
|---|---|
| Switch to Senior context | `tm-senior` |
| Switch to Junior context | `tm-junior` |
| Verify current context | `echo "Dev: $TEAM_MEMORY_DEVELOPER  Dir: $TEAM_MEMORY_DIR"` |
| Check who git commits as | `git config user.name` |
| Push as avinashnr-dev | Use `git@github-personal:avinashnr-dev/repo.git` as remote |
| Check facts DB for current user | `sqlite3 ~/Desktop/demo-memory/facts/facts-$TEAM_MEMORY_DEVELOPER.db "SELECT count(*) FROM facts"` |

---

## Commands reference during demo

```bash
# Query facts from any directory
team-memory query "rebuffering ratio"

# Show how many facts and who surfaced what
team-memory dashboard --no-open && echo "open ~/Desktop/demo-memory/dashboard.html"

# Check what's been surfaced (interactions)
sqlite3 ~/Desktop/demo-memory/merged_index.db \
  "SELECT id, content, trust FROM facts_view ORDER BY trust DESC LIMIT 10;" | \
  awk -F'|' '{printf "[%s] trust=%.2f  %s\n", $1, $3, substr($2,1,70)}'

# Idle log (shows hook firing)
tail -f ~/Desktop/demo-memory/idle.txt

# bgc log (shows background extractions)
tail -f ~/Desktop/demo-memory/bgc.txt

# Hook errors (if anything goes wrong)
cat ~/Desktop/demo-memory/hooks.log

# Reject a bad fact
team-memory reject <fact-id>

# Reject multiple facts
team-memory reject id1 id2 id3
```

---

## Expected demo flow timeline (~20 min)

| Min | What's happening | What audience sees |
|---|---|---|
| 0–2 | Overview + show `team-memory --help` | 4 execution contexts, all commands |
| 2–5 | Senior session — work on video-core-js, steer Claude | Facts being created live |
| 5–6 | `/extract-facts` — approve 3 facts | Facts saved + pushed |
| 6–8 | Junior joins repo, opts in video repos | `join` output showing all 6 setup steps |
| 8–12 | Junior session — ask video questions | **Facts injecting as `--- Team Memory Facts ---`** |
| 12–13 | Terminal: show surface counts rising | `sqlite3` query showing surface_count |
| 13–16 | Dashboard: open, click through 3 views | Avatars, trust bars, category filters, activity tab |
| 16–18 | `extract-bgc` — mine past sessions | Progress bar `[3/20] ████ 15%` |
| 18–19 | `review-pending` — approve a mined fact | Source: Claude session (by Aravind Metku) |
| 19–20 | Re-generate dashboard — show trust grew | Longer trust bars for surfaced facts |

---

## If something breaks

**Facts not injecting in Junior session:**
```bash
# Test hook directly from project dir
cd ~/Documents/Repos/video-agents/video-core-js
echo '{"prompt":"rebuffering ratio"}' | \
  TEAM_MEMORY_DIR=~/Desktop/demo-memory \
  TEAM_MEMORY_DEVELOPER="Junior Dev" \
  team-memory preprompt-hook
# Check hooks.log if it fails silently
cat ~/Desktop/demo-memory/hooks.log
```

**Index empty:**
```bash
TEAM_MEMORY_DIR=~/Desktop/demo-memory \
TEAM_MEMORY_INDEX_PATH=~/Desktop/demo-memory/merged_index.db \
team-memory rebuild-index
```

**Junior can't push facts:**
```bash
# Confirm collaborator invite was accepted
gh api repos/avinash-newrelic/nrvideo-team-memory/collaborators \
  --jq '.[].login'
```

**Wrong developer writing facts:**
```bash
echo $TEAM_MEMORY_DEVELOPER   # must be set correctly
```
