import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { openFactsDb, selectFacts } from "../facts-db.js";
import { addFact } from "../add.js";

describe("addFact", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-add-"));
    mkdirSync(join(dir, "facts"));
    execSync("git init", { cwd: dir });
    execSync("git config user.email test@test.com", { cwd: dir });
    execSync("git config user.name testdev", { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("inserts a fact and commits the DB file", () => {
    const result = addFact({
      content: "Docker needs --platform linux/amd64 on M1",
      repoDir: dir,
      developer: "testdev",
    });

    expect(result.id).toHaveLength(8);
    expect(result.content).toBe("Docker needs --platform linux/amd64 on M1");
    expect(result.project).toBeNull();
    expect(result.tags).toEqual([]);

    // Verify DB row
    const db = openFactsDb(join(dir, "facts"), "testdev");
    const facts = selectFacts(db);
    db.close();
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("Docker needs --platform linux/amd64 on M1");

    // Verify git commit
    const log = execSync("git log --oneline", { cwd: dir, encoding: "utf-8" });
    expect(log).toContain(`feat: add fact ${result.id}`);
  });

  it("stores project and tags when provided", () => {
    const result = addFact({
      content: "Always use vitest not jest",
      repoDir: dir,
      developer: "testdev",
      project: "team-memory",
      tags: ["category:gotcha", "testing"],
    });

    const db = openFactsDb(join(dir, "facts"), "testdev");
    const facts = selectFacts(db);
    db.close();
    expect(facts[0].project).toBe("team-memory");
    expect(facts[0].tags).toEqual(["category:gotcha", "testing"]);
    expect(result.project).toBe("team-memory");
    expect(result.tags).toEqual(["category:gotcha", "testing"]);
  });
});
