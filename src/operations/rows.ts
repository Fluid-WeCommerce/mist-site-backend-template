import { findColumn, findTable, singleKey, type TableInfo } from "../catalog.js";
import { issueCursor, queryFingerprint, readCursor } from "../cursor.js";
import { run, type Row } from "../db.js";
import { ApiError, invalidParams, rowNotFound } from "../errors.js";
import { quote, quoteTable } from "../identifiers.js";
import { toJson } from "../json.js";
import type { OperationContext } from "./index.js";
import { Params, columnValue, isScalar, recordId, requireObject } from "./params.js";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
/** A page ends before its serialized rows pass this many bytes (the response cap is 256 KiB). */
export const PAGE_BYTE_BUDGET = 192 * 1024;
const MAX_IN_VALUES = 100;
const MAX_INSERT_ROWS = 100;
const MAX_FILTERS = 50;
const MAX_SORT_COLUMNS = 10;

const COMPARISONS: Record<string, string> = {
  eq: "=",
  neq: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};
const OPERATORS = [...Object.keys(COMPARISONS), "in", "is_null"];

interface Filter {
  column: string;
  op: string;
  value: unknown;
}

interface Sort {
  column: string;
  direction: "asc" | "desc";
}

function parseFilters(raw: unknown): Filter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_FILTERS) {
    throw invalidParams(`filters must be an array of at most ${MAX_FILTERS} entries`, "filters");
  }
  return raw.map((entry, i) => {
    const field = `filters[${i}]`;
    const item = requireObject(entry, field);
    const { column, op, value } = item;
    if (typeof column !== "string") throw invalidParams(`${field}.column must be a string`, `${field}.column`);
    if (typeof op !== "string" || !OPERATORS.includes(op)) {
      throw invalidParams(`${field}.op must be one of ${OPERATORS.join(", ")}`, `${field}.op`);
    }
    return { column, op, value };
  });
}

function parseSort(raw: unknown): Sort[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SORT_COLUMNS) {
    throw invalidParams(`sort must be an array of at most ${MAX_SORT_COLUMNS} entries`, "sort");
  }
  return raw.map((entry, i) => {
    const field = `sort[${i}]`;
    const item = requireObject(entry, field);
    if (typeof item.column !== "string") {
      throw invalidParams(`${field}.column must be a string`, `${field}.column`);
    }
    const direction = item.direction ?? "asc";
    if (direction !== "asc" && direction !== "desc") {
      throw invalidParams(`${field}.direction must be "asc" or "desc"`, `${field}.direction`);
    }
    return { column: item.column, direction };
  });
}

function limitValue(limit: unknown): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalidParams(`limit must be an integer from 1 to ${MAX_LIMIT}`, "limit");
  }
  return limit;
}

function condition(table: TableInfo, filter: Filter, index: number, params: Params): string {
  const field = `filters[${index}]`;
  const column = quote(findColumn(table, filter.column, `${field}.column`).name);
  const { op, value } = filter;
  const valueField = `${field}.value`;

  if (op === "is_null") {
    if (typeof value !== "boolean") throw invalidParams(`${valueField} must be a boolean`, valueField);
    return `${column} IS ${value ? "" : "NOT "}NULL`;
  }
  if (op === "in") {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_VALUES) {
      throw invalidParams(`${valueField} must be an array of 1 to ${MAX_IN_VALUES} values`, valueField);
    }
    if (!value.every((v) => isScalar(v) && v !== null)) {
      throw invalidParams(`${valueField} must contain only strings, numbers or booleans`, valueField);
    }
    return `${column} IN (${value.map((v) => params.add(v)).join(", ")})`;
  }
  if (!isScalar(value)) {
    throw invalidParams(`${valueField} must be a string, number, boolean or null`, valueField);
  }
  if (value === null) {
    // `= NULL` never matches in SQL; read a null comparison as an IS test.
    if (op === "eq") return `${column} IS NULL`;
    if (op === "neq") return `${column} IS NOT NULL`;
    throw invalidParams(`${valueField} cannot be null for ${op}`, valueField);
  }
  return `${column} ${COMPARISONS[op]} ${params.add(value)}`;
}

