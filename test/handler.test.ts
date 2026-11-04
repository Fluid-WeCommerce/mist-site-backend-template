import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, Statement } from "../src/db.js";
import { MAX_LIMIT, PAGE_BYTE_BUDGET } from "../src/operations/rows.js";
import { pgliteDb } from "../scripts/pglite-db.js";
import {
  COMPANY_ID,
  SITE_ID,
  call,
  env,
  envelope,
  handlerFor,
  makeHandler,
  readJson,
  resetDatabase,
  signedRequest,
  type Json,
} from "./helpers.js";

let pg: PGlite;
let handle: ReturnType<typeof makeHandler>;

beforeAll(() => {
  pg = new PGlite();
  handle = makeHandler(pg);
});
afterAll(() => pg.close());
beforeEach(async () => {
  await resetDatabase(pg);
  await pg.exec(`
    CREATE TABLE notes (
      id serial PRIMARY KEY,
      title text NOT NULL UNIQUE,
      body text,
      rank integer,
      pinned boolean DEFAULT false
    );
  `);
});

const seed = (count: number) =>
  pg.exec(
    Array.from(
      { length: count },
      (_, i) => `INSERT INTO notes (title, rank) VALUES ('note ${String(i).padStart(3, "0")}', ${i});`,
    ).join("\n"),
  );

/** A Db over PGlite that records the statements it is asked to run. */
function recordingDb() {
  const real = pgliteDb(pg);
  const transactions: Statement[][] = [];
  const db: Db = {
    transaction: (statements) => {
      transactions.push(statements);
      return real.transaction(statements);
    },
  };
  return { db, transactions, statements: () => transactions.flat().map((s) => s.text) };
}

const failingDb = (error: unknown): Db => ({ transaction: () => Promise.reject(error) });

describe("site and company binding", () => {
  it("answers 403 wrong_site for another site id", async () => {
    const response = await handle(
      signedRequest(envelope("tables.list", {}, { site: { id: "0198c7a4-0000-7000-8000-000000000000" } })),
    );
    expect(response.status).toBe(403);
    expect((await readJson(response)).error.code).toBe("wrong_site");
  });

  it("answers 403 wrong_site for another company id", async () => {
    const response = await handle(
      signedRequest(envelope("tables.list", {}, { company: { id: COMPANY_ID + 1, fluid_shop: "x" } })),
    );
    expect(response.status).toBe(403);
  });

  it("answers 403 wrong_site when site or company is missing", async () => {
    const noSite = { operation: "tables.list", params: {}, company: { id: COMPANY_ID } };
    const noCompany = { operation: "tables.list", params: {}, site: { id: SITE_ID } };
    expect((await handle(signedRequest(noSite))).status).toBe(403);
    expect((await handle(signedRequest(noCompany))).status).toBe(403);
  });

  it("does not coerce the company id", async () => {
    const response = await handle(
      signedRequest(envelope("tables.list", {}, { company: { id: String(COMPANY_ID) } })),
    );
    expect(response.status).toBe(403);
  });

  it("runs no statement for a request to another site", async () => {
    const { db, transactions } = recordingDb();
    await handlerFor(db)(
      signedRequest(envelope("tables.list", {}, { site: { id: "other" } })),
    );
    expect(transactions).toEqual([]);
  });
});

describe("configuration", () => {
  it.each(Object.keys(env))("answers 500 not_configured without %s, naming nothing", async (name) => {
    const partial = { ...env, [name]: undefined };
    const response = await makeHandler(pg, partial)(signedRequest(envelope("tables.list")));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "not_configured" } });
    expect(text).not.toContain(name);
  });

  it("answers 500 not_configured for a malformed company id", async () => {
    const response = await makeHandler(pg, { ...env, FLUID_COMPANY_ID: "abc" })(
      signedRequest(envelope("tables.list")),
    );
    expect(response.status).toBe(500);
  });

  it("still answers 401 to non-POST when not configured", async () => {
    const response = await makeHandler(pg, {})(signedRequest({}, { method: "GET" }));
    expect(response.status).toBe(401);
  });
});

