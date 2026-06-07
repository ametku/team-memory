---
name: extract-facts
description: Review the current Claude Code conversation and propose 0-3 fact candidates to save into team-memory. Use when the user invokes /extract-facts, says "extract facts" / "save what we learned", or at session end before quitting.
---

# Extract Facts

Walk the developer through saving 0-3 team-memory facts surfaced from this session.

## What to capture

A fact is a **decision, correction, gotcha, or convention that emerged from session friction** — something Claude got wrong, or something the developer had to explicitly steer.

Look for:
- Corrections the user made ("no, use X not Y")
- Gotchas hit (a config that bit, a flaky step, a non-obvious dependency)
- Conventions enforced ("always do X in this repo")
- Decisions reached and the reason behind them

Do NOT capture:
- General documentation (belongs in CLAUDE.md / docs)
- Ephemeral state ("the deploy is broken right now")
- Personal taste / preferences not affecting the team
- Things obvious from reading the code

If nothing in the conversation fits, exit with one line: `Nothing worth saving from this session.`

## Workflow

1. **Scan the conversation.** Identify up to 3 candidates. For each, draft:
   - `content` — one declarative sentence. Concrete; future-searchable.
   - `project` — basename of the current git repo (`git rev-parse --show-toplevel | xargs basename`). If not in a git repo, omit `--project` (saves as team-wide).
   - `tags` — `["category:<enum>", "kw1", "kw2", "kw3"]` (3-5 keywords).

2. **Tag rules:**
   - Category enum (exactly one): `gotcha | convention | tool | workaround | decision`
   - 3-5 keyword tags. Each keyword = an alternative search term someone would type to find this fact, that is **NOT already a word in the content**. Synonyms, related concepts, broader category words.
   - Ask yourself: "what would a teammate search for to find this?"

3. **For each candidate, ask the user.** Use `AskUserQuestion` with options: Approve, Edit, Reject.
   - Approve → keep candidate as drafted
   - Edit → ask which field (content / project / tags), prompt for new value, re-show
   - Reject → discard silently, move on

4. **Save approved facts.** Run once per approved candidate:
   ```
   team-memory add "<content>" [--project <p>] --tags '<json-array>'
   ```
   Each `add` commits locally. Do **not** push between facts.

5. **Push once at the end.** After all approved facts are saved, run a single:
   ```
   team-memory sync --push
   ```
   This pushes the batch and rebuilds the local index.

6. **Errors.** If `team-memory` is not on PATH, surface the error verbatim and tell the user to install it (`npm install -g` or local link). Do not silently swallow.

## Example candidate

For a session where the user corrected Claude after it tried `docker-compose` (hyphenated):

- content: `Use 'docker compose' (no hyphen) on this machine — Rancher Desktop`
- project: `team-memory` (or whatever the CWD repo basename is)
- tags: `["category:gotcha", "rancher", "container", "cli"]`

Note: `docker`, `compose`, and `hyphen` are already in the content, so they are not in the tag list.

## See also

- Fact definition: `ARCHITECTURE-V1.md` lines 16-30
- CLI reference: `team-memory --help`
