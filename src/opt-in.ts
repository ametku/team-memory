import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";

function realpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

const MARKER_PATH = ".claude/team-memory.md";
const LOCAL_DIR_FILE = ".claude/.team-memory-dir";
const REGISTRY_FILE = "opted-in-projects.json";

const MARKER_CONTENT = `# team-memory opt-in

This project is opted into team-memory. Claude sessions here feed the shared team fact store.

Commit this file — teammates are opted in automatically when they pull it.

After pulling, each teammate runs once from this directory:
  team-memory opt-in

This registers the project locally and creates .claude/.team-memory-dir (gitignored)
so all team-memory commands work from this directory without setting TEAM_MEMORY_DIR.
`;

// Gitignore entry for the local dir pointer file
const GITIGNORE_ENTRY = ".team-memory-dir\n";

export function isOptedIn(projectRoot: string): boolean {
  return existsSync(join(realpath(projectRoot), MARKER_PATH));
}

export function createOptInMarker(projectRoot: string): boolean {
  const resolved = realpath(projectRoot);
  const claudeDir = join(resolved, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const markerPath = join(resolved, MARKER_PATH);
  const created = !existsSync(markerPath);
  if (created) writeFileSync(markerPath, MARKER_CONTENT);
  return created;
}

// Write the machine-local dir pointer so commands auto-discover TEAM_MEMORY_DIR
// when run from this project. This file is gitignored — each developer gets
// their own copy pointing to their local team-memory clone.
export function writeLocalDirPointer(projectRoot: string, repoDir: string): void {
  const resolved = realpath(projectRoot);
  const claudeDir = join(resolved, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(resolved, LOCAL_DIR_FILE), repoDir + "\n");

  // Add .team-memory-dir to .claude/.gitignore so the local file isn't committed
  const gitignorePath = join(claudeDir, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  if (!existing.includes(".team-memory-dir")) {
    writeFileSync(gitignorePath, existing + GITIGNORE_ENTRY);
  }
}

type Registry = Record<string, string>;

function loadRegistry(repoDir: string): Registry {
  const path = join(repoDir, REGISTRY_FILE);
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
}

function saveRegistry(repoDir: string, registry: Registry): void {
  writeFileSync(join(repoDir, REGISTRY_FILE), JSON.stringify(registry, null, 2));
}

export function registerProject(repoDir: string, projectRoot: string): void {
  const resolved = realpath(projectRoot);
  // Replace both forward and backward slashes (Windows uses backslashes),
  // and strip the drive-letter colon on Windows (C: → C)
  // so the encoded name matches what Claude Code uses for session directories.
  const encoded = resolved.replace(/[/\\]/g, "-").replace(/^([A-Za-z])-/, "$1");
  const registry = loadRegistry(repoDir);
  registry[resolved] = encoded;
  saveRegistry(repoDir, registry);
}

export function getOptedInEncodedPaths(repoDir: string): string[] {
  return Object.values(loadRegistry(repoDir));
}

export function getOptedInProjects(repoDir: string): string[] {
  return Object.keys(loadRegistry(repoDir));
}
