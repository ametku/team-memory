import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SKILL_PATH = resolve(REPO_ROOT, ".agents/skills/extract-facts/SKILL.md");
const SYMLINK_PATH = resolve(REPO_ROOT, ".claude/skills/extract-facts");

const CATEGORIES = ["gotcha", "convention", "tool", "workaround", "decision"];

function parseFrontmatter(source: string): Record<string, string> {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("missing frontmatter");
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

describe("extract-facts skill", () => {
  it("SKILL.md exists at .agents/skills/extract-facts/", () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it("symlinked into .claude/skills/", () => {
    expect(lstatSync(SYMLINK_PATH).isSymbolicLink()).toBe(true);
    const target = readlinkSync(SYMLINK_PATH);
    expect(target).toBe("../../.agents/skills/extract-facts");
  });

  it("has required frontmatter (name, description)", () => {
    const fm = parseFrontmatter(readFileSync(SKILL_PATH, "utf-8"));
    expect(fm.name).toBe("extract-facts");
    expect(fm.description).toBeTruthy();
    expect(fm.description).toMatch(/use when/i);
  });

  it("body lists every supported category", () => {
    const body = readFileSync(SKILL_PATH, "utf-8");
    for (const c of CATEGORIES) {
      expect(body).toContain(c);
    }
  });

  it("body documents the tag-array format", () => {
    const body = readFileSync(SKILL_PATH, "utf-8");
    expect(body).toContain("category:");
    expect(body).toMatch(/team-memory add/);
    expect(body).toMatch(/team-memory sync --push/);
  });
});
