import { invalidParams } from "../errors.js";

export type Scalar = string | number | boolean | null;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isScalar(value: unknown): value is Scalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** Collects bound parameters and hands back their `$n` placeholders. */
export class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * A value to write into a column. Scalars bind as they are; objects and
 * arrays are sent as JSON text, which Postgres reads into json/jsonb columns.
 */
export function columnValue(value: unknown, field: string): unknown {
  if (isScalar(value)) return value;
  if (typeof value === "object") return JSON.stringify(value);
  throw invalidParams(`${field} must be a string, number, boolean, null, object or array`, field);
}

/** A row key: a non-empty string or a number. */
export function recordId(value: unknown): string | number {
  if ((typeof value === "string" && value !== "") || typeof value === "number") return value;
  throw invalidParams("id must be a string or number", "id");
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw invalidParams(`${field} must be an object`, field);
  return value;
}
