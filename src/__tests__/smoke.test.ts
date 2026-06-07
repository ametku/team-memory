import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const CLI_PATH = resolve(import.meta.dirname, "../../dist/cli.js");

describe("team-memory CLI", () => {
  it("prints usage on --help", () => {
    const output = execFileSync("node", [CLI_PATH, "--help"], {
      encoding: "utf-8",
    });
    expect(output).toContain("team-memory");
    expect(output).toContain("Commands:");
  });

  it("prints version on --version", () => {
    const output = execFileSync("node", [CLI_PATH, "--version"], {
      encoding: "utf-8",
    });
    expect(output.trim()).toBe("0.1.0");
  });

  it("exits with code 1 on unknown command", () => {
    expect(() =>
      execFileSync("node", [CLI_PATH, "nonexistent"], { encoding: "utf-8" })
    ).toThrow();
  });
});

describe("team-memory add", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-cli-add-"));
    mkdirSync(join(dir, "facts"));
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("adds a fact and prints the ID", () => {
    const output = execFileSync(
      "node",
      [CLI_PATH, "add", "always run migrations before deploy"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "testdev" },
      },
    );
    expect(output.trim()).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });

  it("adds a fact with --project and --tags", () => {
    const output = execFileSync(
      "node",
      [
        CLI_PATH, "add", "use pnpm not npm",
        "--project", "infra",
        "--tags", '["category:gotcha", "tooling"]',
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "testdev" },
      },
    );
    expect(output.trim()).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });

  it("exits 1 when no content provided", () => {
    expect(() =>
      execFileSync("node", [CLI_PATH, "add"], {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "testdev" },
      }),
    ).toThrow();
  });
});
