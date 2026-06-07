import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { openFactsDb, insertFact } from "../facts-db.js";
import { openInteractionsDb } from "../interactions-db.js";
import { rejectFact } from "../reject.js";

describe("rejectFact", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-reject-"));
    mkdirSync(join(dir, "facts"));
    mkdirSync(join(dir, "interactions"));
    execSync("git init", { cwd: dir });
    execSync('git config user.email "test@test.com"', { cwd: dir });
    execSync('git config user.name "testdev"', { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  test("records explicit_score = -1 for a valid fact", () => {
    const factsDb = openFactsDb(join(dir, "facts"), "alice");
    const fact = insertFact(factsDb, { content: "always use TLS" });
    factsDb.exec("VACUUM");
    factsDb.close();

    const result = rejectFact({ factId: fact.id, repoDir: dir, developer: "bob" });

    expect(result.content).toBe("always use TLS");

    const iDb = openInteractionsDb(join(dir, "interactions"), "bob");
    const row = iDb.prepare("SELECT explicit_score, surface_count FROM interactions WHERE fact_id = ?").get(fact.id) as any;
    iDb.close();
    expect(row.explicit_score).toBe(-1);
    expect(row.surface_count).toBe(0);
  });
});
