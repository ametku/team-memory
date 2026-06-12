import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

export interface SlackThread {
  url: string;
  summary: string;
  prompt: string;
  surfaced_at: string;
}

export interface SlackSession {
  threads: SlackThread[];
}

const SESSION_FILE = "slack-surface-session.json";

export function recordThread(repoDir: string, thread: Omit<SlackThread, "surfaced_at">): void {
  const path = join(repoDir, SESSION_FILE);
  const session: SlackSession = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf-8"))
    : { threads: [] };

  session.threads.push({ ...thread, surfaced_at: new Date().toISOString() });
  writeFileSync(path, JSON.stringify(session, null, 2));
}

export function loadSession(repoDir: string): SlackSession | null {
  const path = join(repoDir, SESSION_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function clearSession(repoDir: string): void {
  const path = join(repoDir, SESSION_FILE);
  if (existsSync(path)) rmSync(path);
}
