# Mist site backend template

A tiny, API-only backend for one Fluid member site. It is a Vercel Node function in front of a Neon Postgres database, and it exposes six signed operations: list tables, run a schema statement, and list, insert, update and delete rows. The operation contract is the one in Fluid's phase 020 plan ("The template" and "The operations").

Fluid's Mist pipeline copies this template once per member site, deploys the copy to Vercel, and gives it its own Neon `DATABASE_URL`. **Members do not edit this code.** Each copy only serves its own site and company; Fluid is the only caller, and every request is signed.

There is no UI, no framework, no Fluid API token, and no outbound call except to the database.

## Environment

| Variable | Secret | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon Postgres connection string (HTTP driver). |
| `FLUID_SIGNING_SECRET` | yes | HMAC-SHA256 secret Fluid signs requests with. |
| `FLUID_SITE_ID` | no | Id of the one site this copy serves. |
| `FLUID_COMPANY_ID` | no | Integer id of the company that owns the site. |

If any is missing or malformed the function answers `500 {"error":{"code":"not_configured"}}` and does not say which.

## Request contract

Fluid sends `POST` to any path (`vercel.json` rewrites every path to `/api`) with these headers:

- `X-Fluid-Shop`: the company's Fluid shop domain.
- `X-Fluid-Timestamp`: unix seconds.
- `X-Fluid-Signature`: lowercase hex HMAC-SHA256, under `FLUID_SIGNING_SECRET`, of the string `"<timestamp>.<raw body>"`.

and a JSON body:

```json
{
  "operation": "rows.list",
  "params": {},
  "company": { "id": 1, "fluid_shop": "example.fluid.app" },
  "member": { "id": "...", "public_id": "...", "external_id": null },
  "site": { "id": "<uuid>" }
}
```

The function checks, in this order and before parsing anything:

1. Method is `POST`, else `401`. No route is exempt.
2. The environment is complete, else `500 not_configured` (the secret is needed to verify, so this cannot wait).
3. Body is at most 64 KiB, else `413 invalid_request`. The body is read with a byte cap.
4. All three headers are present, the timestamp is all digits and within 300 seconds of now, else `401`.
5. The HMAC over the raw body bytes matches (`crypto.timingSafeEqual`), else `401`.
6. The body parses as a JSON object, else `400 invalid_request`.
7. `site.id` equals `FLUID_SITE_ID` and `company.id` equals `Number(FLUID_COMPANY_ID)`, else `403 wrong_site`.
8. `operation` is one of the six, else `404 unknown_operation`.

Every `401` is `{"error":{"code":"unauthorized"}}` with no detail. `member` is accepted but not used.

### Test vector and contract examples

`contract/signature-vector.json` holds the pinned signature vector (secret `whsec_backend_vector_secret`, timestamp `1800000000`, signature `f9b645523800f33fe36df6b2f00261bf6e7ccc2cbf55c87a5138a3204302227b` over the body in that file). `list_notes` is not one of this template's operations; the vector only pins the signature. `test/signature.test.ts` verifies it.

`contract/examples.json` holds the contract examples: one ordered scenario of request and response pairs for the six operations and their errors. `test/contract.test.ts` replays it against the handler, and the Rails stub receiver replays the same file. A response `body` is matched as a subset of the real body: error examples match on `error.code`, and `"<opaque>"` matches any non-empty string (a cursor).

Signing from a shell:

```sh
BODY='{"operation":"tables.list","params":{},"company":{"id":1,"fluid_shop":"x.fluid.app"},"member":{"id":"m","public_id":"p","external_id":null},"site":{"id":"<FLUID_SITE_ID>"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$FLUID_SIGNING_SECRET" -hex | sed 's/^.* //')
curl -X POST http://localhost:3000/ -H "X-Fluid-Shop: x.fluid.app" -H "X-Fluid-Timestamp: $TS" -H "X-Fluid-Signature: $SIG" --data-binary "$BODY"
```

## Responses and errors

Success is HTTP `200` with the JSON shape shown for each operation. An error is `{"error":{"code","message","details"}}`, except `401` and `not_configured`, which carry the code only.

