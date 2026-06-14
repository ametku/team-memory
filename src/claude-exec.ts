import { spawnSync } from "child_process";

// claude --print runs with Bash tool access. When session transcripts contain
// code fragments, Claude sometimes executes them as shell commands, producing
// /bin/sh: ... errors on stdout before the actual JSON response.
// This finds the last complete top-level JSON object in the output, skipping noise.
export function extractLastJson(output: string): string | null {
  let depth = 0;
  let start = -1;
  let last: string | null = null;
  for (let i = 0; i < output.length; i++) {
    if (output[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (output[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        last = output.slice(start, i + 1);
      }
    }
  }
  return last;
}

// Pipe a prompt directly to `claude --print` via stdin using spawnSync.
// No shell, no temp file, no platform-specific pipe syntax — works on
// macOS, Linux, and Windows.
// Returns [] on any error (timeout, parse failure, claude not found).
export function invokeClaudeForFacts(
  prompt: string,
  timeoutMs = 120000,
): { content: string; tags: string[] }[] {
  try {
    const result = spawnSync("claude", ["--print"], {
      input: prompt,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error || !result.stdout) return [];
    const stripped = result.stdout.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    const raw = extractLastJson(stripped) ?? stripped;
    const obj = JSON.parse(raw);
    return Array.isArray(obj.facts) ? obj.facts : [];
  } catch {
    return [];
  }
}
