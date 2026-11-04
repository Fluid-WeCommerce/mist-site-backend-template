import { run } from "../db.js";
import { invalidParams } from "../errors.js";
import type { OperationContext } from "./index.js";
import { checkSchemaStatement } from "./statement.js";

export const MAX_SQL_ROWS = 100;

/**
 * Runs one schema statement that cannot read or rewrite rows (see
 * `statement.ts`). This is a guard against mistakes, not a sandbox: the
 * database belongs to the site owner.
 */
export async function sqlRun(
  { db }: OperationContext,
  params: Record<string, unknown>,
): Promise<{ command: string; row_count: number; rows: unknown[]; truncated: boolean }> {
  if (typeof params.statement !== "string") {
    throw invalidParams("statement must be a string", "statement");
  }

  let statement = params.statement.trim();
  if (statement.endsWith(";")) statement = statement.slice(0, -1).trim();
  const command = checkSchemaStatement(statement);

  const [result] = await run(db, [{ text: statement }]);
  const rows = result?.rows ?? [];
  return {
    command,
    row_count: result?.rowCount ?? 0,
    rows: rows.slice(0, MAX_SQL_ROWS),
    truncated: rows.length > MAX_SQL_ROWS,
  };
}
