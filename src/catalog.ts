import { run, type Db } from "./db.js";
import { invalidParams, tableNotFound } from "./errors.js";
import { checkIdentifier } from "./identifiers.js";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primary_key: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

const CATALOG_SQL = `
  SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default,
         (pk.column_name IS NOT NULL) AS primary_key
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    LEFT JOIN (
      SELECT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name = tc.constraint_name
         AND kcu.table_name = tc.table_name
       WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
    ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
   WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'`;

interface CatalogRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  primary_key: boolean;
}

function group(rows: CatalogRow[]): TableInfo[] {
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
      primary_key: row.primary_key === true,
    });
  }
  return tables;
}

export async function listTables(db: Db): Promise<TableInfo[]> {
  const [result] = await run(db, [
    { text: `${CATALOG_SQL} ORDER BY c.table_name, c.ordinal_position` },
  ]);
  return group((result?.rows ?? []) as unknown as CatalogRow[]);
}

/** Finds a table in the catalog, or answers 404 `table_not_found`. No row statement has run yet. */
export async function findTable(db: Db, name: unknown): Promise<TableInfo> {
  const checked = checkIdentifier(name, "table");
  const [result] = await run(db, [
    { text: `${CATALOG_SQL} AND c.table_name = $1 ORDER BY c.ordinal_position`, params: [checked] },
  ]);
  const [table] = group((result?.rows ?? []) as unknown as CatalogRow[]);
  if (!table) throw tableNotFound(checked);
  return table;
}

/** A column of the table, by the catalog's own name, or 422 `invalid_params`. */
export function findColumn(table: TableInfo, name: unknown, field: string): ColumnInfo {
  const checked = checkIdentifier(name, field);
  const column = table.columns.find((c) => c.name === checked);
  if (!column) throw invalidParams(`${field}: table "${table.name}" has no column "${checked}"`, field);
  return column;
}

/** The table's single-column primary key, or 422 `invalid_params`. */
export function singleKey(table: TableInfo): ColumnInfo {
  const keys = table.columns.filter((c) => c.primary_key);
  const [key] = keys;
  if (!key || keys.length !== 1) {
    throw invalidParams(`table "${table.name}" has no single-column primary key`, "table");
  }
  return key;
}
