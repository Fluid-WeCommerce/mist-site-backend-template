import type { Db } from "../db.js";

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface TableInfo {
  name: string;
  columns: { name: string; type: string; nullable: boolean; default: string | null }[];
}

export async function tablesList(db: Db): Promise<{ tables: TableInfo[] }> {
  const rows = (await db.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  )) as unknown as ColumnRow[];

  const tables: TableInfo[] = [];
  for (const row of rows) {
    let table = tables[tables.length - 1];
    if (!table || table.name !== row.table_name) {
      table = { name: row.table_name, columns: [] };
      tables.push(table);
    }
    table.columns.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
      default: row.column_default ?? null,
    });
  }
  return { tables };
}
