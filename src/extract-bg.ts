import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import * as readline from "readline";
import { resolveRepoDir } from "./repo.js";

const LOG_PREFIX = "[extract-bg]";

function log(msg: string): void {
  process.stdout.write(`${LOG_PREFIX} ${msg}\n`);
}

interface State {
  processed: string[];
  failed: Record<string, number>;
}

function loadState(stateFile: string): State {
  if (!existsSync(stateFile)) {
    return { processed: [], failed: {} };
  }
  try {
    return JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    return { processed: [], failed: {} };
  }
}

function saveState(stateFile: string, state: State): void {
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function findJsonlFiles(): string[] {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) {
    return [];
  }
  const files: string[] = [];
  for (const encodedProject of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, encodedProject);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
      for (const file of readdirSync(projectDir)) {
        if (file.endsWith(".jsonl")) {
          files.push(join(projectDir, file));
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }
  return files;
}

function deriveProject(jsonlPath: string): string {
  const encoded = basename(dirname(jsonlPath));
  return encoded.split("-").at(-1) ?? "unknown";
}

function extractConversationText(filePath: string): { text: string; turns: number; truncated: boolean } {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(l => l.trim());
  const parts: string[] = [];
  let turns = 0;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === "user") {
      const content = entry.message?.content;
      if (typeof content === "string" && content.trim()) {
        parts.push(`[USER]: ${content}`);
        turns++;
      }
    } else if (entry.type === "assistant") {
      const contentArr = entry.message?.content;
      if (Array.isArray(contentArr)) {
        const textBlocks = contentArr
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        if (textBlocks.trim()) {
          parts.push(`[ASSISTANT]: ${textBlocks}`);
          turns++;
        }
      }
    }
  }

  const MB = 1024 * 1024;
  let text = parts.join("\n\n");
  let truncated = false;

  if (text.length > MB) {
    text = text.slice(text.length - MB);
    const boundary = text.indexOf("\n\n[");
    if (boundary !== -1) {
      text = text.slice(boundary + 2);
    }
    truncated = true;
  }

  return { text, turns, truncated };
}

interface Fact {
  content: string;
  tags: string[];
}

const SYSTEM_PROMPT = `You are a fact extractor for a team knowledge base.

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
- 2-4 keyword tags: alternative search terms NOT already present as words in the content`;

async function callNerdCompletion(baseUrl: string, apiKey: string, text: string): Promise<Fact[]> {
  const start = Date.now();
  log(`calling NerdCompletion (model: claude-4-5-sonnet, ${text.length} chars)`);

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-4-5-sonnet",
      max_tokens: 1024,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  const elapsed = Date.now() - start;
  log(`response: HTTP ${res.status} in ${elapsed}ms`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }

  const body = await res.json();
  const raw = body.choices[0].message.content;
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.facts)) {
    throw new Error(`Unexpected response shape: ${JSON.stringify(parsed)}`);
  }

  return parsed.facts as Fact[];
}

export async function runExtractBg({ dryRun }: { dryRun: boolean }): Promise<void> {
  const apiKey = process.env.NERD_COMPLETION_API_KEY;
  if (!apiKey) {
    process.stderr.write("Error: NERD_COMPLETION_API_KEY is not set.\n");
    process.exit(1);
  }

  const baseUrl =
    process.env.NERD_COMPLETION_BASE_URL ??
    "https://nerd-completion.staging-service.nr-ops.net";

  const stateFile = join(resolveRepoDir(), "processed-sessions.json");
  const state = dryRun ? null : loadState(stateFile);

  const allFiles = findJsonlFiles();

  let toProcess: string[];
  if (dryRun) {
    if (allFiles.length === 0) {
      log("no sessions found.");
      return;
    }
    allFiles.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    toProcess = [allFiles[0]];
  } else {
    toProcess = allFiles.filter(f => {
      const name = basename(f);
      return !state!.processed.includes(name) && (state!.failed[name] ?? 0) < 3;
    });
  }

  if (toProcess.length === 0) {
    log("no sessions found.");
    return;
  }

  log(`found ${toProcess.length} session(s) to process`);

  let rl: readline.Interface | null = null;

  async function confirmPrompt(question: string): Promise<boolean> {
    if (!rl) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    return new Promise(resolve => {
      rl!.question(question, answer => {
        resolve(answer === "y" || answer === "Y");
      });
    });
  }

  let totalFacts = 0;

  for (const file of toProcess) {
    const uuid = basename(file);
    const project = deriveProject(file);

    log(`parsing ${uuid} (project: ${project})`);

    if (dryRun) {
      process.stdout.write(`[dry-run] Session: ${file}\n`);
      const yes = await confirmPrompt(
        `[dry-run] Parse this session and extract conversation text? (y/n): `
      );
      if (!yes) {
        log("skipped.");
        break;
      }
    }

    const { text, turns, truncated } = extractConversationText(file);
    log(`extracted ${turns} turns, ${text.length} chars (truncated: ${truncated ? "yes" : "no"})`);

    if (dryRun) {
      process.stdout.write(
        `[dry-run] Extracted ${turns} turns, ${text.length.toLocaleString()} chars.\n`
      );
      const yes = await confirmPrompt(
        `[dry-run] Send to NerdCompletion (claude-4-5-sonnet)? (y/n): `
      );
      if (!yes) {
        log("skipped API call.");
        break;
      }
    }

    let facts: Fact[];
    try {
      facts = await callNerdCompletion(baseUrl, apiKey, text);
      log(`extracted ${facts.length} facts`);
    } catch (err: any) {
      const attempt = (state?.failed[uuid] ?? 0) + 1;
      log(`WARNING: ${uuid} failed (attempt ${attempt}/3): ${err.message}`);
      if (!dryRun) {
        state!.failed[uuid] = attempt;
        saveState(stateFile, state!);
      }
      continue;
    }

    for (let i = 0; i < facts.length; i++) {
      const fact = facts[i];

      if (dryRun) {
        process.stdout.write(`[dry-run] Fact ${i + 1}/${facts.length}:\n`);
        process.stdout.write(`  content: ${JSON.stringify(fact.content)}\n`);
        process.stdout.write(`  tags:    ${JSON.stringify(fact.tags)}\n`);
        process.stdout.write(`  project: ${project}\n`);
        const yes = await confirmPrompt(`[dry-run] Save this fact? (y/n): `);
        if (!yes) {
          log("skipped fact.");
          continue;
        }
        process.stdout.write(
          `[dry-run] would run: team-memory add ${JSON.stringify(fact.content)} --project ${project} --tags '${JSON.stringify(fact.tags)}'\n`
        );
      } else {
        log(`saving fact: "${fact.content}"`);
        try {
          execSync(
            `team-memory add ${JSON.stringify(fact.content)} --project ${project} --tags '${JSON.stringify(fact.tags)}'`,
            { stdio: "inherit" }
          );
          totalFacts++;
        } catch (err: any) {
          log(`WARNING: failed to save fact: ${err.message}`);
        }
      }
    }

    if (!dryRun) {
      state!.processed.push(uuid);
      saveState(stateFile, state!);
      log(`marked ${uuid} as processed`);
    }
  }

  if (rl) (rl as readline.Interface).close();

  if (dryRun) {
    process.stdout.write("[dry-run] done. No changes written.\n");
  } else {
    log("syncing...");
    execSync("team-memory sync --push", { stdio: "inherit" });
    log(`done. ${totalFacts} facts saved from ${toProcess.length} sessions.`);
  }
}