describe("request shape and error bodies", () => {
  it("answers 404 unknown_operation after the signature verifies", async () => {
    const { status, body } = await call(handle, "rows.explode");
    expect(status).toBe(404);
    expect(body.error.code).toBe("unknown_operation");
  });

  it("does not resolve operations through the prototype chain", async () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const { status, body } = await call(handle, name);
      expect(status, name).toBe(404);
      expect(body.error.code).toBe("unknown_operation");
    }
  });

  it("answers an unsigned unknown operation 401, not 404", async () => {
    const response = await handle(signedRequest(envelope("rows.explode"), { secret: "other" }));
    expect(response.status).toBe(401);
  });

  it("answers 400 invalid_request for a body that is not JSON, not an object, or has no operation", async () => {
    for (const raw of ["not json", "[1]", '"x"', "null"]) {
      const response = await handle(signedRequest(raw));
      expect(response.status, raw).toBe(400);
      expect((await readJson(response)).error.code).toBe("invalid_request");
    }
    const noOperation = await handle(signedRequest({ company: { id: COMPANY_ID }, site: { id: SITE_ID } }));
    expect(noOperation.status).toBe(400);
    expect((await readJson(noOperation)).error.code).toBe("invalid_request");
  });

  it("answers 400 invalid_request when params is not an object", async () => {
    const response = await handle(signedRequest(envelope("tables.list", [1])));
    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("invalid_request");
  });

  it("treats missing params as an empty object", async () => {
    const { operation, company, member, site } = envelope("tables.list");
    const response = await handle(signedRequest({ operation, company, member, site }));
    expect(response.status).toBe(200);
  });

  it("carries code, message and details on every error from an operation", async () => {
    const { body } = await call(handle, "rows.list", { table: "ghosts" });
    expect(body.error).toEqual({
      code: "table_not_found",
      message: expect.any(String),
      details: expect.any(Object),
    });
  });

  it("sends JSON with no-store", async () => {
    const response = await handle(signedRequest(envelope("tables.list")));
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("statement timeout", () => {
  it("sets a 3 second timeout first, in the transaction, for every operation", async () => {
    await seed(1);
    const { db, transactions } = recordingDb();
    const handler = handlerFor(db);
    const operations: [string, unknown][] = [
      ["tables.list", {}],
      ["sql.run", { statement: "create table timed (id int)" }],
      ["rows.list", { table: "notes" }],
      ["rows.insert", { table: "notes", rows: [{ title: "new" }] }],
      ["rows.update", { table: "notes", id: 1, values: { rank: 5 } }],
      ["rows.delete", { table: "notes", id: 1 }],
    ];
    for (const [operation, params] of operations) {
      transactions.length = 0;
      const { status } = await call(handler, operation, params);
      expect(status, operation).toBe(200);
      expect(transactions.length).toBeGreaterThan(0);
      for (const statements of transactions) {
        expect(statements[0]?.text, operation).toBe("SET LOCAL statement_timeout = 3000");
        expect(statements.length, operation).toBeGreaterThan(1);
      }
    }
  });

  it("answers 422 statement_timeout for SQLSTATE 57014", async () => {
    const error = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    for (const [operation, params] of [
      ["tables.list", {}],
      ["sql.run", { statement: "create table x (id int)" }],
      ["rows.list", { table: "notes" }],
    ] as const) {
      const { status, body } = await call(handlerFor(failingDb(error)), operation, params);
      expect(status, operation).toBe(422);
      expect(body.error.code).toBe("statement_timeout");
    }
  });
});

describe("tables.list", () => {
  it("lists tables and columns in order, with primary keys", async () => {
    await pg.exec("CREATE TABLE a_first (x integer NOT NULL, y text DEFAULT 'hi')");
    const { status, body } = await call(handle, "tables.list");
    expect(status).toBe(200);
    expect(body.tables.map((t: { name: string }) => t.name)).toEqual(["a_first", "notes"]);
    expect(body.tables[0].columns).toEqual([
      { name: "x", type: "integer", nullable: false, default: null, primary_key: false },
      { name: "y", type: "text", nullable: true, default: "'hi'::text", primary_key: false },
    ]);
    expect(body.tables[1].columns.map((c: { name: string }) => c.name)).toEqual([
      "id", "title", "body", "rank", "pinned",
    ]);
    expect(body.tables[1].columns.map((c: { primary_key: boolean }) => c.primary_key)).toEqual([
      true, false, false, false, false,
    ]);
  });

  it("marks every column of a composite primary key", async () => {
    await pg.exec("CREATE TABLE pairs (a int, b int, c int, PRIMARY KEY (a, b))");
    const { body } = await call(handle, "tables.list");
    const pairs = body.tables.find((t: { name: string }) => t.name === "pairs");
    expect(pairs.columns.map((c: { primary_key: boolean }) => c.primary_key)).toEqual([true, true, false]);
  });

  it("returns an empty list for an empty schema", async () => {
    await resetDatabase(pg);
    expect(await call(handle, "tables.list")).toEqual({ status: 200, body: { tables: [] } });
  });

  it("lists only the public schema's tables", async () => {
    await pg.exec("CREATE SCHEMA other; CREATE TABLE other.hidden (id integer PRIMARY KEY)");
    await pg.exec("CREATE VIEW note_titles AS SELECT title FROM notes");
    const { body } = await call(handle, "tables.list");
    expect(body.tables.map((t: { name: string }) => t.name)).toEqual(["notes"]);
  });
});

describe("sql.run", () => {
  it("runs a schema change and returns the plan's result shape", async () => {
    expect(await call(handle, "sql.run", { statement: "  CREATE TABLE tags (id serial PRIMARY KEY);  " })).toEqual({
      status: 200,
      body: { command: "CREATE TABLE", row_count: 0, rows: [], truncated: false },
    });
    expect((await call(handle, "sql.run", { statement: "alter table tags add column label text" })).body.command).toBe("ALTER TABLE");
    expect((await call(handle, "sql.run", { statement: "comment on table tags is 'labels'" })).body.command).toBe("COMMENT");
    expect((await call(handle, "sql.run", { statement: "DROP TABLE tags" })).body.command).toBe("DROP TABLE");
    const { rows } = await pg.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'tags'");
    expect(rows).toHaveLength(0);
  });

  it("returns at most 100 rows and sets truncated beyond", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({ n: i }));
    const db: Db = { transaction: async (s) => [...s.map(() => ({ rows: [], rowCount: 0 })).slice(0, -1), { rows, rowCount: 150 }] };
    const { status, body } = await call(handlerFor(db), "sql.run", { statement: "create table t (a int)" });
    expect(status).toBe(200);
    expect(body.rows).toHaveLength(100);
    expect(body.row_count).toBe(150);
    expect(body.truncated).toBe(true);
  });

  it.each([
    ["multiple statements", "create table a (id int); create table b (id int)"],
    ["a semicolon in the middle", "create table a (id int);;"],
    ["a select", "select * from notes"],
    ["a grant", "grant all on notes to public"],
    ["an insert", "insert into notes (title) values ('x')"],
    ["a delete", "DELETE FROM notes"],
    ["an empty statement", "   ;  "],
    ["a keyword prefix", "createx table a (id int)"],
    ["a leading comment", "/* hi */ create table a (id int)"],
  ])("refuses %s with 422 invalid_statement", async (_name, statement) => {
    const { status, body } = await call(handle, "sql.run", { statement });
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_statement");
  });

  it("runs no part of a refused statement", async () => {
    const { db, transactions } = recordingDb();
    await call(handlerFor(db), "sql.run", { statement: "create table a (id int); drop table notes" });
    expect(transactions).toEqual([]);
    const { body } = await call(handle, "tables.list");
    expect(body.tables.map((t: { name: string }) => t.name)).toEqual(["notes"]);
  });

  it("requires a string statement", async () => {
    const { status, body } = await call(handle, "sql.run", { statement: 5 });
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_params");
  });

  it("answers 422 invalid_statement for a syntax error and for a failing statement", async () => {
    const syntax = await call(handle, "sql.run", { statement: "create tabel x (id int)" });
    expect(syntax.status).toBe(422);
    expect(syntax.body.error.code).toBe("invalid_statement");
    const duplicate = await call(handle, "sql.run", { statement: "create table notes (id int)" });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.error.code).toBe("invalid_statement");
    expect(duplicate.body.error.message).toContain("notes");
  });

  it("answers 404 table_not_found when the statement names a missing table", async () => {
    const { status, body } = await call(handle, "sql.run", { statement: "alter table ghosts add column a int" });
    expect(status).toBe(404);
    expect(body.error.code).toBe("table_not_found");
  });

  it("rolls back when the statement fails", async () => {
    await call(handle, "sql.run", { statement: "alter table notes add column nope nonexistent_type" });
    const { body } = await call(handle, "tables.list");
    expect(body.tables[0].columns.map((c: { name: string }) => c.name)).not.toContain("nope");
  });
});

