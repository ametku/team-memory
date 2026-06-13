import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { nanoid } from "nanoid";

const PENDING_FILE = "pending-facts.json";

export interface PendingFact {
  id: string;
  content: string;
  tags: string[];
  session: string;
  extracted_at: string;
}

type PendingStore = Record<string, PendingFact[]>;

function load(repoDir: string): PendingStore {
  const path = join(repoDir, PENDING_FILE);
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
}

function save(repoDir: string, store: PendingStore): void {
  writeFileSync(join(repoDir, PENDING_FILE), JSON.stringify(store, null, 2));
}

export function addPendingFacts(repoDir: string, project: string, facts: Omit<PendingFact, "id" | "extracted_at">[]): void {
  const store = load(repoDir);
  store[project] ??= [];
  for (const fact of facts) {
    store[project].push({
      ...fact,
      id: nanoid(8),
      extracted_at: new Date().toISOString(),
    });
  }
  save(repoDir, store);
}

export function getPendingFacts(repoDir: string, project: string): PendingFact[] {
  return load(repoDir)[project] ?? [];
}

export function hasPendingFacts(repoDir: string, project: string): boolean {
  return getPendingFacts(repoDir, project).length > 0;
}

export function removePendingFacts(repoDir: string, project: string, ids: string[]): void {
  const store = load(repoDir);
  if (store[project]) {
    store[project] = store[project].filter(f => !ids.includes(f.id));
    if (store[project].length === 0) delete store[project];
  }
  save(repoDir, store);
}

export function clearPendingFacts(repoDir: string, project: string): void {
  const store = load(repoDir);
  delete store[project];
  save(repoDir, store);
}

// Mark a session as already handled by /extract-facts so extract-bgc skips it.
// Prevents the same session being proposed twice from different extraction paths.
export function markSessionHandledByExtractFacts(repoDir: string, sessionUuid: string): void {
  const path = join(repoDir, "processed-sessions-bgc.json");
  let state: { processed: string[]; failed: Record<string, number> } = { processed: [], failed: {} };
  if (existsSync(path)) {
    try { state = JSON.parse(readFileSync(path, "utf-8")); } catch { /* ignore */ }
  }
  if (!state.processed.includes(sessionUuid)) {
    state.processed.push(sessionUuid);
    writeFileSync(path, JSON.stringify(state, null, 2));
  }
}
