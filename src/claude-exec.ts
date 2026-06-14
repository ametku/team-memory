import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

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

// Pipe a prompt file through `claude --print` and return parsed JSON facts.
// Returns [] on any error (timeout, parse failure, claude not found).
export function invokeClaudeForFacts(
  prompt: string,
  timeoutMs = 120000,
): { content: string; tags: string[] }[] {
  const tmpFile = join(tmpdir(), `tm-claude-${Date.now()}.txt`);
  try {
    writeFileSync(tmpFile, prompt, "utf-8");
    const result = execSync(
      `cat ${JSON.stringify(tmpFile)} | claude --print 2>/dev/null`,
      { encoding: "utf-8", timeout: timeoutMs },
    );
    const stripped = result.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    const raw = extractLastJson(stripped) ?? stripped;
    const obj = JSON.parse(raw);
    return Array.isArray(obj.facts) ? obj.facts : [];
  } catch {
    return [];
  } finally {
    try { rmSync(tmpFile); } catch { /* ok */ }
  }
}