describe("sql.run schema forms", () => {
  const tables = async () =>
    (await pg.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1"))
      .rows.map((r) => (r as { table_name: string }).table_name);
  const indexes = async () =>
    (await pg.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1"))
      .rows.map((r) => (r as { indexname: string }).indexname);
  const run = (statement: string) => call(handle, "sql.run", { statement });

  beforeEach(async () => {
    await pg.exec("CREATE TABLE u (c integer, d text); INSERT INTO u VALUES (1, 'a'), (2, 'b')");
    await pg.exec("CREATE TABLE t (c integer PRIMARY KEY, d text)");
  });

  it.each([
    ["CREATE TABLE", "create table made (id serial PRIMARY KEY, name text NOT NULL DEFAULT 'x', n numeric(10,2), at timestamp with time zone)"],
    ["CREATE TABLE", "CREATE TABLE IF NOT EXISTS public.made2 (id int, ref int REFERENCES t(c) ON DELETE CASCADE ON UPDATE SET NULL, CHECK (id > 0))"],
    ["CREATE TABLE", 'create table "quoted" (id int)'],
    ["CREATE TABLE", "create table child (id int) inherits (t)"],
    ["CREATE INDEX", "create index idx_d on t (d)"],
    ["CREATE INDEX", "CREATE UNIQUE INDEX IF NOT EXISTS idx_d2 ON public.t (lower(d), c)"],
    ["ALTER TABLE", "alter table t add column e text"],
    ["ALTER TABLE", "alter table if exists public.t add column if not exists f integer NOT NULL DEFAULT 0"],
    ["ALTER TABLE", "alter table t drop column d cascade"],
    ["ALTER TABLE", "alter table u rename column d to e"],
    ["ALTER TABLE", "alter table u rename to u2"],
    ["ALTER TABLE", "alter table u add constraint u_c_check check (c > 0)"],
    ["ALTER TABLE", "alter table u add constraint u_c_fk foreign key (c) references t (c) not valid"],
    ["ALTER TABLE", "alter table u add constraint u_c_uq unique (c)"],
    ["ALTER TABLE", "alter table u add constraint u_c_pk primary key (c)"],
    ["ALTER TABLE", "alter table u drop constraint if exists nope"],
    ["ALTER TABLE", "alter table u alter column c set default 5"],
    ["ALTER TABLE", "alter table u alter column c drop default"],
    ["ALTER TABLE", "alter table u alter column c set not null"],
    ["ALTER TABLE", "alter table u alter column c drop not null"],
    ["ALTER TABLE", "alter table u alter column c type bigint"],
    ["ALTER TABLE", "alter table u alter column c set data type numeric"],
    ["DROP TABLE", "drop table if exists u cascade"],
    ["DROP TABLE", "DROP TABLE public.u"],
    ["COMMENT", "comment on table t is 'tee'"],
    ["COMMENT", "comment on column t.d is 'dee'"],
    ["COMMENT", "comment on column public.t.d is null"],
  ])("allows %s: %s", async (tag, statement) => {
    const { status, body } = await run(statement);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.command).toBe(tag);
  });

  it("allows DROP INDEX", async () => {
    await pg.exec("CREATE INDEX idx_d ON t (d)");
    for (const statement of ["drop index idx_d", "drop index if exists idx_d cascade"]) {
      const { status, body } = await run(statement);
      expect(status).toBe(200);
      expect(body.command).toBe("DROP INDEX");
    }
  });

  it.each([
    "create table copy as select * from u",
    "create table copy as (select 1)",
    "create table copy as values (1)",
    "create table copy as table u",
    "create table copy as with x as (select 1) select * from x",
    "CREATE TABLE copy AS SELECT * FROM u",
    "create table copy (like u including all)",
    "create table copy (a int, like u)",
    "create table copy (a int generated always as (a + 1) stored)",
    "create temp table copy (a int)",
    "create unlogged table copy (a int)",
    "create table copy partition of u for values from (1) to (2)",
    "select into copy from u",
  ])("refuses %j and creates nothing", async (statement) => {
    const before = await tables();
    const { status, body } = await run(statement);
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_statement");
    expect(await tables()).toEqual(before);
  });

  it.each([
    "create view v as select * from u",
    "create or replace view v as select 1",
    "create temp view v as select 1",
    "create materialized view m as select * from u",
    "create function f() returns int language sql as 'select 1'",
    "create or replace function f() returns int language sql as 'x'",
    "create procedure p() language sql as 'x'",
    "create trigger tr before insert on u for each row execute function f()",
    "create rule r as on insert to u do nothing",
    "create extension pgcrypto",
    "create schema s",
    "create role r",
    "create policy p on u using (true)",
    "create sequence sq",
    "create type ty as enum ('a')",
    "create domain dm as integer",
  ])("refuses %j", async (statement) => {
    const { status, body } = await run(statement);
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_statement");
    const { rows } = await pg.query("SELECT relname FROM pg_class WHERE relname IN ('v', 'm', 'sq')");
    expect(rows).toEqual([]);
  });

  it.each([
    "create index concurrently i on t (d)",
    "create index concurrently on t (d)",
    "create unique index concurrently if not exists i on t (d)",
    "create index i on t using hash (d)",
    "create index i on t (d) where d = (select 'a')",
    "create index i on t (d) with (fillfactor = 70)",
    "create index on t (d)",
  ])("refuses %j and creates no index", async (statement) => {
    const before = await indexes();
    const { status, body } = await run(statement);
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_statement");
    expect(await indexes()).toEqual(before);
  });

  it("refuses ALTER TABLE ... TYPE ... USING and leaves the column alone", async () => {
    const { status, body } = await run("alter table u alter column c type int using c::int");
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_statement");
    expect(body.error.message).toContain("using");
    const { rows } = await pg.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'u' AND column_name = 'c'");
    expect(rows).toEqual([{ data_type: "integer" }]);
  });

  it.each([
    "alter table u add column e int, add column f int",
    "alter table u add primary key (c)",
    "alter table u add e int",
    "alter table u alter column c set statistics 100",
    "alter table u enable row level security",
    "alter table u owner to someone",
    "alter table u set schema other",
    "alter table u alter column c set default (select 1)",
    "alter table u add column e int default (select 1)",
    "alter table u add constraint x check (c in (select 1))",
    "alter table u drop column",
    "alter index i rename to j",
    "alter role r superuser",
    "alter system set work_mem = 1",
    "drop table u, t",
    "drop index concurrently i",
    "drop view v",
    "drop schema public cascade",
    "drop function f",
    "drop owned by someone",
    "comment on view v is 'x'",
    "comment on function f is 'x'",
    "comment on table u is 'it''s a select'",
  ])("refuses %j", async (statement) => {
    const { status, body } = await run(statement);
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_statement");
    expect(await tables()).toEqual(["t", "u", "notes"].sort());
  });

  it.each([
    "select 1", "insert into u values (3, 'c')", "update u set d = 'z'", "delete from u", "merge into u using t on true when matched then delete",
    "copy u to stdout", "with x as (select 1) select * from x", "do $$ begin end $$", "truncate u", "vacuum u", "reindex table u", "cluster u",
    "refresh materialized view m", "grant all on u to public", "revoke all on u from public", "explain select 1", "set role x", "begin", "commit",
  ])("refuses the non-schema statement %j", async (statement) => {
    const { status, body } = await run(statement);
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_statement");
    expect((await pg.query("SELECT count(*)::int AS n FROM u")).rows[0]).toEqual({ n: 2 });
  });

  it.each([
    ["a line comment", "create table x (id int) -- hi"],
    ["a block comment", "create table x (id /* hi */ int)"],
    ["dollar quoting", "comment on table u is $$hi$$"],
    ["a tagged dollar quote", "comment on table u is $q$hi$q$"],
    ["a semicolon", "create table x (id int); create table y (id int)"],
  ])("refuses %s", async (_name, statement) => {
    const { status, body } = await run(statement);
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_statement");
  });

  it("over-refuses forbidden words inside string literals", async () => {
    for (const statement of [
      "comment on table u is 'select the best'",
      "create table x (note text DEFAULT 'update')",
    ]) {
      expect((await run(statement)).status, statement).toBe(422);
    }
  });

  it("does not refuse names that merely contain a forbidden word", async () => {
    const { status } = await run("create table updates_log (selected int, with_user int, do_it int, using_x int)");
    expect(status).toBe(200);
  });

  it("refuses before running anything: no transaction is opened", async () => {
    const { db, transactions } = recordingDb();
    for (const statement of ["create table x as select 1", "create view v as select 1", "select 1"]) {
      await call(handlerFor(db), "sql.run", { statement });
    }
    expect(transactions).toEqual([]);
  });
});

describe("identifiers and the catalog", () => {
  it.each(["notes; drop", "no-tes", "1notes", "", "a".repeat(64), "no tes", 'no"tes', 5, null])(
    "refuses table %j with 422 invalid_params and runs no statement",
    async (table) => {
      for (const [operation, params] of [
        ["rows.list", { table }],
        ["rows.insert", { table, rows: [{ title: "x" }] }],
        ["rows.update", { table, id: 1, values: { title: "x" } }],
        ["rows.delete", { table, id: 1 }],
      ] as const) {
        const { db, transactions } = recordingDb();
        const { status, body } = await call(handlerFor(db), operation, params);
        expect(status, operation).toBe(422);
        expect(body.error.code).toBe("invalid_params");
        expect(body.error.message).toContain("table");
        expect(transactions, operation).toEqual([]);
      }
    },
  );

  it("answers 404 table_not_found for a table that is not in the catalog, after one catalog query only", async () => {
    for (const [operation, params] of [
      ["rows.list", { table: "ghosts" }],
      ["rows.insert", { table: "ghosts", rows: [{ a: 1 }] }],
      ["rows.update", { table: "ghosts", id: 1, values: { a: 1 } }],
      ["rows.delete", { table: "ghosts", id: 1 }],
    ] as const) {
      const { db, statements } = recordingDb();
      const { status, body } = await call(handlerFor(db), operation, params);
      expect(status, operation).toBe(404);
      expect(body.error.code).toBe("table_not_found");
      expect(statements(), operation).toHaveLength(2);
      expect(statements()[1], operation).toContain("information_schema");
    }
  });

  it("resolves names case-sensitively against the catalog and quotes what it finds", async () => {
    await pg.exec('CREATE TABLE "Mixed" (id serial PRIMARY KEY, "Title" text)');
    const insert = await call(handle, "rows.insert", { table: "Mixed", rows: [{ Title: "hi" }] });
    expect(insert.status).toBe(200);
    expect(insert.body.rows).toEqual([{ id: 1, Title: "hi" }]);
    expect((await call(handle, "rows.list", { table: "mixed" })).status).toBe(404);
    expect((await call(handle, "rows.list", { table: "Mixed", filters: [{ column: "title", op: "eq", value: "hi" }] })).status).toBe(422);
  });

  it("accepts the longest identifier, 63 characters", async () => {
    const name = "t".repeat(63);
    await pg.exec(`CREATE TABLE "${name}" (id serial PRIMARY KEY)`);
    expect((await call(handle, "rows.list", { table: name })).status).toBe(200);
  });

  it("answers 422 invalid_params, naming the field, for a column that is not in the catalog", async () => {
    const cases = [
      ["rows.list", { table: "notes", filters: [{ column: "nope", op: "eq", value: 1 }] }, "filters[0].column"],
      ["rows.list", { table: "notes", filters: [{ column: "ti; x", op: "eq", value: 1 }] }, "filters[0].column"],
      ["rows.list", { table: "notes", sort: [{ column: "nope" }] }, "sort[0].column"],
      ["rows.insert", { table: "notes", rows: [{ "bad col": 1 }] }, "rows[0]"],
      ["rows.insert", { table: "notes", rows: [{ nope: 1 }] }, "rows[0].nope"],
      ["rows.update", { table: "notes", id: 1, values: { 'x"y': 1 } }, "values."],
      ["rows.update", { table: "notes", id: 1, values: { nope: 1 } }, "values.nope"],
    ] as const;
    for (const [operation, params, field] of cases) {
      const { db, statements } = recordingDb();
      const { status, body } = await call(handlerFor(db), operation, params);
      expect(status, operation).toBe(422);
      expect(body.error.code).toBe("invalid_params");
      expect(body.error.message).toContain(field);
      // The SET LOCAL and the catalog query ran; no statement touched a row.
      expect(statements().filter((t) => /^(SELECT \*|INSERT|UPDATE|DELETE)/.test(t))).toEqual([]);
    }
  });

  it("does not execute injected SQL", async () => {
    await seed(1);
    await call(handle, "rows.list", { table: "notes; drop table notes" });
    await call(handle, "rows.list", {
      table: "notes",
      filters: [{ column: "title", op: "eq", value: "x' OR 1=1; DROP TABLE notes; --" }],
    });
    const { body } = await call(handle, "rows.list", { table: "notes" });
    expect(body.rows).toHaveLength(1);
  });

  it("only reaches the public schema", async () => {
    await pg.exec("CREATE SCHEMA other; CREATE TABLE other.secret (id serial PRIMARY KEY)");
    const { status, body } = await call(handle, "rows.list", { table: "secret" });
    expect(status).toBe(404);
    expect(body.error.code).toBe("table_not_found");
  });

  it("does not list views as tables", async () => {
    await pg.exec("CREATE VIEW note_titles AS SELECT title FROM notes");
    expect((await call(handle, "rows.list", { table: "note_titles" })).status).toBe(404);
  });
});

describe("rows.list", () => {
  beforeEach(async () => {
    await pg.exec(`
      INSERT INTO notes (title, body, rank, pinned) VALUES
        ('alpha', 'first', 1, true),
        ('Bravo', NULL, 2, false),
        ('charlie', 'third', 3, false),
        ('delta', 'fourth', 4, true),
        ('echo', NULL, NULL, false);
    `);
  });

  const titles = (body: Json) => body.rows.map((r: { title: string }) => r.title);
  const list = (extra: object) => call(handle, "rows.list", { table: "notes", sort: [{ column: "id" }], ...extra });
  const f = (column: string, op: string, value: unknown) => ({ column, op, value });

  it("returns all rows with a null cursor when everything fits", async () => {
    const { status, body } = await list({});
    expect(status).toBe(200);
    expect(titles(body)).toEqual(["alpha", "Bravo", "charlie", "delta", "echo"]);
    expect(body.next_cursor).toBeNull();
  });

  it.each([
    [[f("title", "eq", "alpha")], ["alpha"]],
    [[f("pinned", "eq", true)], ["alpha", "delta"]],
    [[f("rank", "neq", 2)], ["alpha", "charlie", "delta"]],
    [[f("rank", "lt", 3)], ["alpha", "Bravo"]],
    [[f("rank", "lte", 3)], ["alpha", "Bravo", "charlie"]],
    [[f("rank", "gt", 3)], ["delta"]],
    [[f("rank", "gte", 3)], ["charlie", "delta"]],
    [[f("rank", "gte", 2), f("rank", "lt", 4)], ["Bravo", "charlie"]],
    [[f("title", "in", ["alpha", "echo", "zulu"])], ["alpha", "echo"]],
    [[f("rank", "in", [1, 4])], ["alpha", "delta"]],
    [[f("body", "is_null", true)], ["Bravo", "echo"]],
    [[f("body", "is_null", false)], ["alpha", "charlie", "delta"]],
    [[f("body", "eq", null)], ["Bravo", "echo"]],
    [[f("body", "neq", null)], ["alpha", "charlie", "delta"]],
    [[f("pinned", "eq", false), f("rank", "gt", 1)], ["Bravo", "charlie"]],
  ])("filters %j", async (filters, expected) => {
    const { status, body } = await list({ filters });
    expect(status).toBe(200);
    expect(titles(body)).toEqual(expected);
  });

  it("binds filter values rather than interpolating them", async () => {
    const { status, body } = await list({ filters: [f("title", "eq", "alpha' OR '1'='1")] });
    expect(status).toBe(200);
    expect(body.rows).toEqual([]);
  });

  it("orders by several columns, defaulting to ascending", async () => {
    const { body } = await call(handle, "rows.list", {
      table: "notes",
      sort: [{ column: "pinned", direction: "desc" }, { column: "rank", direction: "desc" }],
    });
    expect(titles(body)).toEqual(["delta", "alpha", "echo", "charlie", "Bravo"]);
    const asc = await call(handle, "rows.list", { table: "notes", sort: [{ column: "rank" }] });
    expect(titles(asc.body)).toEqual(["alpha", "Bravo", "charlie", "delta", "echo"]);
  });

  it("ends the order with the primary key, so equal sort values keep a stable order", async () => {
    const { db, statements } = recordingDb();
    await call(handlerFor(db), "rows.list", { table: "notes", sort: [{ column: "pinned", direction: "desc" }] });
    expect(statements().find((t) => t.startsWith("SELECT *"))).toContain('ORDER BY "pinned" DESC, "id"');
    const unsorted = recordingDb();
    await call(handlerFor(unsorted.db), "rows.list", { table: "notes" });
    expect(unsorted.statements().find((t) => t.startsWith("SELECT *"))).toContain('ORDER BY "id"');
  });

  it.each([
    [{ filters: [f("rank", "like", "%a")] }, "filters[0].op"],
    [{ filters: [f("rank", "ilike", "%a")] }, "filters[0].op"],
    [{ filters: [f("rank", "between", [1, 2])] }, "filters[0].op"],
    [{ filters: [{ column: "rank", value: 1 }] }, "filters[0].op"],
    [{ filters: { rank: 1 } }, "filters"],
    [{ filters: ["rank"] }, "filters[0]"],
    [{ filters: [{ op: "eq", value: 1 }] }, "filters[0].column"],
    [{ filters: [f("rank", "in", [])] }, "filters[0].value"],
    [{ filters: [f("rank", "in", Array.from({ length: 101 }, (_, i) => i))] }, "filters[0].value"],
    [{ filters: [f("rank", "in", [1, null])] }, "filters[0].value"],
    [{ filters: [f("rank", "in", 5)] }, "filters[0].value"],
    [{ filters: [f("rank", "is_null", "yes")] }, "filters[0].value"],
    [{ filters: [f("rank", "gt", null)] }, "filters[0].value"],
    [{ filters: [f("rank", "gt", [1])] }, "filters[0].value"],
    [{ filters: [f("rank", "eq", { a: 1 })] }, "filters[0].value"],
    [{ sort: [{ column: "rank", direction: "up" }] }, "sort[0].direction"],
    [{ sort: "rank" }, "sort"],
    [{ sort: [{ direction: "asc" }] }, "sort[0].column"],
    [{ limit: 0 }, "limit"],
    [{ limit: -1 }, "limit"],
    [{ limit: 101 }, "limit"],
    [{ limit: 1.5 }, "limit"],
    [{ limit: "5" }, "limit"],
  ])("answers 422 invalid_params for %j", async (extra, field) => {
    const { status, body } = await list(extra);
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_params");
    expect(body.error.message).toContain(field);
  });

  it("accepts exactly 100 values in `in` and a limit of 100", async () => {
    const { status } = await list({ filters: [f("rank", "in", Array.from({ length: 100 }, (_, i) => i))], limit: 100 });
    expect(status).toBe(200);
  });

  it("serializes bigint columns as strings", async () => {
    await pg.exec("CREATE TABLE big (id serial PRIMARY KEY, n bigint); INSERT INTO big (n) VALUES (9007199254740993)");
    const { body } = await call(handle, "rows.list", { table: "big" });
    expect(body.rows[0].n).toBe("9007199254740993");
  });

  it("lists a table that has no primary key", async () => {
    await pg.exec("CREATE TABLE loose (name text); INSERT INTO loose VALUES ('a')");
    const { status, body } = await call(handle, "rows.list", { table: "loose" });
    expect(status).toBe(200);
    expect(body.rows).toEqual([{ name: "a" }]);
  });

  describe("paging", () => {
    beforeEach(async () => {
      await resetDatabase(pg);
      await pg.exec("CREATE TABLE notes (id serial PRIMARY KEY, title text NOT NULL UNIQUE, body text, rank integer, pinned boolean)");
      await seed(130);
    });

    it("defaults the limit to 25", async () => {
      const { body } = await list({});
      expect(body.rows).toHaveLength(25);
      expect(typeof body.next_cursor).toBe("string");
    });

    it("returns 100 rows at the maximum limit", async () => {
      const { status, body } = await list({ limit: MAX_LIMIT });
      expect(status).toBe(200);
      expect(body.rows).toHaveLength(MAX_LIMIT);
      expect(body.next_cursor).not.toBeNull();
    });

    it("pages through every row exactly once with an opaque cursor", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const { body }: { body: Json } = await list({ limit: 40, ...(cursor ? { cursor } : {}) });
        seen.push(...titles(body));
        cursor = body.next_cursor;
        pages += 1;
        if (cursor) expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      } while (cursor);
      expect(pages).toBe(4);
      expect(seen).toHaveLength(130);
      expect(new Set(seen).size).toBe(130);
      expect(seen).toEqual([...seen].sort());
    });

    it("returns a null cursor on an exactly-full last page", async () => {
      const first = await list({ limit: 65 });
      const second = await list({ limit: 65, cursor: first.body.next_cursor });
      expect(second.body.rows).toHaveLength(65);
      expect(second.body.next_cursor).toBeNull();
    });

    it("refuses a cursor the template did not issue with 422 invalid_cursor", async () => {
      const first = await list({ limit: 10 });
      const issued: string = first.body.next_cursor;
      const forged = [
        "bogus",
        "",
        "!!",
        Buffer.from("5000").toString("base64url"),
        Buffer.from(`10.${"0".repeat(16)}.${"0".repeat(64)}`).toString("base64url"),
        `${issued.slice(0, -2)}AA`,
        7,
        null,
        {},
      ];
      for (const cursor of forged) {
        const { status, body } = await list({ cursor });
        expect(status, String(cursor)).toBe(422);
        expect(body.error.code).toBe("invalid_cursor");
      }
    });

    it("refuses a cursor issued for another query or under another secret", async () => {
      const first = await list({ limit: 10 });
      const otherFilter = await list({ limit: 10, filters: [f("rank", "gte", 0)], cursor: first.body.next_cursor });
      expect(otherFilter.status).toBe(422);
      expect(otherFilter.body.error.code).toBe("invalid_cursor");
      const otherSort = await list({ limit: 10, sort: [{ column: "rank", direction: "desc" }], cursor: first.body.next_cursor });
      expect(otherSort.body.error.code).toBe("invalid_cursor");
      const elsewhere = await makeHandler(pg, { ...env, FLUID_SIGNING_SECRET: "another_secret" })(
        signedRequest(envelope("rows.list", { table: "notes", sort: [{ column: "id" }], cursor: first.body.next_cursor }), { secret: "another_secret" }),
      );
      expect(elsewhere.status).toBe(422);
      expect((await readJson(elsewhere)).error.code).toBe("invalid_cursor");
    });

    it("accepts a cursor with a different limit", async () => {
      const first = await list({ limit: 10 });
      const next = await list({ limit: 20, cursor: first.body.next_cursor });
      expect(next.status).toBe(200);
      expect(titles(next.body)[0]).toBe("note 010");
    });
  });

  describe("byte budget", () => {
    const rowBytes = 20 * 1024;

    beforeEach(async () => {
      await pg.exec("CREATE TABLE blobs (id serial PRIMARY KEY, data text)");
      await pg.exec(`INSERT INTO blobs (data) SELECT repeat('x', ${rowBytes}) FROM generate_series(1, 30)`);
    });

    it("ends a page before 192 KiB of serialized rows and returns a cursor for the rest", async () => {
      const { status, body } = await call(handle, "rows.list", { table: "blobs", limit: 100 });
      expect(status).toBe(200);
      const size = Buffer.byteLength(JSON.stringify(body.rows));
      expect(size).toBeLessThanOrEqual(PAGE_BYTE_BUDGET);
      expect(body.rows.length).toBe(Math.floor(PAGE_BYTE_BUDGET / (rowBytes + 40)));
      expect(body.rows.length).toBeLessThan(30);
      expect(body.next_cursor).not.toBeNull();
    });

    it("pages through every row across budget-limited pages", async () => {
      const ids: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const { body }: { body: Json } = await call(handle, "rows.list", { table: "blobs", limit: 100, ...(cursor ? { cursor } : {}) });
        ids.push(...body.rows.map((r: { id: number }) => r.id));
        cursor = body.next_cursor;
        pages += 1;
      } while (cursor);
      expect(pages).toBeGreaterThan(1);
      expect(ids).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    });

    it("answers 422 row_too_large when one row is larger than the budget", async () => {
      await pg.exec(`INSERT INTO blobs (data) VALUES (repeat('y', ${PAGE_BYTE_BUDGET + 1}))`);
      const { status, body } = await call(handle, "rows.list", {
        table: "blobs",
        sort: [{ column: "id", direction: "desc" }],
        limit: 5,
      });
      expect(status).toBe(422);
      expect(body.error.code).toBe("row_too_large");
    });
  });
});

