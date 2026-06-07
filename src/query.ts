import Database from "better-sqlite3";
import { existsSync } from "fs";

export interface QueryFactsInput {
  indexPath: string;
  query: string;
  limit?: number;
  project?: string;
}

export interface QueryResult {
  id: string;
  content: string;
  project: string;
  tags: string;
  trust: number;
}

function rewriteQuery(query: string): string {
  return query.replace(/\bcategory:\S+/g, (match) => `tags:"${match}"`);
}

export function queryFacts(input: QueryFactsInput): QueryResult[] {
  const { indexPath, query, limit = 5, project } = input;

  if (!existsSync(indexPath)) {
    throw new Error("merged_index.db not found. Run `team-memory rebuild-index` first.");
  }

  const db = new Database(indexPath, { readonly: true });
  const ftsQuery = rewriteQuery(query);

  try {
    if (project) {
      return db.prepare(`
        SELECT id, content, project, tags, trust
        FROM facts_view
        WHERE facts_view MATCH ?
          AND (project = ? OR project = '')
        ORDER BY bm25(facts_view) * trust
        LIMIT ?
      `).all(ftsQuery, project, limit) as QueryResult[];
    }

    return db.prepare(`
      SELECT id, content, project, tags, trust
      FROM facts_view
      WHERE facts_view MATCH ?
      ORDER BY bm25(facts_view) * trust
      LIMIT ?
    `).all(ftsQuery, limit) as QueryResult[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}
