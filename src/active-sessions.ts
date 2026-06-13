import { existsSync, statSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join, basename } from "path";

const SENTINEL_DIR = "/tmp";
const SENTINEL_PREFIX = "tm-active-";
const STALE_HOURS = 4;
const SAFE_AGE_MINUTES = 30;

export function markSessionActive(sessionId: string): void {
  try {
    writeFileSync(join(SENTINEL_DIR, `${SENTINEL_PREFIX}${sessionId}`), "");
  } catch { /* /tmp not writable */ }
}

export function markSessionInactive(sessionId: string): void {
  try { rmSync(join(SENTINEL_DIR, `${SENTINEL_PREFIX}${sessionId}`)); } catch { /* already gone */ }
}

function isSentinelStale(sentinelPath: string): boolean {
  try {
    return (Date.now() - statSync(sentinelPath).mtimeMs) / 3600000 > STALE_HOURS;
  } catch { return true; }
}

export function isSessionActive(sessionId: string): boolean {
  const p = join(SENTINEL_DIR, `${SENTINEL_PREFIX}${sessionId}`);
  if (!existsSync(p)) return false;
  if (isSentinelStale(p)) { try { rmSync(p); } catch { /* ok */ } return false; }
  return true;
}

export function isSessionSafe(jsonlPath: string): boolean {
  if (isSessionActive(basename(jsonlPath, ".jsonl"))) return false;
  try {
    return (Date.now() - statSync(jsonlPath).mtimeMs) / 60000 >= SAFE_AGE_MINUTES;
  } catch { return false; }
}

export function cleanStaleSentinels(): void {
  try {
    readdirSync(SENTINEL_DIR)
      .filter(f => f.startsWith(SENTINEL_PREFIX))
      .forEach(f => { if (isSentinelStale(join(SENTINEL_DIR, f))) try { rmSync(join(SENTINEL_DIR, f)); } catch { /* ok */ } });
  } catch { /* /tmp inaccessible */ }
}