export async function rowsList(
  { db, secret }: OperationContext,
  params: Record<string, unknown>,
): Promise<{ rows: Row[]; next_cursor: string | null }> {
  const limit = limitValue(params.limit);
  const filters = parseFilters(params.filters);
  const sort = parseSort(params.sort);
  const table = await findTable(db, params.table);

  const bound = new Params();
  const where = filters.map((f, i) => condition(table, f, i, bound));
  const order = sort.map((s, i) => `${quote(findColumn(table, s.column, `sort[${i}].column`).name)} ${s.direction.toUpperCase()}`);
  // Ending the order with the primary key keeps offset paging stable.
  const sorted = new Set(sort.map((s) => s.column));
  for (const column of table.columns) {
    if (column.primary_key && !sorted.has(column.name)) order.push(quote(column.name));
  }

  const fingerprint = queryFingerprint({ table: table.name, filters, sort });
  const offset = params.cursor === undefined ? 0 : readCursor(secret, fingerprint, params.cursor);

  const sql =
    `SELECT * FROM ${quoteTable(table.name)}` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    (order.length > 0 ? ` ORDER BY ${order.join(", ")}` : "") +
    ` LIMIT ${bound.add(limit + 1)} OFFSET ${bound.add(offset)}`;
  const [result] = await run(db, [{ text: sql, params: bound.values }]);
  const fetched = result?.rows ?? [];

  // Take rows until the limit or the byte budget, whichever comes first.
  const page: Row[] = [];
  let bytes = 2;
  for (const row of fetched.slice(0, limit)) {
    const size = Buffer.byteLength(toJson(row)) + (page.length > 0 ? 1 : 0);
    if (bytes + size > PAGE_BYTE_BUDGET) {
      if (page.length === 0) {
        throw new ApiError(422, "row_too_large", "A single row is larger than the response budget", {
          budget_bytes: PAGE_BYTE_BUDGET,
        });
      }
      break;
    }
    bytes += size;
    page.push(row);
  }

  const more = page.length < fetched.length;
  return {
    rows: page,
    next_cursor: more ? issueCursor(secret, fingerprint, offset + page.length) : null,
  };
}

export async function rowsInsert(
  { db }: OperationContext,
  params: Record<string, unknown>,
): Promise<{ rows: Row[] }> {
  const rows = params.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_INSERT_ROWS) {
    throw invalidParams(`rows must be an array of 1 to ${MAX_INSERT_ROWS} objects`, "rows");
  }
  const objects = rows.map((row, i) => requireObject(row, `rows[${i}]`));
  const keys = Object.keys(objects[0] as Record<string, unknown>);
  if (keys.length === 0) throw invalidParams("rows[0] must have at least one column", "rows[0]");
  objects.forEach((row, i) => {
    const rowKeys = Object.keys(row);
    if (rowKeys.length !== keys.length || !keys.every((k) => Object.hasOwn(row, k))) {
      throw invalidParams(`rows[${i}] must have the same columns as rows[0]`, `rows[${i}]`);
    }
  });

  const table = await findTable(db, params.table);
  const columns = keys.map((key) => quote(findColumn(table, key, `rows[0].${key}`).name));

  const bound = new Params();
  const tuples = objects.map((row, i) => {
    const placeholders = keys.map((key) => bound.add(columnValue(row[key], `rows[${i}].${key}`)));
    return `(${placeholders.join(", ")})`;
  });

  // One statement, so all rows are inserted or none.
  const sql = `INSERT INTO ${quoteTable(table.name)} (${columns.join(", ")}) VALUES ${tuples.join(", ")} RETURNING *`;
  const [result] = await run(db, [{ text: sql, params: bound.values }]);
  return { rows: result?.rows ?? [] };
}

export async function rowsUpdate(
  { db }: OperationContext,
  params: Record<string, unknown>,
): Promise<{ row: Row }> {
  const id = recordId(params.id);
  const values = requireObject(params.values, "values");
  const entries = Object.entries(values);
  if (entries.length === 0) throw invalidParams("values must not be empty", "values");

  const table = await findTable(db, params.table);
  const key = singleKey(table);

  const bound = new Params();
  const assignments = entries.map(([name, value]) => {
    const column = findColumn(table, name, `values.${name}`);
    if (column.name === key.name) {
      throw invalidParams(`values.${name} is the primary key and cannot be updated`, `values.${name}`);
    }
    return `${quote(column.name)} = ${bound.add(columnValue(value, `values.${name}`))}`;
  });
  const sql = `UPDATE ${quoteTable(table.name)} SET ${assignments.join(", ")} WHERE ${quote(key.name)} = ${bound.add(id)} RETURNING *`;

  const [result] = await run(db, [{ text: sql, params: bound.values }]);
  const row = result?.rows[0];
  if (!row) throw rowNotFound();
  return { row };
}

export async function rowsDelete(
  { db }: OperationContext,
  params: Record<string, unknown>,
): Promise<{ deleted: true }> {
  const id = recordId(params.id);
  const table = await findTable(db, params.table);
  const key = singleKey(table);

  const sql = `DELETE FROM ${quoteTable(table.name)} WHERE ${quote(key.name)} = $1 RETURNING ${quote(key.name)}`;
  const [result] = await run(db, [{ text: sql, params: [id] }]);
  if (!result || result.rows.length === 0) throw rowNotFound();
  return { deleted: true };
}

