import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";

export interface InstallHookInput {
  repoDir: string;
}

export interface InstallHookResult {
  hookPath: string;
  installed: boolean;
}

const HOOK_CONTENT = `#!/bin/sh
team-memory rebuild-index >/dev/null 2>&1 || echo "warning: team-memory rebuild-index failed" >&2
`;

export function installPostMergeHook(input: InstallHookInput): InstallHookResult {
  const hooksDir = join(input.repoDir, ".git", "hooks");
  const hookPath = join(hooksDir, "post-merge");

  if (existsSync(hookPath)) {
    return { hookPath, installed: false };
  }

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, HOOK_CONTENT);
  chmodSync(hookPath, 0o755);

  return { hookPath, installed: true };
}
