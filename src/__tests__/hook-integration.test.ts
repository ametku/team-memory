import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openFactsDb, insertFact } from "../facts-db.js";

const CLI_PATH = resolve(import.meta.dirname, "../../dist/cli.js");

describe("post-merge hook integration", () => {
  let bare: string;
  let clone1: string;
  let clone2: string;

  beforeEach(() => {
    bare = mkdtempSync(join(tmpdir(), "tm-hook-bare-"));
    clone1 = mkdtempSync(join(tmpdir(), "tm-hook-clone1-"));
    clone2 = mkdtempSync(join(tmpdir(), "tm-hook-clone2-"));

    execFileSync("git", ["init", "--bare", bare]);

    execFileSync("git", ["clone", bare, clone1]);
    execFileSync("git", ["config", "user.email", "dev1@test.com"], { cwd: clone1 });
    execFileSync("git", ["config", "user.name", "dev1"], { cwd: clone1 });
    mkdirSync(join(clone1, "facts"), { recursive: true });
    mkdirSync(join(clone1, "interactions"), { recursive: true });
    execFileSync("git", ["add", "."], { cwd: clone1 });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: clone1 });
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: clone1 });

    execFileSync("git", ["clone", bare, clone2]);
    execFileSync("git", ["config", "user.email", "dev2@test.com"], { cwd: clone2 });
    execFileSync("git", ["config", "user.name", "dev2"], { cwd: clone2 });
  });

  afterEach(() => {
    rmSync(bare, { recursive: true });
    rmSync(clone1, { recursive: true });
    rmSync(clone2, { recursive: true });
  });

  it("hook fires after pull and rebuilds merged index", () => {
    execFileSync("node", [CLI_PATH, "install-hook"], {
      encoding: "utf-8",
      env: { ...process.env, TEAM_MEMORY_DIR: clone2 },
    });

    const db = openFactsDb(join(clone1, "facts"), "dev1");
    insertFact(db, { content: "hook integration test fact" });
    db.close();

    execFileSync("git", ["add", "."], { cwd: clone1 });
    execFileSync("git", ["commit", "-m", "add fact"], { cwd: clone1 });
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: clone1 });

    const indexPath = join(clone2, "merged_index.db");

    execFileSync("git", ["pull", "origin", "main"], {
      cwd: clone2,
      env: {
        ...process.env,
        TEAM_MEMORY_DIR: clone2,
        TEAM_MEMORY_INDEX_PATH: indexPath,
        PATH: `${resolve(import.meta.dirname, "../../node_modules/.bin")}:${process.env.PATH}`,
      },
    });

    expect(existsSync(indexPath)).toBe(true);
  });

  it("hook does not block pull when rebuild-index command is unavailable", () => {
    execFileSync("node", [CLI_PATH, "install-hook"], {
      encoding: "utf-8",
      env: { ...process.env, TEAM_MEMORY_DIR: clone2 },
    });

    execFileSync("git", ["commit", "--allow-empty", "-m", "empty"], { cwd: clone1 });
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: clone1 });

    // Pull with empty PATH so team-memory isn't found — hook should still exit 0
    expect(() => {
      execFileSync("git", ["pull", "origin", "main"], {
        cwd: clone2,
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      });
    }).not.toThrow();
  });
});
