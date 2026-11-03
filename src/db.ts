import { neon } from "@neondatabase/serverless";

export type Row = Record<string, unknown>;

export interface Statement {
  text: string;
  params?: unknown[];
}

/** The only database surface the operations use, so tests can inject PGlite. */
export interface Db {
  query(text: string, params?: unknown[]): Promise<Row[]>;
  /** Runs the statements in order inside one transaction. */
  transaction(statements: Statement[]): Promise<void>;
}

/** Neon over HTTP: stateless, so it suits serverless functions. */
export function neonDb(databaseUrl: string): Db {
  const sql = neon(databaseUrl);
  return {
    query: async (text, params = []) => (await sql.query(text, params)) as Row[],
    transaction: async (statements) => {
      await sql.transaction(statements.map((s) => sql.query(s.text, s.params ?? [])));
    },
  };
}