| Status | Code | When |
| --- | --- | --- |
| 400, 413 | `invalid_request` | Body is not a JSON object, has no string `operation`, has non-object `params`, or is over 64 KiB (413). |
| 401 | `unauthorized` | Method, headers, timestamp or signature failed. No detail. |
| 403 | `wrong_site` | The request is for another site or company. |
| 404 | `unknown_operation` | `operation` is not one of the six. |
| 404 | `table_not_found` | The table is not in the `public` schema's catalog (or Postgres `42P01`). |
| 404 | `row_not_found` | No row has that key. |
| 409 | `conflict` | Unique or foreign-key violation (`23505`, `23503`). |
| 422 | `constraint_violation` | Another class `23` error: not null, check. |
| 422 | `invalid_params` | A param is wrong (`details.field` names it), a column is not in the catalog, a value has the wrong type, or the table has no single-column primary key. |
| 422 | `invalid_statement` | `sql.run` got a statement outside the allowed schema forms, or one Postgres rejects. |
| 422 | `statement_timeout` | The statement did not finish in 3 seconds (`57014`). |
| 422 | `row_too_large` | One row is larger than the 192 KiB page budget. |
| 422 | `invalid_cursor` | A cursor this template did not issue for this query. |
| 503 | `database_unavailable` | The database did not answer (connection, shutdown or capacity errors). |
| 500 | `internal_error` | Anything else. The raw error is logged, never returned. |
| 500 | `not_configured` | Environment is incomplete. |

For 4xx database errors the message is Postgres' own; it is the site owner's database. 5xx messages are fixed text. SQL is built from table and column names found in the catalog and double-quoted, and only the `public` schema is reachable; every value is a bound parameter. A name that does not match `^[A-Za-z_][A-Za-z0-9_]{0,62}$` is refused with `invalid_params` before the catalog is read. **Every operation runs in a transaction after `SET LOCAL statement_timeout = 3000`.**

## Operations

### `tables.list`

```json
{ "operation": "tables.list", "params": {} }
```

```json
{ "tables": [ { "name": "notes", "columns": [
  { "name": "id", "type": "integer", "nullable": false, "default": "nextval('notes_id_seq'::regclass)", "primary_key": true },
  { "name": "title", "type": "text", "nullable": false, "default": null, "primary_key": false }
] } ] }
```

The `public` schema's base tables (not views), ordered by table then column position. `primary_key` is true for each column of the table's primary key.

### `sql.run`

```json
{ "operation": "sql.run", "params": { "statement": "CREATE TABLE notes (id serial PRIMARY KEY, title text NOT NULL)" } }
```

```json
{ "command": "CREATE TABLE", "row_count": 0, "rows": [], "truncated": false }
```

One statement of a schema form that cannot read or rewrite rows. Anything else is refused with `422 invalid_statement` before a transaction is opened. After trimming whitespace and one optional trailing `;`, the statement must match one of:

- `CREATE TABLE [IF NOT EXISTS] <name> ( ...definitions... )`, with no `AS` query and no `LIKE` clause.
- `CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name> ON <table> ( ... )`, never `CONCURRENTLY` (it cannot run in a transaction).
- `ALTER TABLE [IF EXISTS] <table>` with **one** action: `ADD COLUMN`, `DROP COLUMN`, `RENAME COLUMN a TO b`, `RENAME TO`, `ADD CONSTRAINT <name> CHECK | FOREIGN KEY | UNIQUE | PRIMARY KEY ...`, `DROP CONSTRAINT`, `ALTER COLUMN ... SET DEFAULT`, `DROP DEFAULT`, `SET NOT NULL`, `DROP NOT NULL`, or `[SET DATA] TYPE <type>` without `USING`.
- `DROP TABLE` or `DROP INDEX` of one object (`IF EXISTS`, `CASCADE` and `RESTRICT` are allowed).
- `COMMENT ON TABLE <table> IS '...'` or `COMMENT ON COLUMN <table>.<column> IS '...'`.

Names are plain or double-quoted identifiers, optionally `public.`-qualified. The statement is also refused if it holds, anywhere and case-insensitively, any of the words `select`, `insert`, `update`, `delete`, `merge`, `copy`, `using`, `with`, `do`, `truncate`, `vacuum`, `reindex`, `cluster`, `refresh`, `grant`, `revoke` or `concurrently`; an `AS` followed by `(`, `select`, `values`, `table` or `with` (a query, or a generated column); a `;`, a comment (`--`, `/* */`) or a `$`; or a `CREATE` of a view, materialized view, function, procedure, trigger, rule, extension, schema, role, policy, sequence, type or domain. Two phrases are exempt from the word check because they cannot read rows: `ON DELETE` and `ON UPDATE` (foreign-key actions) and `WITH TIME ZONE` or `WITHOUT TIME ZONE`.

