import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const CLI_PATH = resolve(import.meta.dirname, "../../dist/cli.js");

describe("team-memory rebuild-index (integration)", () => {
  let repoDir: string;
  let indexPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "tm-rebuild-int-"));
    indexPath = join(repoDir, "merged_index.db");
    mkdirSync(join(repoDir, "facts"));
    mkdirSync(join(repoDir, "interactions"));
    execFileSync("git", ["init"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true });
  });

  const env = () => ({
    ...process.env,
    TEAM_MEMORY_DIR: repoDir,
    TEAM_MEMORY_INDEX_PATH: indexPath,
  });

  it("rebuilds index from multiple developer DBs and prints stats", () => {
    execFileSync("node", [CLI_PATH, "add", "alice fact one"], {
      encoding: "utf-8",
      env: { ...env(), TEAM_MEMORY_DEVELOPER: "alice" },
    });
    execFileSync("node", [CLI_PATH, "add", "alice fact two"], {
      encoding: "utf-8",
      env: { ...env(), TEAM_MEMORY_DEVELOPER: "alice" },
    });
    execFileSync("node", [CLI_PATH, "add", "bob fact one"], {
      encoding: "utf-8",
      env: { ...env(), TEAM_MEMORY_DEVELOPER: "bob" },
    });

    const output = execFileSync("node", [CLI_PATH, "rebuild-index"], {
      encoding: "utf-8",
      env: env(),
    });

    expect(output).toContain("2 dev DBs");
    expect(output).toContain("3 facts indexed");
    expect(output).toMatch(/\d+\.\d+s/);
  });

  it("rebuilt index is queryable across all developers", () => {
    execFileSync("node", [CLI_PATH, "add", "always use viper for config"], {
      encoding: "utf-8",
      env: { ...env(), TEAM_MEMORY_DEVELOPER: "alice" },
    });
    execFileSync("node", [CLI_PATH, "add", "stripe webhooks must be idempotent"], {
      encoding: "utf-8",
      env: { ...env(), TEAM_MEMORY_DEVELOPER: "bob" },
    });

    execFileSync("node", [CLI_PATH, "rebuild-index"], {
      encoding: "utf-8",
      env: env(),
    });

    const output = execFileSync("node", [CLI_PATH, "query", "viper config"], {
      encoding: "utf-8",
      env: env(),
    });

    expect(output).toContain("viper");
    expect(output).not.toContain("stripe");
  });

  it("freeform keyword tags are searchable via FTS5 after rebuild", () => {
    execFileSync(
      "node",
      [CLI_PATH, "add", "connection pooling reduces latency", "--tags", '["category:gotcha", "networking", "postgres", "pooling"]'],
      {
        encoding: "utf-8",
        env: { ...env(), TEAM_MEMORY_DEVELOPER: "alice" },
      },
    );
    execFileSync(
      "node",
      [CLI_PATH, "add", "always pin docker base images", "--tags", '["category:convention", "docker", "ci"]'],
      {
        encoding: "utf-8",
        env: { ...env(), TEAM_MEMORY_DEVELOPER: "bob" },
      },
    );

    execFileSync("node", [CLI_PATH, "rebuild-index"], {
      encoding: "utf-8",
      env: env(),
    });

    // Search by freeform keyword tag "postgres"
    const output1 = execFileSync("node", [CLI_PATH, "query", "postgres"], {
      encoding: "utf-8",
      env: env(),
    });
    expect(output1).toContain("connection pooling");
    expect(output1).not.toContain("docker");

    // Search by freeform keyword tag "docker"
    const output2 = execFileSync("node", [CLI_PATH, "query", "docker"], {
      encoding: "utf-8",
      env: env(),
    });
    expect(output2).toContain("pin docker base images");

    // Search by category prefix
    const output3 = execFileSync("node", [CLI_PATH, "query", "category:gotcha"], {
      encoding: "utf-8",
      env: env(),
    });
    expect(output3).toContain("connection pooling");
  });
});
