import { listTables, type TableInfo } from "../catalog.js";
import type { OperationContext } from "./index.js";

export async function tablesList({ db }: OperationContext): Promise<{ tables: TableInfo[] }> {
  return { tables: await listTables(db) };
}
