import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";

function realpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

const MARKER_PATH = ".claude/team-memory.md";
const REGISTRY_FILE = "opted-in-projects.json";

const MARKER_CONTENT = `# team-memory opt-in

This project is opted into team-memory. Claude sessions here feed the shared team fact store.

- Run \`team-memory extract-bg\` to extract facts from past Claude sessions in this project.
- Run \`team-memory extract-slack\` to extract facts from Slack threads matching your queries.
- Commit this file so all teammates are opted in automatically.
`;

export function isOptedIn(projectRoot: string): boolean {
  return existsSync(join(realpath(projectRoot), MARKER_PATH));
}

export function createOptInMarker(projectRoot: string): boolean {
  const resolved = realpath(projectRoot);
  const markerPath = join(resolved, MARKER_PATH);
  if (existsSync(markerPath)) return false;
  mkdirSync(join(resolved, ".claude"), { recursive: true });
  writeFileSync(markerPath, MARKER_CONTENT);
  return true;
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