describe("rows.insert", () => {
  it("inserts one row and returns it", async () => {
    const { status, body } = await call(handle, "rows.insert", {
      table: "notes",
      rows: [{ title: "hello", body: "world", rank: 3, pinned: true }],
    });
    expect(status).toBe(200);
    expect(body.rows).toEqual([{ id: 1, title: "hello", body: "world", rank: 3, pinned: true }]);
  });

  it("inserts several rows in one statement", async () => {
    const { db, statements } = recordingDb();
    const { body } = await call(handlerFor(db), "rows.insert", {
      table: "notes",
      rows: [{ title: "a", rank: 1 }, { title: "b", rank: 2 }, { title: "c", rank: null }],
    });
    expect(body.rows.map((r: { title: string }) => r.title)).toEqual(["a", "b", "c"]);
    expect(body.rows[2].rank).toBeNull();
    expect(statements().filter((t) => t.startsWith("INSERT"))).toHaveLength(1);
  });

  it("writes JSON values into jsonb columns", async () => {
    await pg.exec("CREATE TABLE docs (id serial PRIMARY KEY, data jsonb)");
    const { status, body } = await call(handle, "rows.insert", {
      table: "docs",
      rows: [{ data: { a: [1, 2], b: null } }, { data: [1, "two"] }],
    });
    expect(status).toBe(200);
    expect(body.rows.map((r: { data: unknown }) => r.data)).toEqual([{ a: [1, 2], b: null }, [1, "two"]]);
  });

  it("inserts nothing when one row fails", async () => {
    const { status } = await call(handle, "rows.insert", {
      table: "notes",
      rows: [{ title: "a" }, { title: "a" }],
    });
    expect(status).toBe(409);
    expect((await pg.query("SELECT count(*)::int AS n FROM notes")).rows[0]).toEqual({ n: 0 });
  });

  it.each([
    [{ rows: [] }, "rows"],
    [{ rows: "x" }, "rows"],
    [{ rows: Array.from({ length: 101 }, (_, i) => ({ title: `t${i}` })) }, "rows"],
    [{ rows: ["x"] }, "rows[0]"],
    [{ rows: [{}] }, "rows[0]"],
    [{ rows: [{ title: "a" }, { title: "b", rank: 1 }] }, "rows[1]"],
    [{ rows: [{ title: "a", rank: 1 }, { title: "b", body: "x" }] }, "rows[1]"],
  ])("answers 422 invalid_params for %j", async (extra, field) => {
    const { status, body } = await call(handle, "rows.insert", { table: "notes", ...extra });
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_params");
    expect(body.error.message).toContain(field);
  });

  it("accepts exactly 100 rows", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ title: `t${i}` }));
    const { status, body } = await call(handle, "rows.insert", { table: "notes", rows });
    expect(status).toBe(200);
    expect(body.rows).toHaveLength(100);
  });

  it("answers 409 conflict for a unique violation", async () => {
    await call(handle, "rows.insert", { table: "notes", rows: [{ title: "dup" }] });
    const { status, body } = await call(handle, "rows.insert", { table: "notes", rows: [{ title: "dup" }] });
    expect(status).toBe(409);
    expect(body.error.code).toBe("conflict");
    expect(body.error.message).toContain("duplicate key");
    expect(body.error.details.sqlstate).toBe("23505");
  });

  it("answers 409 conflict for a foreign key violation", async () => {
    await pg.exec("CREATE TABLE child (id serial PRIMARY KEY, note_id integer REFERENCES notes(id))");
    const { status, body } = await call(handle, "rows.insert", { table: "child", rows: [{ note_id: 99 }] });
    expect(status).toBe(409);
    expect(body.error.code).toBe("conflict");
  });

  it("answers 422 constraint_violation for a not-null or check violation", async () => {
    const notNull = await call(handle, "rows.insert", { table: "notes", rows: [{ body: "no title" }] });
    expect(notNull.status).toBe(422);
    expect(notNull.body.error.code).toBe("constraint_violation");
    await pg.exec("CREATE TABLE checked (id serial PRIMARY KEY, n int CHECK (n > 0))");
    const check = await call(handle, "rows.insert", { table: "checked", rows: [{ n: 0 }] });
    expect(check.status).toBe(422);
    expect(check.body.error.code).toBe("constraint_violation");
  });

  it("answers 422 invalid_params for a value of the wrong type", async () => {
    const { status, body } = await call(handle, "rows.insert", { table: "notes", rows: [{ title: "x", rank: "abc" }] });
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_params");
  });
});

