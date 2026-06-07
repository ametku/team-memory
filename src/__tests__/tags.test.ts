import { describe, test, expect } from "vitest";
import { isValidCategory, extractCategory, extractKeywords, normalizeTags } from "../tags.js";

describe("isValidCategory", () => {
  test.each(["gotcha", "convention", "tool", "workaround", "decision"])(
    "returns true for known category %s",
    (value) => {
      expect(isValidCategory(value)).toBe(true);
    },
  );

  test("returns false for unknown category", () => {
    expect(isValidCategory("bug")).toBe(false);
  });

  test("returns false for category prefix without value", () => {
    expect(isValidCategory("category:")).toBe(false);
  });

  test("is case-sensitive (expects already-lowercased input)", () => {
    expect(isValidCategory("Gotcha")).toBe(false);
  });
});

describe("extractCategory", () => {
  test("returns the category value when first tag is a category prefix", () => {
    expect(extractCategory(["category:gotcha", "networking"])).toBe("gotcha");
  });

  test("scans every tag for the category prefix (not just first)", () => {
    expect(extractCategory(["networking", "category:tool"])).toBe("tool");
  });

  test("returns null when no category prefix is present", () => {
    expect(extractCategory(["networking", "docker"])).toBeNull();
  });

  test("returns null for empty input", () => {
    expect(extractCategory([])).toBeNull();
  });
});

describe("extractKeywords", () => {
  test("returns tags without the category prefix entry", () => {
    expect(extractKeywords(["category:gotcha", "networking", "docker"])).toEqual([
      "networking",
      "docker",
    ]);
  });

  test("returns all tags when no category prefix is present", () => {
    expect(extractKeywords(["networking", "docker"])).toEqual(["networking", "docker"]);
  });

  test("strips multiple category prefixes if present (defensive)", () => {
    expect(extractKeywords(["category:gotcha", "category:tool", "kw"])).toEqual(["kw"]);
  });

  test("returns empty array for empty input", () => {
    expect(extractKeywords([])).toEqual([]);
  });
});

describe("normalizeTags", () => {
  test("lowercases each tag", () => {
    const result = normalizeTags('["Category:Gotcha","Docker","NETWORKING"]');
    expect(result.tags).toEqual(["category:gotcha", "docker", "networking"]);
    expect(result.warning).toBeNull();
  });

  test("trims whitespace from each tag", () => {
    const result = normalizeTags('["  category:tool  ","  docker  "]');
    expect(result.tags).toEqual(["category:tool", "docker"]);
  });

  test("dedupes tags after normalization, preserving first occurrence order", () => {
    const result = normalizeTags('["Docker","docker","DOCKER","networking"]');
    expect(result.tags).toEqual(["docker", "networking"]);
  });

  test("drops empty strings", () => {
    const result = normalizeTags('["category:gotcha","","   "]');
    expect(result.tags).toEqual(["category:gotcha"]);
  });

  test("returns empty array for null/empty input without warning", () => {
    expect(normalizeTags(null)).toEqual({ tags: [], warning: null });
    expect(normalizeTags("")).toEqual({ tags: [], warning: null });
    expect(normalizeTags("[]")).toEqual({ tags: [], warning: null });
  });

  test("returns warning for malformed JSON, with empty tags", () => {
    const result = normalizeTags("not-json");
    expect(result.tags).toEqual([]);
    expect(result.warning).toMatch(/malformed/i);
  });

  test("returns warning when JSON is not an array", () => {
    const result = normalizeTags('{"a":1}');
    expect(result.tags).toEqual([]);
    expect(result.warning).toMatch(/array/i);
  });

  test("ignores non-string entries inside the array", () => {
    const result = normalizeTags('["docker", 42, null, "networking"]');
    expect(result.tags).toEqual(["docker", "networking"]);
  });

  test("returns unknown category in warning when category prefix value is not in enum", () => {
    const result = normalizeTags('["category:bug","docker"]');
    expect(result.tags).toEqual(["category:bug", "docker"]);
    expect(result.warning).toMatch(/unknown category.*bug/i);
  });

  test("legacy facts without category prefix produce no warning", () => {
    const result = normalizeTags('["docker","networking"]');
    expect(result.tags).toEqual(["docker", "networking"]);
    expect(result.warning).toBeNull();
  });
});
