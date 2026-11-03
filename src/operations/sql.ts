import type { Db } from "../db.js";
import { ApiError, invalidParams } from "../errors.js";

const ALLOWED_KEYWORDS = new Set(["create", "alter", "drop", "comment"]);

function invalidStatement(message: string) {
  return new ApiError(400, "invalid_statement", message);
}

/**
 * Runs one schema-changing statement. This is a guard against mistakes, not a
 * sandbox: the database belongs to the site owner. A `;` anywhere in the
 * statement (even inside a string literal or a function body) is refused.
 */
export async function sqlRun(db: Db, params: Record<string, unknown>): Promise<{ ok: true }> {
  if (typeof params.statement !== "string") throw invalidParams("statement must be a string");

  let statement = params.statement.trim();
  if (statement.endsWith(";")) statement = statement.slice(0, -1).trim();
  if (statement === "") throw invalidStatement("statement is empty");
  if (statement.includes(";")) throw invalidStatement("only one statement is allowed");

  const keyword = /^[a-z]+/i.exec(statement)?.[0].toLowerCase();
  if (!keyword || !ALLOWED_KEYWORDS.has(keyword)) {
    throw invalidStatement("statement must start with create, alter, drop or comment");
  }

  await db.transaction([{ text: "SET LOCAL statement_timeout = 10000" }, { text: statement }]);
  return { ok: true };
}
