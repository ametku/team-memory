import { describe, it, expect, afterEach } from "vitest";
import { resolveRepoDir } from "../repo.js";

describe("resolveRepoDir", () => {
  const originalEnv = process.env.TEAM_MEMORY_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.TEAM_MEMORY_DIR;
    } else {
      process.env.TEAM_MEMORY_DIR = originalEnv;
    }
  });

  it("uses TEAM_MEMORY_DIR when set", () => {
    process.env.TEAM_MEMORY_DIR = "/tmp/custom-memory";
    expect(resolveRepoDir()).toBe("/tmp/custom-memory");
  });

  it("defaults to ~/.team-memory/", () => {
    delete process.env.TEAM_MEMORY_DIR;
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    expect(resolveRepoDir()).toBe(`${home}/.team-memory`);
  });
});
