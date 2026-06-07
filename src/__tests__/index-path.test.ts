import { describe, test, expect, afterEach } from "vitest";
import { resolveIndexPath } from "../index-path.js";
import { join } from "path";
import { homedir } from "os";

describe("resolveIndexPath", () => {
  afterEach(() => {
    delete process.env.TEAM_MEMORY_INDEX_PATH;
  });

  test("returns ~/.cache/team-memory/merged_index.db by default", () => {
    delete process.env.TEAM_MEMORY_INDEX_PATH;
    const result = resolveIndexPath();
    expect(result).toBe(join(homedir(), ".cache", "team-memory", "merged_index.db"));
  });

  test("respects TEAM_MEMORY_INDEX_PATH override", () => {
    process.env.TEAM_MEMORY_INDEX_PATH = "/tmp/custom/index.db";
    const result = resolveIndexPath();
    expect(result).toBe("/tmp/custom/index.db");
  });
});
