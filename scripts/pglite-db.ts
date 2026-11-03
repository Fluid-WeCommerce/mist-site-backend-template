import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/db.js";

/** A `Db` backed by PGlite (in-process Postgres). Used by tests and `npm run dev`. */
export function pgliteDb(pg: PGlite): Db {
  return {
    query: async (text, params = []) => (await pg.query(text, params)).rows as Record<string, unknown>[],
    transaction: async (statements) => {
      await pg.transaction(async (tx) => {
        for (const statement of statements) await tx.query(statement.text, statement.params ?? []);
      });
    },
  };
}
