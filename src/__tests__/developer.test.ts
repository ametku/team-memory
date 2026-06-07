import { describe, test, expect, afterEach } from "vitest";
import { getDeveloperName } from "../developer.js";

describe("getDeveloperName", () => {
  afterEach(() => {
    delete process.env.TEAM_MEMORY_DEVELOPER;
  });

  test("returns TEAM_MEMORY_DEVELOPER env var when set", () => {
    process.env.TEAM_MEMORY_DEVELOPER = "test-dev";
    expect(getDeveloperName()).toBe("test-dev");
  });

  test("falls back to git config user.name when env var unset", () => {
    delete process.env.TEAM_MEMORY_DEVELOPER;
    const name = getDeveloperName();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });

  test("prefers env var over git config", () => {
    process.env.TEAM_MEMORY_DEVELOPER = "env-dev";
    const name = getDeveloperName();
    expect(name).toBe("env-dev");
  });
});
