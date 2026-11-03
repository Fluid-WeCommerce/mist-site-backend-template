# Mist site backend template

A tiny, API-only backend for one Fluid member site. It is a Vercel Node function in front of a Neon Postgres database, and it exposes six signed operations: list tables, run a schema change, and list, insert, update and delete rows.

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
3. Body is at most 64 KiB, else `413 payload_too_large`. The body is read with a byte cap.
4. All three headers are present, the timestamp is all digits and within 300 seconds of now, else `401`.
5. The HMAC over the raw body bytes matches (`crypto.timingSafeEqual`), else `401`.
6. The body parses as JSON, else `400 invalid_json`.
7. `site.id` equals `FLUID_SITE_ID` and `company.id` equals `Number(FLUID_COMPANY_ID)`, else `403 wrong_site`.

Every `401` is `{"error":{"code":"unauthorized"}}` with no detail. `member` is accepted but not used.

### Test vector

```
secret:    whsec_backend_vector_secret
timestamp: 1800000000
body:      {"operation":"list_notes","params":{"limit":10},"company":{"id":1,"fluid_shop":"example.fluid.app"},"member":{"id":"0198c7a4-3d8e-7a52-9b6c-1e0f4a7d2c93","public_id":"0198c7a4-52f1-7b3e-9d0a-6f4e1c2b8a35","external_id":null},"site":{"id":"0198c7a4-6a10-7c11-8e2f-3b5d7a9c1e47"}}
signature: f9b645523800f33fe36df6b2f00261bf6e7ccc2cbf55c87a5138a3204302227b
```

(`list_notes` is not one of this template's operations; the vector only pins the signature.) `test/signature.test.ts` verifies it.

Signing from a shell:

```sh
BODY='{"operation":"tables.list","params":{},"company":{"id":1,"fluid_shop":"x.fluid.app"},"member":{"id":"m","public_id":"p","external_id":null},"site":{"id":"<FLUID_SITE_ID>"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$FLUID_SIGNING_SECRET" -hex | sed 's/^.* //')
curl -X POST http://localhost:3000/ -H "X-Fluid-Shop: x.fluid.app" -H "X-Fluid-Timestamp: $TS" -H "X-Fluid-Signature: $SIG" --data-binary "$BODY"
```

## Responses and errors

Success is HTTP `200` with the JSON shape shown for each operation. Errors are `{"error":{"code":"...","message":"..."}}`.

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_json`, `invalid_request` | Body is not JSON, or is not an object with a string `operation`. |
| 400 | `unknown_operation` | `operation` is not one of the six. |
| 400 | `invalid_params` | A parameter is wrong; the message names the field. |
| 400 | `invalid_statement` | `sql.run` refused the statement. |
| 401 | `unauthorized` | Method, headers, timestamp or signature failed. No detail. |
| 403 | `wrong_site` | The request is for another site or company. |
| 404 | `not_found` | No such table (`42P01`), or no row with that id. |
| 409 | `conflict` | Unique violation (`23505`). |
| 413 | `payload_too_large` | Body over 64 KiB. |
| 422 | `constraint_violation` | Other class `23` errors (not null, foreign key, check). |
| 422 | `invalid_query` | Class `42` (other than `42P01`) and class `22` errors, such as an unknown column or a bad value. |
| 422 | `timeout` | Statement timeout (`57014`). |
| 500 | `server_error` | Anything else. The raw error is logged, never returned. |
| 500 | `not_configured` | Environment is incomplete. |

For 4xx database errors the message is Postgres' own; it is the site owner's database. Names of tables and columns must match `^[a-z_][a-z0-9_]{0,62}$`, are always double-quoted, and only the `public` schema is reachable. Values are always bound parameters, never interpolated.

## Operations

### `tables.list`

```json
{ "operation": "tables.list", "params": {} }
```

```json
{ "tables": [ { "name": "notes", "columns": [
  { "name": "id", "type": "integer", "nullable": false, "default": "nextval('notes_id_seq'::regclass)" },
  { "name": "title", "type": "text", "nullable": false, "default": null }
] } ] }
```

Read from `information_schema.columns` for the `public` schema, ordered by table then column position (views are included).

### `sql.run`

```json
{ "operation": "sql.run", "params": { "statement": "CREATE TABLE notes (id serial PRIMARY KEY, title text NOT NULL)" } }
```

```json
{ "ok": true }
```

Schema changes only. After trimming whitespace and one optional trailing `;`, the statement is refused with `400 invalid_statement` if it is empty, if any `;` remains, or if its first keyword (case-insensitive) is not `create`, `alter`, `drop` or `comment`. It runs in a transaction after `SET LOCAL statement_timeout = 10000`. This is a guard against mistakes, not a sandbox. A `;` inside a string literal or a function body is also refused.

### `rows.list`

```json
{ "operation": "rows.list", "params": {
  "table": "notes",
  "where": { "pinned": true, "rank": { "gte": 2, "lt": 10 }, "title": { "ilike": "a%" } },
  "order": [ { "column": "rank", "direction": "desc" } ],
  "limit": 20
} }
```

```json
{ "rows": [ { "id": 3, "title": "alpha", "rank": 4, "pinned": true } ], "next_cursor": null }
```

- `where`: each column maps to a value (meaning `eq`) or to an object of operators, ANDed together. Operators: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `like`, `ilike`, `in` (array of 1 to 100 values), `is_null` (boolean). A `null` with `eq` or `neq` is read as `IS NULL` or `IS NOT NULL`.
- `order`: `direction` is `asc` (default) or `desc`. Pass an `order` whenever you page, or the row order is not guaranteed.
- `limit`: default 50. A value above 100 is capped at 100. Zero, negative and non-integer values are refused.
- `cursor`: pass the previous response's `next_cursor`. It is an opaque base64url string (it encodes an offset). `next_cursor` is `null` on the last page.

### `rows.insert`

```json
{ "operation": "rows.insert", "params": { "table": "notes", "rows": [ { "title": "a" }, { "title": "b" } ] } }
```

```json
{ "rows": [ { "id": 1, "title": "a" }, { "id": 2, "title": "b" } ] }
```

1 to 100 rows, all with the same keys, inserted in one statement (all or nothing). Objects and arrays are sent as JSON text, which suits `json` and `jsonb` columns.

### `rows.update`

```json
{ "operation": "rows.update", "params": { "table": "notes", "id": 1, "values": { "title": "renamed" } } }
```

```json
{ "row": { "id": 1, "title": "renamed" } }
```

`values` must be non-empty and must not contain `id`. The table needs an `id` column (without one, Postgres' error comes back as `422 invalid_query`). `404 not_found` if no row has that id.

### `rows.delete`

```json
{ "operation": "rows.delete", "params": { "table": "notes", "id": 1 } }
```

```json
{ "deleted": true }
```

`404 not_found` if no row has that id.

## Layout

```
api/index.ts          Vercel function: GET/POST/PUT/PATCH/DELETE/OPTIONS, all through one handler
src/handler.ts        verification order, dispatch, error mapping
src/signature.ts      HMAC signing and verification
src/body.ts           byte-capped body reader
src/operations/       the six operations
src/db.ts             Db interface and the Neon HTTP implementation
scripts/pglite-db.ts  Db backed by PGlite, for tests and local runs
scripts/dev.ts        local server
test/                 vitest
```

## Local development

Node 22 (`.tool-versions`).

```sh
npm install
npm test            # vitest, with an in-memory PGlite database
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
