import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { resolve } from "path";
import { openFactsDb, insertFact } from "../facts-db.js";
import { openInteractionsDb } from "../interactions-db.js";
import { rebuildIndex } from "../merged-index.js";
import { generateDashboard, assembleDashboardData } from "../dashboard.js";

const CLI_PATH = resolve(import.meta.dirname, "../../dist/cli.js");

function makeRepo(dir: string, dev = "alice") {
  mkdirSync(join(dir, "facts"), { recursive: true });
  mkdirSync(join(dir, "interactions"), { recursive: true });
}

describe("generateDashboard", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-dashboard-"));
    makeRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("creates an HTML file at the output path", () => {
    const db = openFactsDb(join(dir, "facts"), "alice");
    insertFact(db, { content: "always use TLS in production" });
    db.close();
    rebuildIndex(dir, join(dir, "merged_index.db"));

    const outputPath = join(dir, "dashboard.html");
    generateDashboard({ repoDir: dir, indexPath: join(dir, "merged_index.db"), outputPath, openBrowser: false });

    expect(existsSync(outputPath)).toBe(true);
  });

  it("HTML embeds fact content", () => {
    const db = openFactsDb(join(dir, "facts"), "alice");
    insertFact(db, { content: "always use TLS in production" });
    db.close();
    rebuildIndex(dir, join(dir, "merged_index.db"));

    const outputPath = join(dir, "dashboard.html");
    generateDashboard({ repoDir: dir, indexPath: join(dir, "merged_index.db"), outputPath, openBrowser: false });

    const html = readFileSync(outputPath, "utf-8");
    expect(html).toContain("always use TLS in production");
  });

  it("HTML embeds author name derived from facts-<dev>.db filename", () => {
    const db = openFactsDb(join(dir, "facts"), "alice");
    insertFact(db, { content: "some team fact" });
    db.close();
    rebuildIndex(dir, join(dir, "merged_index.db"));

    const outputPath = join(dir, "dashboard.html");
    generateDashboard({ repoDir: dir, indexPath: join(dir, "merged_index.db"), outputPath, openBrowser: false });

    const html = readFileSync(outputPath, "utf-8");
    expect(html).toContain("alice");
  });

  it("HTML embeds tags for each fact", () => {
    const db = openFactsDb(join(dir, "facts"), "alice");
    insertFact(db, { content: "use pnpm not npm", tags: ["category:gotcha", "tooling"] });
    db.close();
    rebuildIndex(dir, join(dir, "merged_index.db"));

    const outputPath = join(dir, "dashboard.html");
    generateDashboard({ repoDir: dir, indexPath: join(dir, "merged_index.db"), outputPath, openBrowser: false });

    const html = readFileSync(outputPath, "utf-8");
    expect(html).toContain("category:gotcha");
    expect(html).toContain("tooling");
  });

  it("HTML embeds trust score for each fact", () => {
    const db = openFactsDb(join(dir, "facts"), "alice");
    const fact = insertFact(db, { content: "trust test fact" });
    db.close();

    // add surface interactions to make trust > 1
    const idb = openInteractionsDb(join(dir, "interactions"), "alice");
    idb.prepare(
      "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, 5, ?, 0)"
    ).run(fact.id, new Date().toISOString());
    idb.close();

    rebuildIndex(dir, join(dir, "merged_index.db"));

    const outputPath = join(dir, "dashboard.html");
    generateDashboard({ repoDir: dir, indexPath: join(dir, "merged_index.db"), outputPath, openBrowser: false });

    const html = readFileSync(outputPath, "utf-8");
    // trust = (1 + ln(1+5)) * max(0.1, 1+0) = ~2.79
    expect(html).toContain("trust");
    expect(html).toMatch(/2\.\d+/); // some decimal trust score > 1
  });

  it("HTML includes copyable team-memory reject <id> command", () => {
    const db = openFactsDb(join(dir, "facts"), "alice");
    const fact = insertFact(db, { content: "reject command test fact" });
    db.close();
    rebuildIndex(dir, join(dir, "merged_index.db"));

    const outputPath = join(dir, "dashboard.html");
    generateDashboard({ repoDir: dir, indexPath: join(dir, "merged_index.db"), outputPath, openBrowser: false });

    const html = readFileSync(outputPath, "utf-8");
    expect(html).toContain(`team-memory reject ${fact.id}`);
  });

  it("handles missing interactions directory gracefully", () => {
    rmSync(join(dir, "interactions"), { recursive: true });

    const db = openFactsDb(join(dir, "facts"), "alice");
    insertFact(db, { content: "no interactions fact" });
    db.close();
    rebuildIndex(dir, join(dir, "merged_index.db"));

    const outputPath = join(dir, "dashboard.html");
    expect(() =>
      generateDashboard({ repoDir: dir, indexPath: join(dir, "merged_index.db"), outputPath, openBrowser: false })
    ).not.toThrow();

    const html = readFileSync(outputPath, "utf-8");
    expect(html).toContain("no interactions fact");
  });

  it("aggregates facts from multiple authors into one dashboard", () => {
    const aDb = openFactsDb(join(dir, "facts"), "alice");
    insertFact(aDb, { content: "fact from alice" });
    aDb.close();

    const bDb = openFactsDb(join(dir, "facts"), "bob");
    insertFact(bDb, { content: "fact from bob" });
    bDb.close();

    rebuildIndex(dir, join(dir, "merged_index.db"));

    const outputPath = join(dir, "dashboard.html");
    generateDashboard({ repoDir: dir, indexPath: join(dir, "merged_index.db"), outputPath, openBrowser: false });

    const html = readFileSync(outputPath, "utf-8");
    expect(html).toContain("fact from alice");
    expect(html).toContain("fact from bob");
    expect(html).toContain("alice");
    expect(html).toContain("bob");
  });
});

describe("assembleDashboardData", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-dashboard-data-"));
    makeRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("returns empty data when index does not exist", () => {
    const data = assembleDashboardData(dir, join(dir, "missing.db"));
    expect(data.facts).toHaveLength(0);
    expect(data.authors).toHaveLength(0);
  });

  it("builds tag index sorted by frequency", () => {
    const db = openFactsDb(join(dir, "facts"), "alice");
    insertFact(db, { content: "fact one", tags: ["go", "config"] });
    insertFact(db, { content: "fact two", tags: ["go", "testing"] });
    insertFact(db, { content: "fact three", tags: ["go"] });
    db.close();
    rebuildIndex(dir, join(dir, "merged_index.db"));

    const data = assembleDashboardData(dir, join(dir, "merged_index.db"));
    expect(data.tagIndex[0].tag).toBe("go");
    expect(data.tagIndex[0].count).toBe(3);
  });
});

describe("team-memory dashboard CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tm-dashboard-cli-"));
    makeRepo(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it("writes dashboard.html and prints path", () => {
    const db = openFactsDb(join(dir, "facts"), "testdev");
    insertFact(db, { content: "cli dashboard test fact" });
    db.close();
    rebuildIndex(dir, join(dir, "merged_index.db"));

    const output = execFileSync("node", [CLI_PATH, "dashboard", "--no-open"], {
      encoding: "utf-8",
      env: {
        ...process.env,
        TEAM_MEMORY_DIR: dir,
        TEAM_MEMORY_DEVELOPER: "testdev",
        TEAM_MEMORY_INDEX_PATH: join(dir, "merged_index.db"),
      },
    });

    expect(existsSync(join(dir, "dashboard.html"))).toBe(true);
    expect(output).toContain("dashboard.html");
    expect(output).toContain("facts");
  });
});
