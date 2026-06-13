import { existsSync, statSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join, basename } from "path";

const SENTINEL_DIR = "/tmp";
const ACTIVE_PREFIX = "tm-active-";    // session is running right now
const DONE_PREFIX   = "tm-done-";      // session ended cleanly via SessionEnd
const STALE_HOURS = 4;                 // active sentinel older than this → treat as stale (crash)
const CRASH_SAFE_MINUTES = 30;         // no clean-end marker → wait this long before processing

export function markSessionActive(sessionId: string): void {
  try { writeFileSync(join(SENTINEL_DIR, `${ACTIVE_PREFIX}${sessionId}`), ""); } catch { /* ok */ }
}

export function markSessionCleanEnd(sessionId: string): void {
  // SessionEnd fired cleanly — safe to process immediately, no age check needed
  try {
    rmSync(join(SENTINEL_DIR, `${ACTIVE_PREFIX}${sessionId}`));
  } catch { /* already gone */ }
  try { writeFileSync(join(SENTINEL_DIR, `${DONE_PREFIX}${sessionId}`), ""); } catch { /* ok */ }
}

function isSentinelStale(path: string): boolean {
  try { return (Date.now() - statSync(path).mtimeMs) / 3600000 > STALE_HOURS; } catch { return true; }
}

export function isSessionActive(sessionId: string): boolean {
  const p = join(SENTINEL_DIR, `${ACTIVE_PREFIX}${sessionId}`);
  if (!existsSync(p)) return false;
  if (isSentinelStale(p)) { try { rmSync(p); } catch { /* ok */ } return false; }
  return true;
}

export function isSessionSafe(jsonlPath: string): boolean {
  const sessionId = basename(jsonlPath, ".jsonl");

  // Gate 1: session is actively running
  if (isSessionActive(sessionId)) return false;

  // Gate 2a: clean-end marker exists → SessionEnd fired → safe immediately
  if (existsSync(join(SENTINEL_DIR, `${DONE_PREFIX}${sessionId}`))) return true;

  // Gate 2b: no clean-end marker → possible crash → require 30-min age as safety net
  try {
    return (Date.now() - statSync(jsonlPath).mtimeMs) / 60000 >= CRASH_SAFE_MINUTES;
  } catch { return false; }
}

export function cleanStaleSentinels(): void {
  try {
    readdirSync(SENTINEL_DIR)
      .filter(f => f.startsWith(ACTIVE_PREFIX) || f.startsWith(DONE_PREFIX))
      .forEach(f => {
        const p = join(SENTINEL_DIR, f);
        if (isSentinelStale(p)) try { rmSync(p); } catch { /* ok */ }
      });
  } catch { /* /tmp inaccessible */ }
}
