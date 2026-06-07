import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { syncRepo } from "../sync.js";
import { openFactsDb, insertFact } from "../facts-db.js";

describe("syncRepo", () => {
  let remote: string;
  let local: string;

  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), "tm-sync-remote-"));
    execFileSync("git", ["init", "--bare"], { cwd: remote });

    local = mkdtempSync(join(tmpdir(), "tm-sync-local-"));
    rmSync(local, { recursive: true });
    execFileSync("git", ["clone", remote, local]);
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: local });
    execFileSync("git", ["config", "user.name", "testdev"], { cwd: local });

    mkdirSync(join(local, "facts"), { recursive: true });
    mkdirSync(join(local, "interactions"), { recursive: true });
    execFileSync("git", ["add", "."], { cwd: local });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: local });
    execFileSync("git", ["push", "origin", "main"], { cwd: local });
  });

  afterEach(() => {
    rmSync(remote, { recursive: true });
    rmSync(local, { recursive: true });
  });

  test("pulls new facts from remote and rebuilds index", () => {
    const clone2 = mkdtempSync(join(tmpdir(), "tm-sync-clone2-"));
    rmSync(clone2, { recursive: true });
    execFileSync("git", ["clone", remote, clone2]);
    execFileSync("git", ["config", "user.email", "dev2@test.com"], { cwd: clone2 });
    execFileSync("git", ["config", "user.name", "dev2"], { cwd: clone2 });
    mkdirSync(join(clone2, "facts"), { recursive: true });
    mkdirSync(join(clone2, "interactions"), { recursive: true });

    const db = openFactsDb(join(clone2, "facts"), "dev2");
    insertFact(db, { content: "always use parameterized queries" });
    db.close();

    execFileSync("git", ["add", "."], { cwd: clone2 });
    execFileSync("git", ["commit", "-m", "feat: add fact"], { cwd: clone2 });
    execFileSync("git", ["push", "origin", "main"], { cwd: clone2 });
    rmSync(clone2, { recursive: true });

    const indexPath = join(local, "merged_index.db");
    const result = syncRepo({ repoDir: local, indexPath });

    expect(result.pulled).toBe(true);
    expect(result.pullWarning).toBeUndefined();
    expect(result.rebuildStats.devDbs).toBe(1);
    expect(result.rebuildStats.factsIndexed).toBe(1);
  });

  test("continues with rebuild when pull fails (offline-graceful)", () => {
    const db = openFactsDb(join(local, "facts"), "testdev");
    insertFact(db, { content: "local fact before sync" });
    db.close();
    execFileSync("git", ["add", "."], { cwd: local });
    execFileSync("git", ["commit", "-m", "add local fact"], { cwd: local });

    execFileSync("git", ["remote", "set-url", "origin", "/nonexistent/path"], { cwd: local });

    const indexPath = join(local, "merged_index.db");
    const result = syncRepo({ repoDir: local, indexPath });

    expect(result.pulled).toBe(false);
    expect(result.pullWarning).toBeDefined();
    expect(result.rebuildStats.devDbs).toBe(1);
    expect(result.rebuildStats.factsIndexed).toBe(1);
  });
});
