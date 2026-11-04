import { neon } from "@neondatabase/serverless";

export type Row = Record<string, unknown>;

export interface Statement {
  text: string;
  params?: unknown[];
}

export interface QueryResult {
  rows: Row[];
  /** Rows the statement returned or touched, as Postgres reports it. */
  rowCount: number;
}

/**
 * The only database surface the operations use, so tests can inject PGlite.
 * Statements run in order inside one transaction and every result comes back.
 */
export interface Db {
  transaction(statements: Statement[]): Promise<QueryResult[]>;
}

/** Neon over HTTP: stateless, so it suits serverless functions. */
export function neonDb(databaseUrl: string): Db {
  const sql = neon(databaseUrl);
  return {
    transaction: async (statements) => {
      const queries = statements.map((s) => sql.query(s.text, s.params ?? []));
      const results = (await sql.transaction(queries, { fullResults: true })) as unknown as {
        rows: Row[];
        rowCount: number | null;
      }[];
      return results.map((r) => ({ rows: r.rows, rowCount: r.rowCount ?? r.rows.length }));
    },
  };
}

/** Every operation runs under this statement timeout, below Rails' 5 second read timeout. */
export const STATEMENT_TIMEOUT_MS = 3000;

/** Runs the statements in one transaction after `SET LOCAL statement_timeout`. */
export async function run(db: Db, statements: Statement[]): Promise<QueryResult[]> {
  const results = await db.transaction([
    { text: `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}` },
    ...statements,
  ]);
  return results.slice(1);
}
