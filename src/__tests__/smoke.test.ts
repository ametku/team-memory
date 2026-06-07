import { execFileSync, execSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openInteractionsDb } from "../interactions-db.js";
import { openFactsDb, insertFact } from "../facts-db.js";

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

describe("team-memory query", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-cli-query-"));
    mkdirSync(join(dir, "facts"));
    mkdirSync(join(dir, "interactions"));
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("queries facts and prints results", () => {
    execFileSync(
      "node",
      [CLI_PATH, "add", "always use TLS in production"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "testdev" },
      },
    );

    execFileSync(
      "node",
      [CLI_PATH, "rebuild-index"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
      },
    );

    const output = execFileSync(
      "node",
      [CLI_PATH, "query", "TLS production"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
      },
    );
    expect(output).toContain("always use TLS in production");
  });

  it("scopes results with --project flag", () => {
    for (const [content, project] of [
      ["payments fact alpha", "payments-service"],
      ["frontend fact beta", "web-app"],
      ["team-wide fact gamma", undefined],
    ] as const) {
      const args = [CLI_PATH, "add", content];
      if (project) args.push("--project", project);
      execFileSync("node", args, {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "testdev" },
      });
    }

    execFileSync("node", [CLI_PATH, "rebuild-index"], {
      encoding: "utf-8",
      env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
    });

    const output = execFileSync(
      "node",
      [CLI_PATH, "query", "fact", "--project", "payments-service"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
      },
    );
    expect(output).toContain("payments fact alpha");
    expect(output).toContain("team-wide fact gamma");
    expect(output).not.toContain("frontend fact beta");
  });

  it("exits 1 when no query text provided", () => {
    expect(() =>
      execFileSync("node", [CLI_PATH, "query"], {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
      }),
    ).toThrow();
  });

  it("prints helpful message when merged_index.db missing", () => {
    try {
      execFileSync("node", [CLI_PATH, "query", "anything"], {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
      });
    } catch (e: any) {
      expect(e.stderr.toString()).toContain("rebuild-index");
    }
  });

  it("respects --limit flag", () => {
    for (let i = 0; i < 3; i++) {
      execFileSync(
        "node",
        [CLI_PATH, "add", `config fact number ${i}`],
        {
          encoding: "utf-8",
          env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "testdev" },
        },
      );
    }

    execFileSync(
      "node",
      [CLI_PATH, "rebuild-index"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
      },
    );

    const output = execFileSync(
      "node",
      [CLI_PATH, "query", "config fact", "--limit", "2"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
      },
    );
    const lines = output.trim().split("\n").filter((l: string) => l.includes("config fact"));
    expect(lines).toHaveLength(2);
  });
});

describe("team-memory reject", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-cli-reject-"));
    mkdirSync(join(dir, "facts"));
    mkdirSync(join(dir, "interactions"));
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("rejects a fact and prints confirmation", () => {
    const addOutput = execFileSync(
      "node",
      [CLI_PATH, "add", "always run lint before push"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "testdev" },
      },
    );
    const factId = addOutput.trim();

    const rejectOutput = execFileSync(
      "node",
      [CLI_PATH, "reject", factId],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "testdev" },
      },
    );
    expect(rejectOutput).toContain(`Rejected fact ${factId}`);
    expect(rejectOutput).toContain("always run lint before push");
  });

  it("exits 1 when no fact_id provided", () => {
    expect(() =>
      execFileSync("node", [CLI_PATH, "reject"], {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "testdev" },
      }),
    ).toThrow();
  });

  it("exits 1 for non-existent fact_id", () => {
    try {
      execFileSync("node", [CLI_PATH, "reject", "badid123"], {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "testdev" },
      });
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.stderr.toString()).toContain("Fact not found");
    }
  });
});

