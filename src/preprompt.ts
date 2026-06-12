import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { queryFacts } from "./query.js";
import { logSurfaces } from "./surface-logging.js";
import { isOptedIn } from "./opt-in.js";

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

  if (results.length === 0) {
    return { continue: true };
  }

  logSurfaces(join(repoDir, "interactions"), developer, results.map((r) => r.id));

  const lines = ["--- Team Memory Facts ---"];
  for (const r of results) {
    lines.push(`[${r.id}] ${r.content}`);
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
