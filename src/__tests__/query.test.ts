import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { openFactsDb, insertFact } from "../facts-db.js";
import { openInteractionsDb } from "../interactions-db.js";
import { rebuildIndex } from "../merged-index.js";
import { queryFacts } from "../query.js";

describe("queryFacts", () => {
  let repoDir: string;
  let indexPath: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "team-memory-query-"));
    mkdirSync(join(repoDir, "facts"));
    mkdirSync(join(repoDir, "interactions"));
    indexPath = join(repoDir, "merged_index.db");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true });
  });

  function seedAndBuild(facts: { content: string; project?: string; tags?: string[] }[]) {
    const db = openFactsDb(join(repoDir, "facts"), "alice");
    for (const f of facts) {
      insertFact(db, f);
    }
    db.close();
    rebuildIndex(repoDir, indexPath);
  }

  describe("basic FTS search", () => {
    test("returns facts matching query text in content", () => {
      seedAndBuild([
        { content: "Use viper for config parsing in Go services" },
        { content: "Stripe webhooks must be idempotent" },
      ]);

      const results = queryFacts({ indexPath, query: "viper config" });

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("viper");
    });

    test("returns facts matching query text in project field", () => {
      seedAndBuild([
        { content: "API uses gRPC", project: "payments-service" },
        { content: "Frontend uses React", project: "web-app" },
      ]);

      const results = queryFacts({ indexPath, query: "payments" });

      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("API uses gRPC");
      expect(results[0].project).toBe("payments-service");
    });

    test("returns facts matching query text in tags", () => {
      seedAndBuild([
        { content: "Docker networking uses bridge by default", tags: ["docker", "networking"] },
        { content: "Jest runs tests in parallel", tags: ["testing", "jest"] },
      ]);

      const results = queryFacts({ indexPath, query: "docker" });

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("Docker networking");
    });
  });

  describe("tag-based retrieval (keyword synonyms)", () => {
    test("surfaces fact via freeform keyword tag even when keyword absent from content", () => {
      seedAndBuild([
        { content: "The service retries flaky calls three times", tags: ["reliability", "resilience"] },
        { content: "Use structured logging everywhere", tags: ["observability"] },
      ]);

      const results = queryFacts({ indexPath, query: "resilience" });

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("retries flaky calls");
    });
  });

  describe("category prefix filtering", () => {
    test("filters results by category prefix in query", () => {
      seedAndBuild([
        { content: "Never use force push on main", tags: ["category:gotcha", "git"] },
        { content: "Use conventional commits", tags: ["category:convention", "git"] },
      ]);

      const results = queryFacts({ indexPath, query: "category:gotcha git" });

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("force push");
    });
  });

  describe("ranking by bm25 * trust", () => {
    test("higher trust facts rank above lower trust facts for same query", () => {
      const factsDb = openFactsDb(join(repoDir, "facts"), "alice");
      const highTrust = insertFact(factsDb, { content: "Config parsing requires viper library" });
      const lowTrust = insertFact(factsDb, { content: "Config parsing can also use envconfig" });
      factsDb.close();

      const intDb = openInteractionsDb(join(repoDir, "interactions"), "alice");
      intDb.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(highTrust.id, 20, "2026-01-15T00:00:00.000Z", 0);
      intDb.prepare(
        "INSERT INTO interactions (fact_id, surface_count, last_surfaced_at, explicit_score) VALUES (?, ?, ?, ?)"
      ).run(lowTrust.id, 1, "2026-01-01T00:00:00.000Z", 0);
      intDb.close();

      rebuildIndex(repoDir, indexPath);

      const results = queryFacts({ indexPath, query: "config parsing" });

      expect(results).toHaveLength(2);
      expect(results[0].content).toContain("viper");
      expect(results[0].trust).toBeGreaterThan(results[1].trust);
    });
  });

  describe("limit", () => {
    test("defaults to 5 results", () => {
      seedAndBuild(
        Array.from({ length: 10 }, (_, i) => ({ content: `Config fact number ${i}` }))
      );

      const results = queryFacts({ indexPath, query: "config fact" });

      expect(results).toHaveLength(5);
    });

    test("respects custom limit", () => {
      seedAndBuild(
        Array.from({ length: 10 }, (_, i) => ({ content: `Config fact number ${i}` }))
      );

      const results = queryFacts({ indexPath, query: "config fact", limit: 3 });

      expect(results).toHaveLength(3);
    });
  });

  describe("result shape", () => {
    test("includes id, content, project, tags, and trust", () => {
      seedAndBuild([
        { content: "Always use TLS in production", project: "infra", tags: ["category:gotcha", "security"] },
      ]);

      const results = queryFacts({ indexPath, query: "TLS production" });

      expect(results).toHaveLength(1);
      const r = results[0];
      expect(r.id).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(r.content).toBe("Always use TLS in production");
      expect(r.project).toBe("infra");
      expect(r.tags).toBe('["category:gotcha","security"]');
      expect(r.trust).toBe(1.0);
    });
  });

  describe("project scoping", () => {
    test("project filter returns facts with matching project plus team-wide facts", () => {
      seedAndBuild([
        { content: "payments-specific fact", project: "payments-service" },
        { content: "frontend-specific fact", project: "web-app" },
        { content: "team-wide fact" },
      ]);

      const results = queryFacts({ indexPath, query: "fact", limit: 10, project: "payments-service" });

      const contents = results.map((r) => r.content);
      expect(contents).toContain("payments-specific fact");
      expect(contents).toContain("team-wide fact");
      expect(contents).not.toContain("frontend-specific fact");
    });

    test("no project filter returns all facts regardless of project", () => {
      seedAndBuild([
        { content: "payments-specific fact", project: "payments-service" },
        { content: "frontend-specific fact", project: "web-app" },
        { content: "team-wide fact" },
      ]);

      const results = queryFacts({ indexPath, query: "fact", limit: 10 });

      expect(results).toHaveLength(3);
    });

    test("limit is respected after post-filter when many facts match other projects", () => {
      const facts = [
        ...Array.from({ length: 20 }, (_, i) => ({ content: `unrelated fact ${i}`, project: "web-app" })),
        ...Array.from({ length: 3 }, (_, i) => ({ content: `relevant fact ${i}`, project: "payments-service" })),
      ];
      seedAndBuild(facts);

      const results = queryFacts({ indexPath, query: "fact", limit: 5, project: "payments-service" });

      for (const r of results) {
        expect(r.project === "payments-service" || r.project === "").toBe(true);
      }
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(5);
    });
  });

  describe("missing database", () => {
    test("throws descriptive error when index file does not exist", () => {
      const missingPath = join(repoDir, "nonexistent.db");

      expect(() => queryFacts({ indexPath: missingPath, query: "anything" })).toThrow(
        /merged_index\.db not found/
      );
    });
  });

  describe("performance", () => {
    test("completes query in under 100ms", () => {
      seedAndBuild(
        Array.from({ length: 100 }, (_, i) => ({ content: `Fact about topic ${i} with various keywords` }))
      );

      const start = performance.now();
      queryFacts({ indexPath, query: "topic keywords" });
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100);
    });
  });
});
