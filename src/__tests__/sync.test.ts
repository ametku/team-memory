import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { syncRepo } from "../sync.js";
import { openFactsDb, insertFact } from "../facts-db.js";
import { queryFacts } from "../query.js";

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

  test("pushes local commits when push=true", () => {
    const db = openFactsDb(join(local, "facts"), "testdev");
    insertFact(db, { content: "local fact to push" });
    db.close();
    execFileSync("git", ["add", "."], { cwd: local });
    execFileSync("git", ["commit", "-m", "feat: local fact"], { cwd: local });

    const indexPath = join(local, "merged_index.db");
    const result = syncRepo({ repoDir: local, indexPath, push: true });

    expect(result.pushed).toBe(true);
    expect(result.pulled).toBe(true);

    const verify = mkdtempSync(join(tmpdir(), "tm-sync-verify-"));
    rmSync(verify, { recursive: true });
    execFileSync("git", ["clone", remote, verify]);
    const log = execFileSync("git", ["log", "--oneline"], { cwd: verify, encoding: "utf-8" });
    expect(log).toContain("local fact");
    rmSync(verify, { recursive: true });
  });

  test("push=true with no remote throws", () => {
    execFileSync("git", ["remote", "set-url", "origin", "/nonexistent/path"], { cwd: local });

    const indexPath = join(local, "merged_index.db");
    expect(() => syncRepo({ repoDir: local, indexPath, push: true })).toThrow();
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

  test("index includes facts from multiple devs after sync", () => {
    const db1 = openFactsDb(join(local, "facts"), "dev1");
    insertFact(db1, { content: "dev1 rule: always use strict mode" });
    db1.close();
    execFileSync("git", ["add", "."], { cwd: local });
    execFileSync("git", ["commit", "-m", "dev1 fact"], { cwd: local });
    execFileSync("git", ["push", "origin", "main"], { cwd: local });

    const clone2 = mkdtempSync(join(tmpdir(), "tm-sync-int-"));
    rmSync(clone2, { recursive: true });
    execFileSync("git", ["clone", remote, clone2]);
    execFileSync("git", ["config", "user.email", "dev2@test.com"], { cwd: clone2 });
    execFileSync("git", ["config", "user.name", "dev2"], { cwd: clone2 });
    mkdirSync(join(clone2, "facts"), { recursive: true });
    mkdirSync(join(clone2, "interactions"), { recursive: true });

    const db2 = openFactsDb(join(clone2, "facts"), "dev2");
    insertFact(db2, { content: "dev2 rule: never commit secrets" });
    db2.close();
    execFileSync("git", ["add", "."], { cwd: clone2 });
    execFileSync("git", ["commit", "-m", "dev2 fact"], { cwd: clone2 });
    execFileSync("git", ["push", "origin", "main"], { cwd: clone2 });
    rmSync(clone2, { recursive: true });

    const indexPath = join(local, "merged_index.db");
    const result = syncRepo({ repoDir: local, indexPath });

    expect(result.pulled).toBe(true);
    expect(result.rebuildStats.devDbs).toBe(2);
    expect(result.rebuildStats.factsIndexed).toBe(2);

    const r1 = queryFacts({ indexPath, query: "strict mode", limit: 10 });
    expect(r1.map(r => r.content)).toContain("dev1 rule: always use strict mode");

    const r2 = queryFacts({ indexPath, query: "commit secrets", limit: 10 });
    expect(r2.map(r => r.content)).toContain("dev2 rule: never commit secrets");
  });
});