describe("rows.update", () => {
  beforeEach(() => seed(2));

  it("updates a row and returns it", async () => {
    const { status, body } = await call(handle, "rows.update", {
      table: "notes",
      id: 1,
      values: { title: "renamed", body: null, pinned: true },
    });
    expect(status).toBe(200);
    expect(body.row).toMatchObject({ id: 1, title: "renamed", body: null, pinned: true, rank: 0 });
    expect((await pg.query("SELECT title FROM notes WHERE id = 2")).rows[0]).toEqual({ title: "note 001" });
  });

  it("accepts a string id", async () => {
    const { status, body } = await call(handle, "rows.update", { table: "notes", id: "2", values: { rank: 9 } });
    expect(status).toBe(200);
    expect(body.row.rank).toBe(9);
  });

  it("addresses the row by a primary key of any name and type", async () => {
    await pg.exec(`
      CREATE TABLE people (person_uuid uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
      INSERT INTO people (person_uuid, name) VALUES ('0198c7a4-52f1-7b3e-9d0a-6f4e1c2b8a35', 'ann');
      CREATE TABLE slugs (slug text PRIMARY KEY, label text);
      INSERT INTO slugs VALUES ('home', 'Home');
    `);
    const byUuid = await call(handle, "rows.update", {
      table: "people",
      id: "0198c7a4-52f1-7b3e-9d0a-6f4e1c2b8a35",
      values: { name: "anna" },
    });
    expect(byUuid.body.row.name).toBe("anna");
    const bySlug = await call(handle, "rows.update", { table: "slugs", id: "home", values: { label: "Start" } });
    expect(bySlug.body.row).toEqual({ slug: "home", label: "Start" });
  });

  it("does not treat a column named id as the key when the primary key is another column", async () => {
    await pg.exec("CREATE TABLE odd (code text PRIMARY KEY, id integer); INSERT INTO odd VALUES ('a', 7), ('b', 7)");
    const { status, body } = await call(handle, "rows.update", { table: "odd", id: "a", values: { id: 8 } });
    expect(status).toBe(200);
    expect(body.row).toEqual({ code: "a", id: 8 });
  });

  it("answers 404 row_not_found for a missing key", async () => {
    const { status, body } = await call(handle, "rows.update", { table: "notes", id: 99, values: { rank: 1 } });
    expect(status).toBe(404);
    expect(body.error.code).toBe("row_not_found");
  });

  it("answers 404 table_not_found for a missing table", async () => {
    const { status, body } = await call(handle, "rows.update", { table: "ghosts", id: 1, values: { rank: 1 } });
    expect(status).toBe(404);
    expect(body.error.code).toBe("table_not_found");
  });

  it("answers 409 for a unique violation", async () => {
    const { status, body } = await call(handle, "rows.update", { table: "notes", id: 1, values: { title: "note 001" } });
    expect(status).toBe(409);
    expect(body.error.code).toBe("conflict");
  });

  it("answers 422 invalid_params when the table has no single-column primary key", async () => {
    await pg.exec("CREATE TABLE loose (name text); CREATE TABLE pairs (a int, b int, PRIMARY KEY (a, b))");
    for (const table of ["loose", "pairs"]) {
      const { status, body } = await call(handle, "rows.update", { table, id: 1, values: { [table === "loose" ? "name" : "b"]: "x" } });
      expect(status, table).toBe(422);
      expect(body.error.code).toBe("invalid_params");
      expect(body.error.message).toContain("primary key");
    }
  });

  it.each([
    [{ id: 1, values: {} }, "values"],
    [{ id: 1 }, "values"],
    [{ id: 1, values: { id: 5, title: "x" } }, "values.id"],
    [{ values: { title: "x" } }, "id"],
    [{ id: null, values: { title: "x" } }, "id"],
    [{ id: {}, values: { title: "x" } }, "id"],
    [{ id: "", values: { title: "x" } }, "id"],
  ])("answers 422 invalid_params for %j", async (extra, field) => {
    const { status, body } = await call(handle, "rows.update", { table: "notes", ...extra });
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_params");
    expect(body.error.message).toContain(field);
  });

  it("answers 422 invalid_params for a key of the wrong type", async () => {
    const { status, body } = await call(handle, "rows.update", { table: "notes", id: "abc", values: { rank: 1 } });
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_params");
  });
});