The check does not tell string literals from code, so a word inside a literal is **over-refused**: `COMMENT ON TABLE t IS 'select the best'` and `DEFAULT 'update'` are refused. So are an index `USING` method, a `WITH (...)` storage option and a generated column. Names that only contain a word (`updates_log`, `with_user`) are fine.

`command` is the command tag of the matched form (`CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, `DROP TABLE`, `DROP INDEX` or `COMMENT`), `row_count` is the rows touched, `rows` holds at most 100 returned rows and `truncated` is true beyond that. This is a guard against mistakes, not a sandbox.

### `rows.list`

```json
{ "operation": "rows.list", "params": {
  "table": "notes",
  "filters": [ { "column": "rank", "op": "gte", "value": 2 }, { "column": "body", "op": "is_null", "value": false } ],
  "sort": [ { "column": "rank", "direction": "desc" } ],
  "limit": 20
} }
```

```json
{ "rows": [ { "id": 3, "title": "alpha", "rank": 4, "body": "x" } ], "next_cursor": null }
```

- `filters`: each `{ column, op, value }`, ANDed. `op` is one of `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `in` (an array of 1 to 100 non-null values) and `is_null` (a boolean). `eq` and `neq` with `null` read as `IS NULL` and `IS NOT NULL`.
- `sort`: each `{ column, direction }`, `direction` being `asc` (the default) or `desc`. The order always ends with the table's primary key, so equal sort values page stably.
- `limit`: 1 to 100, default 25. Anything else is `invalid_params`.
- `cursor`: pass the previous response's `next_cursor`. It is opaque, signed under the signing secret and tied to the table, filters and sort it was issued for. Any other cursor is `422 invalid_cursor`.
- A page ends at `limit` rows or before 192 KiB of serialized rows, whichever comes first, and `next_cursor` is `null` only on the last page. One row larger than the budget is `422 row_too_large`.

### `rows.insert`

```json
{ "operation": "rows.insert", "params": { "table": "notes", "rows": [ { "title": "a" }, { "title": "b" } ] } }
```

```json
{ "rows": [ { "id": 1, "title": "a" }, { "id": 2, "title": "b" } ] }
```

1 to 100 rows, all with the same keys, inserted in one statement (all or none). Objects and arrays are sent as JSON text, which suits `json` and `jsonb` columns.

### `rows.update`

```json
{ "operation": "rows.update", "params": { "table": "notes", "id": 1, "values": { "title": "renamed" } } }
```

```json
{ "row": { "id": 1, "title": "renamed" } }
```

`id` is the value of the table's single-column primary key, whatever that column is named. A table without one is `422 invalid_params`. `values` must be non-empty and must not name the primary key. `404 row_not_found` if no row has that key.

### `rows.delete`

```json
{ "operation": "rows.delete", "params": { "table": "notes", "id": 1 } }
```

```json
{ "deleted": true }
```

Addressed like `rows.update`; `404 row_not_found` if no row has that key.

## Layout

```
api/index.ts          Vercel function: GET/POST/PUT/PATCH/DELETE/OPTIONS, all through one handler
src/handler.ts        verification order, dispatch, error mapping
src/signature.ts      HMAC signing and verification
src/body.ts           byte-capped body reader
src/operations/       the six operations; statement.ts holds the sql.run schema-form check
src/catalog.ts        tables, columns and primary keys read from the catalog
src/cursor.ts         signed, query-bound cursors
src/db.ts             Db interface, the Neon HTTP implementation, the 3 second timeout
src/errors.ts         the error codes and the SQLSTATE mapping
contract/             signature vector and contract examples (replayed by Rails' stub receiver)
scripts/pglite-db.ts  Db backed by PGlite, for tests and local runs
scripts/dev.ts        local server
test/                 vitest
```

## Local development

Node 22 (`.tool-versions`).

```sh
npm install
npm test            # vitest, with an in-memory PGlite database (PGlite does not enforce statement_timeout; tests assert the SET LOCAL and the error mapping instead)
npm run typecheck
npm run lint
```

To run it locally without Neon, backed by in-memory PGlite:

```sh
cp .env.example .env    # set FLUID_SIGNING_SECRET, FLUID_SITE_ID, FLUID_COMPANY_ID
npm run dev             # http://localhost:3000; data is lost on exit
```

Then send signed requests as shown above. `DATABASE_URL` is not used by `npm run dev`.

## Deploying

Zero-config on Vercel: `api/index.ts` is detected as a Node function and `vercel.json` rewrites every path to it. Fluid sets the four environment variables on the project.
