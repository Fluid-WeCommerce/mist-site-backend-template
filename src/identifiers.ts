import { invalidParams } from "./errors.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Refuses a name that cannot be an identifier before it is looked up in the catalog. */
export function checkIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw invalidParams(`${field} must be an identifier matching ${IDENTIFIER.source}`, field);
  }
  return value;
}

/** Double-quotes a name. Callers pass only names found in the catalog. */
export function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A catalog table name, schema-qualified; only `public` is reachable. */
export function quoteTable(name: string): string {
  return `"public".${quote(name)}`;
}