describe("rows.delete", () => {
  beforeEach(() => seed(2));

  it("deletes a row", async () => {
    expect(await call(handle, "rows.delete", { table: "notes", id: 1 })).toEqual({
      status: 200,
      body: { deleted: true },
    });
    expect((await pg.query("SELECT id FROM notes")).rows).toEqual([{ id: 2 }]);
  });

  it("deletes by a primary key of any name", async () => {
    await pg.exec("CREATE TABLE slugs (slug text PRIMARY KEY); INSERT INTO slugs VALUES ('a'), ('b')");
    expect((await call(handle, "rows.delete", { table: "slugs", id: "a" })).body).toEqual({ deleted: true });
    expect((await pg.query("SELECT slug FROM slugs")).rows).toEqual([{ slug: "b" }]);
  });

  it("answers 404 row_not_found for a missing key, and again for a repeat", async () => {
    const missing = await call(handle, "rows.delete", { table: "notes", id: 99 });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("row_not_found");
    await call(handle, "rows.delete", { table: "notes", id: 1 });
    const again = await call(handle, "rows.delete", { table: "notes", id: 1 });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("row_not_found");
  });

  it("answers 404 table_not_found for a missing table", async () => {
    const { status, body } = await call(handle, "rows.delete", { table: "ghosts", id: 1 });
    expect(status).toBe(404);
    expect(body.error.code).toBe("table_not_found");
  });

  it("answers 422 invalid_params for a missing id and for a table without a single-column key", async () => {
    const noId = await call(handle, "rows.delete", { table: "notes" });
    expect(noId.status).toBe(422);
    expect(noId.body.error.code).toBe("invalid_params");
    await pg.exec("CREATE TABLE loose (name text)");
    const loose = await call(handle, "rows.delete", { table: "loose", id: 1 });
    expect(loose.status).toBe(422);
    expect(loose.body.error.code).toBe("invalid_params");
  });

  it("answers 409 conflict for a foreign key violation", async () => {
    await pg.exec("CREATE TABLE child (id serial PRIMARY KEY, note_id integer REFERENCES notes(id))");
    await pg.exec("INSERT INTO child (note_id) VALUES (1)");
    const { status, body } = await call(handle, "rows.delete", { table: "notes", id: 1 });
    expect(status).toBe(409);
    expect(body.error.code).toBe("conflict");
  });
});