describe("team-memory prune", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-cli-prune-"));
    mkdirSync(join(dir, "facts"));
    mkdirSync(join(dir, "interactions"));
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("prunes rejected facts and prints output", () => {
    const addOutput = execFileSync(
      "node",
      [CLI_PATH, "add", "bad advice to prune"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "alice" },
      },
    );
    const factId = addOutput.trim();

    const iDb1 = openInteractionsDb(join(dir, "interactions"), "bob");
    iDb1.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 0, '2026-06-01T00:00:00Z', -1)"
    ).run(factId);
    iDb1.close();

    const iDb2 = openInteractionsDb(join(dir, "interactions"), "carol");
    iDb2.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 0, '2026-06-02T00:00:00Z', -1)"
    ).run(factId);
    iDb2.close();

    const output = execFileSync(
      "node",
      [CLI_PATH, "prune"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "alice", TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
      },
    );
    expect(output).toContain(factId);
    expect(output).toContain("rejected");

    // Verify pruned fact is absent from rebuilt index
    const queryOutput = execFileSync(
      "node",
      [CLI_PATH, "query", "bad advice"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
      },
    );
    expect(queryOutput).not.toContain(factId);
  });

  it("--dry-run shows what would be pruned without deleting", () => {
    const addOutput = execFileSync(
      "node",
      [CLI_PATH, "add", "another bad fact"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "alice" },
      },
    );
    const factId = addOutput.trim();

    const iDb1 = openInteractionsDb(join(dir, "interactions"), "bob");
    iDb1.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 0, '2026-06-01T00:00:00Z', -1)"
    ).run(factId);
    iDb1.close();

    const iDb2 = openInteractionsDb(join(dir, "interactions"), "carol");
    iDb2.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 0, '2026-06-02T00:00:00Z', -1)"
    ).run(factId);
    iDb2.close();

    const output = execFileSync(
      "node",
      [CLI_PATH, "prune", "--dry-run"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "alice" },
      },
    );
    expect(output).toContain(factId);
    expect(output).toContain("dry-run");

    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    const row = factsDb.prepare("SELECT * FROM facts WHERE id = ?").get(factId);
    factsDb.close();
    expect(row).toBeDefined();
  });

  it("prints nothing-to-prune when no facts qualify", () => {
    execFileSync(
      "node",
      [CLI_PATH, "add", "healthy fact"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "alice" },
      },
    );

    const output = execFileSync(
      "node",
      [CLI_PATH, "prune"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "alice" },
      },
    );
    expect(output).toContain("Nothing to prune");
  });
});

describe("team-memory install-hook", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-cli-hook-"));
    execFileSync("git", ["init"], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("installs hook and reports path", () => {
    const output = execFileSync(
      "node",
      [CLI_PATH, "install-hook"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir },
      },
    );
    expect(output).toContain("Installed post-merge hook");
    expect(output).toContain("post-merge");
  });

  it("reports skip when hook already exists", () => {
    execFileSync("node", [CLI_PATH, "install-hook"], {
      encoding: "utf-8",
      env: { ...process.env, TEAM_MEMORY_DIR: dir },
    });

    const output = execFileSync("node", [CLI_PATH, "install-hook"], {
      encoding: "utf-8",
      env: { ...process.env, TEAM_MEMORY_DIR: dir },
    });
    expect(output).toContain("Skipped");
  });
});

describe("team-memory join", () => {
  let tmp: string;
  let bareDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tm-cli-join-"));
    bareDir = join(tmp, "team.git");
    const seed = join(tmp, "seed");
    execFileSync("git", ["init", "--bare", bareDir]);
    execFileSync("git", ["clone", bareDir, seed]);
    execFileSync("git", ["config", "user.email", "seed@test.com"], { cwd: seed });
    execFileSync("git", ["config", "user.name", "seed"], { cwd: seed });
    execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: seed });
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: seed });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true });
  });

  it("clones repo and reports target dir", () => {
    const target = join(tmp, "joined");
    const output = execFileSync("node", [CLI_PATH, "join", bareDir, "--dir", target], {
      encoding: "utf-8",
      env: { ...process.env, TEAM_MEMORY_DEVELOPER: "joiner" },
    });
    expect(output).toContain("Joined");
    expect(output).toContain(target);
  });

  it("exits 1 when no repo-url provided", () => {
    expect(() =>
      execFileSync("node", [CLI_PATH, "join"], {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DEVELOPER: "joiner" },
      }),
    ).toThrow();
  });

  it("includes join in --help output", () => {
    const output = execFileSync("node", [CLI_PATH, "--help"], { encoding: "utf-8" });
    expect(output).toContain("join");
  });
});

