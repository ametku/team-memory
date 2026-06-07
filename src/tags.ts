export const VALID_CATEGORIES = ["gotcha", "convention", "tool", "workaround", "decision"] as const;
export type Category = (typeof VALID_CATEGORIES)[number];

const CATEGORY_PREFIX = "category:";

export function isValidCategory(value: string): boolean {
  return (VALID_CATEGORIES as readonly string[]).includes(value);
}

export function extractCategory(tags: string[]): string | null {
  for (const tag of tags) {
    if (tag.startsWith(CATEGORY_PREFIX)) {
      return tag.slice(CATEGORY_PREFIX.length);
    }
  }
  return null;
}

export function extractKeywords(tags: string[]): string[] {
  return tags.filter((t) => !t.startsWith(CATEGORY_PREFIX));
}

export interface NormalizeResult {
  tags: string[];
  warning: string | null;
}

export function normalizeTags(raw: string | null): NormalizeResult {
  if (raw == null || raw === "") return { tags: [], warning: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { tags: [], warning: `malformed tags JSON: ${truncate(raw)}` };
  }

  if (!Array.isArray(parsed)) {
    return { tags: [], warning: `tags is not a JSON array: ${truncate(raw)}` };
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const norm = entry.trim().toLowerCase();
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }

  const category = extractCategory(out);
  const warning =
    category !== null && !isValidCategory(category)
      ? `unknown category: ${category}`
      : null;

  return { tags: out, warning };
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}