describe("database failures", () => {
  it("answers 503 database_unavailable for connection-class errors and unreachable hosts", async () => {
    const errors = [
      Object.assign(new Error("terminating connection"), { code: "57P01" }),
      Object.assign(new Error("connection failure"), { code: "08006" }),
      Object.assign(new Error("too many connections"), { code: "53300" }),
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      new TypeError("fetch failed"),
    ];
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const error of errors) {
      const { status, body } = await call(handlerFor(failingDb(error)), "tables.list");
      expect(status).toBe(503);
      expect(body.error.code).toBe("database_unavailable");
    }
    log.mockRestore();
  });

  it("answers 500 internal_error without leaking the raw message, and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secretMessage = "boom at db.internal.example password=hunter2";
    for (const error of [new Error(secretMessage), Object.assign(new Error(secretMessage), { code: "XX000" })]) {
      for (const [operation, params] of [
        ["tables.list", {}],
        ["sql.run", { statement: "create table x (id int)" }],
        ["rows.list", { table: "notes" }],
      ] as const) {
        const response = await handlerFor(failingDb(error))(signedRequest(envelope(operation, params)));
        const text = await response.text();
        expect(response.status).toBe(500);
        expect(JSON.parse(text).error.code).toBe("internal_error");
        expect(text).not.toContain("db.internal");
        expect(text).not.toContain("hunter2");
      }
    }
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("never puts the connection string or signing secret in an error body", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = failingDb(new Error(`connect ${env.DATABASE_URL} ${env.FLUID_SIGNING_SECRET}`));
    const response = await handlerFor(failing)(signedRequest(envelope("tables.list")));
    const text = await response.text();
    expect(text).not.toContain(env.DATABASE_URL);
    expect(text).not.toContain(env.FLUID_SIGNING_SECRET);
    log.mockRestore();
  });
});