describe("team-memory init", () => {
  it("exits 1 when --org or --repo missing", () => {
    expect(() =>
      execFileSync("node", [CLI_PATH, "init", "--repo", "x"], { encoding: "utf-8" }),
    ).toThrow();
    expect(() =>
      execFileSync("node", [CLI_PATH, "init", "--org", "x"], { encoding: "utf-8" }),
    ).toThrow();
  });

  it("includes init in --help output", () => {
    const output = execFileSync("node", [CLI_PATH, "--help"], { encoding: "utf-8" });
    expect(output).toContain("init");
  });

  it("prints export TEAM_MEMORY_DIR=<path> after successful init", () => {
    const tmp = mkdtempSync(join(tmpdir(), "tm-init-output-"));
    const bareDir = join(tmp, "remote.git");
    const fakeGhDir = join(tmp, "fakebin");
    const target = join(tmp, "new-team");
    try {
      execFileSync("git", ["init", "--bare", bareDir]);
      mkdirSync(fakeGhDir);
      writeFileSync(join(fakeGhDir, "gh"), `#!/bin/sh
if [ "$2" = "clone" ]; then
  git clone "$FAKE_GH_REMOTE" "$4"
  git -C "$4" config user.email "test@test.com"
  git -C "$4" config user.name "testdev"
  git -C "$4" commit --allow-empty -m "initial"
  git -C "$4" push origin HEAD
fi
`, { mode: 0o755 });

      const output = execFileSync(
        "node",
        [CLI_PATH, "init", "--org", "o", "--repo", "r", "--dir", target],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            PATH: `${fakeGhDir}:${process.env.PATH}`,
            FAKE_GH_REMOTE: bareDir,
            TEAM_MEMORY_DEVELOPER: "testdev",
            TEAM_MEMORY_CLAUDE_SETTINGS: join(tmp, ".claude", "settings.json"),
            TEAM_MEMORY_CLAUDE_SKILLS_DIR: join(tmp, ".claude", "skills"),
          },
        },
      );

      expect(output).toContain(`export TEAM_MEMORY_DIR=${target}`);
    } finally {
      rmSync(tmp, { recursive: true });
    }
  });
});

describe("team-memory sync", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-cli-sync-"));
    mkdirSync(join(dir, "facts"), { recursive: true });
    mkdirSync(join(dir, "interactions"), { recursive: true });
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("syncs and reports rebuild stats", () => {
    const db = openFactsDb(join(dir, "facts"), "testdev");
    insertFact(db, { content: "sync test fact" });
    db.close();

    const output = execFileSync(
      "node",
      [CLI_PATH, "sync"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
      },
    );
    expect(output).toContain("facts indexed");
  });

  it("warns when pull fails but still rebuilds", () => {
    const db = openFactsDb(join(dir, "facts"), "testdev");
    insertFact(db, { content: "offline test fact" });
    db.close();

    const output = execFileSync(
      "node",
      [CLI_PATH, "sync"],
      {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db") },
      },
    );
    expect(output).toContain("Warning");
    expect(output).toContain("facts indexed");
  });
});

describe("team-memory preprompt-hook", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-preprompt-cli-"));
    mkdirSync(join(dir, "facts"));
    mkdirSync(join(dir, "interactions"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("outputs continue:true JSON with no index", () => {
    const input = JSON.stringify({ prompt: "test", hook_event_name: "UserPromptSubmit" });
    const output = execFileSync("node", [CLI_PATH, "preprompt-hook"], {
      encoding: "utf-8",
      input,
      env: {
        ...process.env,
        TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db"),
        TEAM_MEMORY_DIR: dir,
        TEAM_MEMORY_DEVELOPER: "alice",
      },
    });
    const parsed = JSON.parse(output);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });
});

describe("team-memory session-end", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-session-end-"));
    execSync("git init", { cwd: dir });
    execSync("git config user.name 'Test'", { cwd: dir });
    execSync("git config user.email 'test@test.com'", { cwd: dir });
    execSync("git commit --allow-empty -m 'init'", { cwd: dir });
    mkdirSync(join(dir, "interactions"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("exits 0 with no interactions db", () => {
    expect(() =>
      execFileSync("node", [CLI_PATH, "session-end"], {
        encoding: "utf-8",
        env: { ...process.env, TEAM_MEMORY_DIR: dir, TEAM_MEMORY_DEVELOPER: "alice" },
      })
    ).not.toThrow();
  });
});
