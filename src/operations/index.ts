import type { Db } from "../db.js";
import { rowsDelete, rowsInsert, rowsList, rowsUpdate } from "./rows.js";
import { sqlRun } from "./sql.js";
import { tablesList } from "./tables.js";

export type Operation = (db: Db, params: Record<string, unknown>) => Promise<unknown>;

export const operations: Record<string, Operation> = {
  "tables.list": (db) => tablesList(db),
  "sql.run": sqlRun,
  "rows.list": rowsList,
  "rows.insert": rowsInsert,
  "rows.update": rowsUpdate,
  "rows.delete": rowsDelete,
};

export function findOperation(name: string): Operation | undefined {
  return Object.hasOwn(operations, name) ? operations[name] : undefined;
}
