import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { queryFacts } from "./query.js";
import { logSurfaces } from "./surface-logging.js";
import { isOptedIn } from "./opt-in.js";
import { isQualifyingPrompt } from "./slack-trigger.js";

export interface PrepromptInput {
  prompt: string;
  indexPath: string;
  repoDir: string;
  developer: string;
  project?: string;
  projectRoot?: string;
}

export interface PrepromptOutput {
  continue: true;
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

export function runPrepromptHook(input: PrepromptInput): PrepromptOutput {
  try {
    return _runPrepromptHook(input);
  } catch {
    return { continue: true };
  }
}

function _runPrepromptHook(input: PrepromptInput): PrepromptOutput {
  const { prompt, indexPath, repoDir, developer, project, projectRoot } = input;

  // Gate everything on opt-in — if we know the project root and it's not opted in, do nothing
  if (projectRoot && !isOptedIn(projectRoot)) {
    return { continue: true };
  }

  if (!existsSync(indexPath)) {
    return { continue: true };
  }

  const results = queryFacts({ indexPath, query: prompt, limit: 5, project });
  const qualifying = isQualifyingPrompt(prompt);

  if (results.length === 0 && !qualifying) {
    return { continue: true };
  }

  const lines: string[] = [];

  if (results.length > 0) {
    logSurfaces(join(repoDir, "interactions"), developer, results.map((r) => r.id));
    lines.push("--- Team Memory Facts ---");
    for (const r of results) {
      lines.push(`[${r.id}] ${r.content}`);
    }
  }

  if (qualifying) {
    if (lines.length > 0) lines.push("");
    lines.push("--- Slack Background Search ---");
    lines.push(
      "This prompt looks like a question, debugging session, or architecture decision. " +
      "Please spawn a background Slack search agent using the Agent tool with run_in_background: true. " +
      "The agent should: search Slack for threads relevant to this prompt, read the top 3 threads, " +
      "record each via `team-memory slack-record --url <url> --summary \"<one sentence>\" --prompt \"<original prompt>\"`, " +
      "then surface the links and summaries as a follow-up message."
    );
  }

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: lines.join("\n"),
    },
  };
}

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
