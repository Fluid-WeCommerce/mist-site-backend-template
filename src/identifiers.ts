import { invalidParams } from "./errors.js";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Validates a table or column name and returns it double-quoted. */
export function quoteIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw invalidParams(
      `${field} must be an identifier matching ${IDENTIFIER.source} (lowercase letters, digits, underscore)`,
    );
  }
  return `"${value}"`;
}

/** Validates a table name and returns it schema-qualified; only `public` is reachable. */
export function quoteTable(value: unknown, field = "table"): string {
  return `"public".${quoteIdentifier(value, field)}`;
}
