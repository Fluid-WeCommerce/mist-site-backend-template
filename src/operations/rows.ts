import type { Db, Row } from "../db.js";
import { ApiError, invalidParams } from "../errors.js";
import { quoteIdentifier, quoteTable } from "../identifiers.js";
import {
  Params,
  columnValue,
  isPlainObject,
  isScalar,
  recordId,
  requireObject,
} from "./params.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
const MAX_IN_VALUES = 100;
const MAX_INSERT_ROWS = 100;
const MAX_ORDER_COLUMNS = 10;
const MAX_OFFSET = 1_000_000_000;

const COMPARISONS: Record<string, string> = {
  eq: "=",
  neq: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

function notFound(): ApiError {
  return new ApiError(404, "not_found", "No row with that id");
}

/** One `where` entry may carry several operators; they are ANDed. */
function condition(column: string, spec: unknown, params: Params): string[] {
  const quoted = quoteIdentifier(column, `where column "${column}"`);
  const operators = isPlainObject(spec) ? Object.entries(spec) : [["eq", spec] as const];
  if (operators.length === 0) throw invalidParams(`where.${column} must not be an empty object`);

  return operators.map(([op, value]) => {
    const field = `where.${column}.${op}`;
    if (op === "is_null") {
      if (typeof value !== "boolean") throw invalidParams(`${field} must be a boolean`);
      return `${quoted} IS ${value ? "" : "NOT "}NULL`;
    }
    if (op === "in") {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_VALUES) {
        throw invalidParams(`${field} must be an array of 1 to ${MAX_IN_VALUES} values`);
      }
      if (!value.every((v) => isScalar(v) && v !== null)) {
        throw invalidParams(`${field} must contain only strings, numbers or booleans`);
      }
      return `${quoted} IN (${value.map((v) => params.add(v)).join(", ")})`;
    }
    if (op === "like" || op === "ilike") {
      if (typeof value !== "string") throw invalidParams(`${field} must be a string`);
      return `${quoted} ${op.toUpperCase()} ${params.add(value)}`;
    }
    const symbol = Object.hasOwn(COMPARISONS, op) ? COMPARISONS[op] : undefined;
    if (!symbol) throw invalidParams(`${field}: unknown operator "${op}"`);
    if (!isScalar(value)) throw invalidParams(`${field} must be a string, number, boolean or null`);
    if (value === null) {
      // `= NULL` never matches in SQL; read a null comparison as an IS test.
      if (op === "eq") return `${quoted} IS NULL`;
      if (op === "neq") return `${quoted} IS NOT NULL`;
      throw invalidParams(`${field} cannot be null`);
    }
    return `${quoted} ${symbol} ${params.add(value)}`;
  });
}

function whereClause(where: unknown, params: Params): string {
  if (where === undefined) return "";
  const spec = requireObject(where, "where");
  const clauses = Object.entries(spec).flatMap(([column, value]) =>
    condition(column, value, params),
  );
  return clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
}

function orderClause(order: unknown): string {
  if (order === undefined) return "";
  if (!Array.isArray(order) || order.length > MAX_ORDER_COLUMNS) {
    throw invalidParams(`order must be an array of at most ${MAX_ORDER_COLUMNS} entries`);
  }
  const parts = order.map((entry, index) => {
    const item = requireObject(entry, `order[${index}]`);
    const column = quoteIdentifier(item.column, `order[${index}].column`);
    const direction = item.direction ?? "asc";
    if (direction !== "asc" && direction !== "desc") {
      throw invalidParams(`order[${index}].direction must be "asc" or "desc"`);
    }
    return `${column} ${direction.toUpperCase()}`;
  });
  return parts.length > 0 ? ` ORDER BY ${parts.join(", ")}` : "";
}

/** `limit` above the maximum is capped, not refused. */
function limitValue(limit: unknown): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw invalidParams("limit must be a positive integer");
  }
  return Math.min(limit, MAX_LIMIT);
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: unknown): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string") throw invalidParams("cursor must be a string");
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[0-9]{1,10}$/.test(text) || Number(text) > MAX_OFFSET) {
    throw invalidParams("cursor is not valid");
  }
  return Number(text);
}

export async function rowsList(
  db: Db,
  params: Record<string, unknown>,
): Promise<{ rows: Row[]; next_cursor: string | null }> {
  const table = quoteTable(params.table);
  const limit = limitValue(params.limit);
  const offset = decodeCursor(params.cursor);

  const bound = new Params();
  const where = whereClause(params.where, bound);
  const order = orderClause(params.order);
  const sql = `SELECT * FROM ${table}${where}${order} LIMIT ${bound.add(limit + 1)} OFFSET ${bound.add(offset)}`;

  const fetched = await db.query(sql, bound.values);
  const hasMore = fetched.length > limit;
  return {
    rows: hasMore ? fetched.slice(0, limit) : fetched,
    next_cursor: hasMore ? encodeCursor(offset + limit) : null,
  };
}

export async function rowsInsert(
  db: Db,
  params: Record<string, unknown>,
): Promise<{ rows: Row[] }> {
  const table = quoteTable(params.table);
  const rows = params.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_INSERT_ROWS) {
    throw invalidParams(`rows must be an array of 1 to ${MAX_INSERT_ROWS} objects`);
  }

  const objects = rows.map((row, index) => requireObject(row, `rows[${index}]`));
  const keys = Object.keys(objects[0] as Record<string, unknown>);
  if (keys.length === 0) throw invalidParams("rows[0] must have at least one column");
  const columns = keys.map((key) => quoteIdentifier(key, `column "${key}"`));

  const bound = new Params();
  const tuples = objects.map((row, index) => {
    const rowKeys = Object.keys(row);
    if (rowKeys.length !== keys.length || !keys.every((key) => Object.hasOwn(row, key))) {
      throw invalidParams(`rows[${index}] must have the same columns as rows[0]`);
    }
    const placeholders = keys.map((key) =>
      bound.add(columnValue(row[key], `rows[${index}].${key}`)),
    );
    return `(${placeholders.join(", ")})`;
  });

  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")} RETURNING *`;
  return { rows: await db.query(sql, bound.values) };
}

export async function rowsUpdate(
  db: Db,
  params: Record<string, unknown>,
): Promise<{ row: Row }> {
  const table = quoteTable(params.table);
  const id = recordId(params.id);
  const values = requireObject(params.values, "values");
  const entries = Object.entries(values);
  if (entries.length === 0) throw invalidParams("values must not be empty");
  if (Object.hasOwn(values, "id")) throw invalidParams("values.id cannot be updated");

  const bound = new Params();
  const assignments = entries.map(
    ([key, value]) =>
      `${quoteIdentifier(key, `column "${key}"`)} = ${bound.add(columnValue(value, `values.${key}`))}`,
  );
  const sql = `UPDATE ${table} SET ${assignments.join(", ")} WHERE "id" = ${bound.add(id)} RETURNING *`;

  const [row] = await db.query(sql, bound.values);
  if (!row) throw notFound();
  return { row };
}

export async function rowsDelete(
  db: Db,
  params: Record<string, unknown>,
): Promise<{ deleted: true }> {
  const table = quoteTable(params.table);
  const id = recordId(params.id);
  const deleted = await db.query(`DELETE FROM ${table} WHERE "id" = $1 RETURNING "id"`, [id]);
  if (deleted.length === 0) throw notFound();
  return { deleted: true };
}

