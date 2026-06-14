import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";
import { invokeClaudeForFacts } from "./claude-exec.js";
import { resolveRepoDir } from "./repo.js";
import { getOptedInEncodedPaths, getOptedInProjects } from "./opt-in.js";
import { isSessionSafe, cleanStaleSentinels } from "./active-sessions.js";
import { addPendingFacts } from "./pending-facts.js";

const LOG_PREFIX = "[extract-bgc]";
const PROCESSED_FILE = "processed-sessions-bgc.json";

function log(msg: string): void {
  process.stdout.write(`${LOG_PREFIX} ${msg}\n`);
}

interface ProcessedState {
  processed: string[];
  failed: Record<string, number>;
}

function loadProcessed(repoDir: string): ProcessedState {
  const path = join(repoDir, PROCESSED_FILE);
  if (!existsSync(path)) return { processed: [], failed: {} };
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return { processed: [], failed: {} }; }
}

function saveProcessed(repoDir: string, state: ProcessedState): void {
  writeFileSync(join(repoDir, PROCESSED_FILE), JSON.stringify(state, null, 2));
}

function findJsonlFilesForEncodedPaths(encodedPaths: string[]): string[] {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];
  const files: string[] = [];
  for (const encoded of encodedPaths) {
    const dir = join(projectsDir, encoded);
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".jsonl")) files.push(join(dir, f));
      }
    } catch { /* skip unreadable */ }
  }
  return files;
}

function deriveProjectFromEncoded(jsonlPath: string, projectPaths: string[]): string {
  const encoded = basename(dirname(jsonlPath));
  for (const projectPath of projectPaths) {
    // Match against the same encoding used in opt-in.registerProject (handles Windows \ too)
    const candidate = projectPath.replace(/[/\\]/g, "-").replace(/^([A-Za-z])-/, "$1");
    if (candidate === encoded) return basename(projectPath);
  }
  return encoded.split("-").at(-1) ?? "unknown";
}

function extractConversationText(filePath: string): { text: string; turns: number } {
  const raw = readFileSync(filePath, "utf-8");
  const parts: string[] = [];
  let turns = 0;
  for (const line of raw.split("\n").filter(l => l.trim())) {
    try {
      const e = JSON.parse(line);
      if (e.type === "user" && typeof e.message?.content === "string" && e.message.content.trim()) {
        parts.push(`[USER]: ${e.message.content}`); turns++;
      } else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
        const text = e.message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        if (text.trim()) { parts.push(`[ASSISTANT]: ${text}`); turns++; }
      }
    } catch { /* skip */ }
  }
  const MB = 1024 * 1024;
  let text = parts.join("\n\n");
  if (text.length > MB) {
    text = text.slice(text.length - MB);
    const b = text.indexOf("\n\n[");
    if (b !== -1) text = text.slice(b + 2);
  }
  return { text, turns };
}

const SYSTEM_PROMPT = `You are a fact extractor for a team knowledge base.

Review this Claude Code conversation and extract 0-3 facts worth saving.

A fact is a decision, correction, gotcha, or convention that emerged from session friction.

DO capture: corrections, gotchas, conventions enforced, decisions with reasons.
DO NOT capture: general docs, ephemeral state, personal preferences, obvious things.

If nothing fits, return { "facts": [] }.

Return JSON only:
{
  "facts": [
    {
      "content": "one declarative sentence, concrete and future-searchable",
      "tags": ["category:<gotcha|convention|tool|workaround|decision>", "kw1", "kw2"]
    }
  ]
}`;

// claude --print runs with Bash tool access. When processing code-heavy sessions
// (e.g. about this codebase), Claude sometimes executes code fragments as shell
function extractFactsWithClaude(text: string): { content: string; tags: string[] }[] {
  return invokeClaudeForFacts(`${SYSTEM_PROMPT}\n\n---\n${text}`);
}

export async function runExtractBgc({ dryRun }: { dryRun: boolean }): Promise<void> {
  const repoDir = resolveRepoDir();
  cleanStaleSentinels();

  const encodedPaths = getOptedInEncodedPaths(repoDir);
  if (encodedPaths.length === 0) {
    process.stderr.write("Warning: no projects opted in. Run `team-memory opt-in` first.\n");
    return;
  }

  const projectPaths = getOptedInProjects(repoDir);
  const state = dryRun ? { processed: [], failed: {} } : loadProcessed(repoDir);
  const allFiles = findJsonlFilesForEncodedPaths(encodedPaths);

  const eligible = allFiles.filter(f => {
    const uuid = basename(f);
    if (state.processed.includes(uuid)) return false;       // already processed
    if ((state.failed[uuid] ?? 0) >= 3) return false;       // failed 3 times
    if (!isSessionSafe(f)) return false;                     // active or too recent
    return true;
  });

  eligible.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const toProcess = eligible.slice(0, 20);

  if (toProcess.length === 0) {
    log("no sessions ready to process (all are active, recent, or already done).");
    return;
  }

  log(`found ${toProcess.length} session(s) to process`);

  let totalFacts = 0;

  for (const file of toProcess) {
    const uuid = basename(file);
    const project = deriveProjectFromEncoded(file, projectPaths);

    log(`processing ${uuid} (project: ${project})`);

    if (dryRun) {
      process.stdout.write(`[dry-run] Session: ${file}\n`);
    }

    const { text, turns } = extractConversationText(file);
    log(`extracted ${turns} turns, ${text.length} chars`);

    if (text.length < 100) {
      log(`skipping — too short`);
      state.processed.push(uuid);
      continue;
    }

    let facts: { content: string; tags: string[] }[];
    try {
      facts = extractFactsWithClaude(text);
      log(`extracted ${facts.length} fact(s)`);
    } catch (e: any) {
      const attempt = (state.failed[uuid] ?? 0) + 1;
      log(`WARNING: ${uuid} failed (attempt ${attempt}/3): ${e.message}`);
      if (!dryRun) { state.failed[uuid] = attempt; saveProcessed(repoDir, state); }
      continue;
    }

    if (dryRun) {
      for (const f of facts) {
        process.stdout.write(`[dry-run] Fact: ${JSON.stringify(f.content)}\n`);
        process.stdout.write(`         Tags: ${JSON.stringify(f.tags)}\n`);
        process.stdout.write(`         Project: ${project}\n`);
      }
    } else if (facts.length > 0) {
      addPendingFacts(repoDir, project, facts.map(f => ({ ...f, session: uuid })));
      totalFacts += facts.length;
      log(`queued ${facts.length} fact(s) for ${project} → run 'team-memory review-pending' to approve`);
      // Log each fact individually so bgc.txt is a full audit trail
      try {
        const logPath = join(repoDir, 'bgc.txt');
        const ts = new Date().toISOString();
        for (const f of facts) {
          appendFileSync(logPath, `[extract-bgc] ${ts} queued [${project}]: "${f.content.slice(0, 120)}"\n`);
        }
      } catch { /* best-effort */ }
    }

    if (!dryRun) {
      state.processed.push(uuid);
      saveProcessed(repoDir, state);
    }
  }

  if (dryRun) {
    process.stdout.write(`[dry-run] done. No changes written.\n`);
  } else {
    const logLine = `[extract-bgc] ${new Date().toISOString()} done — ${totalFacts} fact(s) queued from ${toProcess.length} session(s)`;
    log(logLine.replace('[extract-bgc] ', ''));
    try {
      appendFileSync(join(repoDir, 'bgc.txt'), logLine + '\n');
    } catch { /* best-effort */ }
  }
}
