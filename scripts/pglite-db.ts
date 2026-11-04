import { PGlite } from "@electric-sql/pglite";
import type { Db, QueryResult } from "../src/db.js";

/** A `Db` backed by PGlite (in-process Postgres). Used by tests and `npm run dev`. */
export function pgliteDb(pg: PGlite): Db {
  return {
    transaction: (statements) =>
      pg.transaction(async (tx) => {
        const results: QueryResult[] = [];
        for (const statement of statements) {
          const result = await tx.query(statement.text, statement.params ?? []);
          results.push({
            rows: result.rows as Record<string, unknown>[],
            rowCount: result.affectedRows ?? result.rows.length,
          });
        }
        return results;
      }),
  };
}
