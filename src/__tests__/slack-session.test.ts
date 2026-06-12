import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { recordThread, loadSession, clearSession } from "../slack-session.js";

describe("slack session accumulator", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tm-slack-session-")); });
  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("creates session file on first record", () => {
    recordThread(dir, { url: "https://slack.com/t/1", summary: "Alice fixed the timeout", prompt: "why does it timeout" });
    expect(existsSync(join(dir, "slack-surface-session.json"))).toBe(true);
  });

  it("stores thread fields correctly", () => {
    recordThread(dir, { url: "https://slack.com/t/1", summary: "Use pnpm not npm", prompt: "how to install deps" });
    const session = loadSession(dir)!;
    expect(session.threads).toHaveLength(1);
    expect(session.threads[0].url).toBe("https://slack.com/t/1");
    expect(session.threads[0].summary).toBe("Use pnpm not npm");
    expect(session.threads[0].prompt).toBe("how to install deps");
    expect(session.threads[0].surfaced_at).toBeTruthy();
  });

  it("appends on subsequent records", () => {
    recordThread(dir, { url: "https://slack.com/t/1", summary: "first", prompt: "q1" });
    recordThread(dir, { url: "https://slack.com/t/2", summary: "second", prompt: "q2" });
    const session = loadSession(dir)!;
    expect(session.threads).toHaveLength(2);
    expect(session.threads[1].url).toBe("https://slack.com/t/2");
  });

  it("loadSession returns null when file does not exist", () => {
    expect(loadSession(dir)).toBeNull();
  });

  it("clearSession deletes the file", () => {
    recordThread(dir, { url: "https://slack.com/t/1", summary: "x", prompt: "y" });
    clearSession(dir);
    expect(existsSync(join(dir, "slack-surface-session.json"))).toBe(false);
  });

  it("clearSession is a no-op when file does not exist", () => {
    expect(() => clearSession(dir)).not.toThrow();
  });
});
