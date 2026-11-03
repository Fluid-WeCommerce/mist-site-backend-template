import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler } from "../src/handler.js";
import { MAX_LIMIT } from "../src/operations/rows.js";
import { pgliteDb } from "../scripts/pglite-db.js";
import {
  COMPANY_ID,
  NOW,
  SITE_ID,
  call,
  env,
  envelope,
  makeHandler,
  resetDatabase,
  signedRequest,
  readJson,
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

describe("request shape", () => {
  it("answers 400 unknown_operation", async () => {
    const { status, body } = await call(handle, "rows.explode");
    expect(status).toBe(400);
    expect(body.error.code).toBe("unknown_operation");
  });

  it("does not resolve operations through the prototype chain", async () => {
    const { status, body } = await call(handle, "constructor");
    expect(status).toBe(400);
    expect(body.error.code).toBe("unknown_operation");
  });

  it("answers 400 invalid_params when params is not an object", async () => {
    const response = await handle(signedRequest(envelope("tables.list", [1])));
    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("invalid_params");
  });

  it("treats missing params as an empty object", async () => {
    const { operation, company, member, site } = envelope("tables.list");
    const response = await handle(signedRequest({ operation, company, member, site }));
    expect(response.status).toBe(200);
  });
});

describe("tables.list", () => {
  it("lists tables and columns in order", async () => {
    await pg.exec("CREATE TABLE a_first (x integer NOT NULL, y text DEFAULT 'hi')");
    const { status, body } = await call(handle, "tables.list");
    expect(status).toBe(200);
    expect(body.tables.map((t: { name: string }) => t.name)).toEqual(["a_first", "notes"]);
    expect(body.tables[0].columns).toEqual([
      { name: "x", type: "integer", nullable: false, default: null },
      { name: "y", type: "text", nullable: true, default: "'hi'::text" },
    ]);
    expect(body.tables[1].columns.map((c: { name: string }) => c.name)).toEqual([
      "id",
      "title",
      "body",
      "rank",
      "pinned",
    ]);
    expect(body.tables[1].columns[0]).toMatchObject({ name: "id", type: "integer", nullable: false });
  });

  it("returns an empty list for an empty schema", async () => {
    await resetDatabase(pg);
    expect(await call(handle, "tables.list")).toEqual({ status: 200, body: { tables: [] } });
  });

  it("ignores other schemas", async () => {
    await pg.exec("CREATE SCHEMA other; CREATE TABLE other.hidden (id integer)");
    const { body } = await call(handle, "tables.list");
    expect(body.tables.map((t: { name: string }) => t.name)).toEqual(["notes"]);
  });
});

describe("sql.run", () => {
  it("runs a schema change, with or without a trailing semicolon", async () => {
    expect(await call(handle, "sql.run", { statement: "  CREATE TABLE tags (id serial PRIMARY KEY);  " })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect((await call(handle, "sql.run", { statement: "alter table tags add column label text" })).status).toBe(200);
    expect((await call(handle, "sql.run", { statement: "comment on table tags is 'labels'" })).status).toBe(200);
    expect((await call(handle, "sql.run", { statement: "DROP TABLE tags" })).status).toBe(200);
    const { rows } = await pg.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'tags'");
    expect(rows).toHaveLength(0);
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
  ])("refuses %s", async (_name, statement) => {
    const { status, body } = await call(handle, "sql.run", { statement });
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_statement");
  });

  it("does not run any part of a refused statement", async () => {
    await call(handle, "sql.run", { statement: "create table a (id int); drop table notes" });
    const { body } = await call(handle, "tables.list");
    expect(body.tables.map((t: { name: string }) => t.name)).toEqual(["notes"]);
  });

  it("requires a string statement", async () => {
    const { status, body } = await call(handle, "sql.run", { statement: 5 });
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_params");
  });

  it("reports Postgres errors", async () => {
    const { status, body } = await call(handle, "sql.run", { statement: "create table notes (id int)" });
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_query");
    expect(body.error.message).toContain("notes");
  });

  it("sets a 10 second statement timeout first, inside the transaction", async () => {
    const real = pgliteDb(pg);
    const transactions: string[][] = [];
    const recording = createHandler({
      env,
      now: () => NOW,
      db: {
        query: real.query,
        transaction: (statements) => {
          transactions.push(statements.map((s) => s.text));
          return real.transaction(statements);
        },
      },
    });
    await call(recording, "sql.run", { statement: "create table timed (id int);" });
    expect(transactions).toEqual([["SET LOCAL statement_timeout = 10000", "create table timed (id int)"]]);
  });

  it("rolls back when the statement fails", async () => {
    await call(handle, "sql.run", { statement: "alter table notes add column nope nonexistent_type" });
    const { body } = await call(handle, "tables.list");
    expect(body.tables[0].columns.map((c: { name: string }) => c.name)).not.toContain("nope");
  });
});

describe("identifier validation", () => {
  it.each(["notes; drop", "Notes", "no-tes", "1notes", "", "a".repeat(64), "no tes", 'no"tes', 5])(
    "refuses table %j",
    async (table) => {
      for (const [operation, params] of [
        ["rows.list", { table }],
        ["rows.insert", { table, rows: [{ title: "x" }] }],
        ["rows.update", { table, id: 1, values: { title: "x" } }],
        ["rows.delete", { table, id: 1 }],
      ] as const) {
        const { status, body } = await call(handle, operation, params);
        expect(status, operation).toBe(400);
        expect(body.error.code).toBe("invalid_params");
        expect(body.error.message).toContain("table");
      }
    },
  );

  it("accepts the longest identifier, 63 characters", async () => {
    const name = "t".repeat(63);
    await pg.exec(`CREATE TABLE "${name}" (id serial PRIMARY KEY)`);
    expect((await call(handle, "rows.list", { table: name })).status).toBe(200);
  });

  it("refuses bad column names everywhere and says which field", async () => {
    const cases = [
      ["rows.list", { table: "notes", where: { "title; x": 1 } }, "where column"],
      ["rows.list", { table: "notes", order: [{ column: "Title" }] }, "order[0].column"],
      ["rows.insert", { table: "notes", rows: [{ "bad col": 1 }] }, "column"],
      ["rows.update", { table: "notes", id: 1, values: { 'x"y': 1 } }, "column"],
    ] as const;
    for (const [operation, params, field] of cases) {
      const { status, body } = await call(handle, operation, params);
      expect(status, operation).toBe(400);
      expect(body.error.message).toContain(field);
    }
  });

  it("does not execute injected SQL", async () => {
    await seed(1);
    await call(handle, "rows.list", { table: "notes; drop table notes" });
    await call(handle, "rows.list", { table: "notes", where: { title: "x' OR 1=1; DROP TABLE notes; --" } });
    const { body } = await call(handle, "rows.list", { table: "notes" });
    expect(body.rows).toHaveLength(1);
  });

  it("only reaches the public schema", async () => {
    await pg.exec("CREATE SCHEMA other; CREATE TABLE other.secret (id serial PRIMARY KEY)");
    const { status, body } = await call(handle, "rows.list", { table: "secret" });
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
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
  const list = (extra: object) => call(handle, "rows.list", { table: "notes", order: [{ column: "id" }], ...extra });

  it("returns all rows with a null cursor when everything fits", async () => {
    const { status, body } = await list({});
    expect(status).toBe(200);
    expect(titles(body)).toEqual(["alpha", "Bravo", "charlie", "delta", "echo"]);
    expect(body.next_cursor).toBeNull();
  });

  it("treats a bare value as eq", async () => {
    expect(titles((await list({ where: { title: "alpha" } })).body)).toEqual(["alpha"]);
    expect(titles((await list({ where: { pinned: true } })).body)).toEqual(["alpha", "delta"]);
    expect(titles((await list({ where: { rank: 3 } })).body)).toEqual(["charlie"]);
  });

  it.each([
    [{ title: { eq: "alpha" } }, ["alpha"]],
    [{ rank: { neq: 2 } }, ["alpha", "charlie", "delta"]],
    [{ rank: { lt: 3 } }, ["alpha", "Bravo"]],
    [{ rank: { lte: 3 } }, ["alpha", "Bravo", "charlie"]],
    [{ rank: { gt: 3 } }, ["delta"]],
    [{ rank: { gte: 3 } }, ["charlie", "delta"]],
    [{ rank: { gte: 2, lt: 4 } }, ["Bravo", "charlie"]],
    [{ title: { like: "%a" } }, ["alpha", "delta"]],
    [{ title: { like: "b%" } }, []],
    [{ title: { ilike: "b%" } }, ["Bravo"]],
    [{ title: { in: ["alpha", "echo", "zulu"] } }, ["alpha", "echo"]],
    [{ rank: { in: [1, 4] } }, ["alpha", "delta"]],
    [{ body: { is_null: true } }, ["Bravo", "echo"]],
    [{ body: { is_null: false } }, ["alpha", "charlie", "delta"]],
    [{ body: null }, ["Bravo", "echo"]],
    [{ body: { neq: null } }, ["alpha", "charlie", "delta"]],
    [{ pinned: false, rank: { gt: 1 } }, ["Bravo", "charlie"]],
  ])("filters %j", async (where, expected) => {
    const { status, body } = await list({ where });
    expect(status).toBe(200);
    expect(titles(body)).toEqual(expected);
  });

  it("binds filter values rather than interpolating them", async () => {
    const { status, body } = await list({ where: { title: "alpha' OR '1'='1" } });
    expect(status).toBe(200);
    expect(body.rows).toEqual([]);
  });

  it("orders by several columns", async () => {
    const { body } = await call(handle, "rows.list", {
      table: "notes",
      order: [{ column: "pinned", direction: "desc" }, { column: "rank", direction: "desc" }],
    });
    expect(titles(body)).toEqual(["delta", "alpha", "echo", "charlie", "Bravo"]);
    const asc = await call(handle, "rows.list", { table: "notes", order: [{ column: "rank" }] });
    expect(titles(asc.body)).toEqual(["alpha", "Bravo", "charlie", "delta", "echo"]);
  });

  it.each([
    [{ where: { rank: { between: [1, 2] } } }, "unknown operator"],
    [{ where: { rank: {} } }, "empty"],
    [{ where: [] }, "where"],
    [{ where: { rank: { in: [] } } }, "where.rank.in"],
    [{ where: { rank: { in: Array.from({ length: 101 }, (_, i) => i) } } }, "where.rank.in"],
    [{ where: { rank: { is_null: "yes" } } }, "where.rank.is_null"],
    [{ where: { title: { like: 5 } } }, "where.title.like"],
    [{ where: { rank: { gt: null } } }, "where.rank.gt"],
    [{ where: { rank: { gt: [1] } } }, "where.rank.gt"],
    [{ order: [{ column: "rank", direction: "up" }] }, "order[0].direction"],
    [{ order: "rank" }, "order"],
    [{ limit: 0 }, "limit"],
    [{ limit: -1 }, "limit"],
    [{ limit: 1.5 }, "limit"],
    [{ limit: "5" }, "limit"],
    [{ cursor: "!!" }, "cursor"],
    [{ cursor: Buffer.from("-1").toString("base64url") }, "cursor"],
    [{ cursor: 5 }, "cursor"],
  ])("rejects invalid params %j", async (extra, field) => {
    const { status, body } = await list(extra);
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_params");
    expect(body.error.message).toContain(field);
  });

  it("accepts exactly 100 values in `in`", async () => {
    const { status } = await list({ where: { rank: { in: Array.from({ length: 100 }, (_, i) => i) } } });
    expect(status).toBe(200);
  });

  it("serializes bigint columns as strings", async () => {
    await pg.exec("CREATE TABLE big (id serial PRIMARY KEY, n bigint); INSERT INTO big (n) VALUES (9007199254740993)");
    const { body } = await call(handle, "rows.list", { table: "big" });
    expect(body.rows[0].n).toBe("9007199254740993");
  });

  describe("paging", () => {
    beforeEach(async () => {
      await resetDatabase(pg);
      await pg.exec("CREATE TABLE notes (id serial PRIMARY KEY, title text NOT NULL UNIQUE, body text, rank integer, pinned boolean)");
      await seed(130);
    });

    it("defaults the limit to 50", async () => {
      const { body } = await list({});
      expect(body.rows).toHaveLength(50);
      expect(typeof body.next_cursor).toBe("string");
    });

    it("caps the limit at 100", async () => {
      const { status, body } = await list({ limit: 500 });
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
      expect(first.body.next_cursor).not.toBeNull();
      const second = await list({ limit: 65, cursor: first.body.next_cursor });
      expect(second.body.rows).toHaveLength(65);
      expect(second.body.next_cursor).toBeNull();
    });

    it("returns no rows past the end", async () => {
      const cursor = Buffer.from("5000").toString("base64url");
      const { status, body } = await list({ cursor });
      expect(status).toBe(200);
      expect(body).toEqual({ rows: [], next_cursor: null });
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
    const { body } = await call(handle, "rows.insert", {
      table: "notes",
      rows: [{ title: "a", rank: 1 }, { title: "b", rank: 2 }, { title: "c", rank: null }],
    });
    expect(body.rows.map((r: { title: string }) => r.title)).toEqual(["a", "b", "c"]);
    expect(body.rows[2].rank).toBeNull();
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
  ])("rejects invalid params %j", async (extra, field) => {
    const { status, body } = await call(handle, "rows.insert", { table: "notes", ...extra });
    expect(status).toBe(400);
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
  });

  it("answers 422 constraint_violation for a not-null violation", async () => {
    const { status, body } = await call(handle, "rows.insert", { table: "notes", rows: [{ body: "no title" }] });
    expect(status).toBe(422);
    expect(body.error.code).toBe("constraint_violation");
  });

  it("answers 422 invalid_query for a bad value or unknown column", async () => {
    const badValue = await call(handle, "rows.insert", { table: "notes", rows: [{ title: "x", rank: "abc" }] });
    expect(badValue.status).toBe(422);
    expect(badValue.body.error.code).toBe("invalid_query");
    const badColumn = await call(handle, "rows.insert", { table: "notes", rows: [{ nope: 1 }] });
    expect(badColumn.status).toBe(422);
    expect(badColumn.body.error.code).toBe("invalid_query");
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

  it("answers 404 not_found for a missing id", async () => {
    const { status, body } = await call(handle, "rows.update", { table: "notes", id: 99, values: { rank: 1 } });
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("answers 404 not_found for a missing table", async () => {
    const { status, body } = await call(handle, "rows.update", { table: "ghosts", id: 1, values: { rank: 1 } });
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("answers 409 for a unique violation", async () => {
    const { status } = await call(handle, "rows.update", { table: "notes", id: 1, values: { title: "note 001" } });
    expect(status).toBe(409);
  });

  it("answers 422 invalid_query when the table has no id column", async () => {
    await pg.exec("CREATE TABLE loose (name text)");
    const { status, body } = await call(handle, "rows.update", { table: "loose", id: 1, values: { name: "x" } });
    expect(status).toBe(422);
    expect(body.error.code).toBe("invalid_query");
  });

  it.each([
    [{ id: 1, values: {} }, "values"],
    [{ id: 1 }, "values"],
    [{ id: 1, values: { id: 5, title: "x" } }, "values.id"],
    [{ values: { title: "x" } }, "id"],
    [{ id: null, values: { title: "x" } }, "id"],
    [{ id: {}, values: { title: "x" } }, "id"],
    [{ id: "", values: { title: "x" } }, "id"],
  ])("rejects invalid params %j", async (extra, field) => {
    const { status, body } = await call(handle, "rows.update", { table: "notes", ...extra });
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_params");
    expect(body.error.message).toContain(field);
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

  it("answers 404 not_found for a missing id, and again for a repeat", async () => {
    expect((await call(handle, "rows.delete", { table: "notes", id: 99 })).status).toBe(404);
    await call(handle, "rows.delete", { table: "notes", id: 1 });
    const again = await call(handle, "rows.delete", { table: "notes", id: 1 });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("not_found");
  });

  it("answers 404 not_found for a missing table", async () => {
    const { status, body } = await call(handle, "rows.delete", { table: "ghosts", id: 1 });
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("answers 400 for a missing id", async () => {
    const { status, body } = await call(handle, "rows.delete", { table: "notes" });
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_params");
  });

  it("answers 422 for a foreign key violation", async () => {
    await pg.exec("CREATE TABLE child (id serial PRIMARY KEY, note_id integer REFERENCES notes(id))");
    await pg.exec("INSERT INTO child (note_id) VALUES (1)");
    const { status, body } = await call(handle, "rows.delete", { table: "notes", id: 1 });
    expect(status).toBe(422);
    expect(body.error.code).toBe("constraint_violation");
  });
});

describe("database errors", () => {
  it("answers 404 not_found for a missing table on rows.list and rows.insert", async () => {
    for (const [operation, params] of [
      ["rows.list", { table: "ghosts" }],
      ["rows.insert", { table: "ghosts", rows: [{ a: 1 }] }],
    ] as const) {
      const { status, body } = await call(handle, operation, params);
      expect(status, operation).toBe(404);
      expect(body.error.code).toBe("not_found");
    }
  });

  it("answers 422 timeout for SQLSTATE 57014", async () => {
    const failing = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    const handler = createHandler({
      env,
      now: () => NOW,
      db: { query: () => Promise.reject(failing), transaction: () => Promise.reject(failing) },
    });
    const { status, body } = await call(handler, "tables.list");
    expect(status).toBe(422);
    expect(body.error.code).toBe("timeout");
  });

  it("answers 500 server_error without leaking the raw message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secretMessage = "connection to host db.internal.example refused";
    const handler = createHandler({
      env,
      now: () => NOW,
      db: {
        query: () => Promise.reject(Object.assign(new Error(secretMessage), { code: "08006" })),
        transaction: () => Promise.reject(new Error(secretMessage)),
      },
    });
    for (const [operation, params] of [
      ["tables.list", {}],
      ["sql.run", { statement: "create table x (id int)" }],
    ] as const) {
      const response = await handler(signedRequest(envelope(operation, params)));
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(text).error.code).toBe("server_error");
      expect(text).not.toContain("db.internal");
    }
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
