import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, makeHandler, resetDatabase, type Json } from "./helpers.js";

interface Example {
  name: string;
  request: { operation: string; params: unknown };
  response: { status: number; body: unknown };
}

const { examples } = JSON.parse(
  readFileSync(new URL("../contract/examples.json", import.meta.url), "utf8"),
) as { examples: Example[] };

/** `expected` is a subset of `actual`; "<opaque>" matches any non-empty string. */
function matches(actual: unknown, expected: unknown): boolean {
  if (expected === "<opaque>") return typeof actual === "string" && actual.length > 0;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => matches(actual[i], item))
    );
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null) return false;
    return Object.entries(expected).every(([key, value]) => matches((actual as Json)[key], value));
  }
  return actual === expected;
}

describe("contract examples", () => {
  let pg: PGlite;
  let handle: ReturnType<typeof makeHandler>;

  beforeAll(async () => {
    pg = new PGlite();
    await resetDatabase(pg);
    handle = makeHandler(pg);
  });
  afterAll(() => pg.close());

  // The examples are one ordered scenario: each builds on the state before it.
  it.each(examples.map((example) => [example.name, example] as const))("%s", async (_name, example) => {
    const { status, body } = await call(handle, example.request.operation, example.request.params);
    expect(status).toBe(example.response.status);
    expect(matches(body, example.response.body), JSON.stringify(body)).toBe(true);
  });

  it("covers all six operations", () => {
    const names = new Set(examples.map((e) => e.request.operation));
    for (const op of ["tables.list", "sql.run", "rows.list", "rows.insert", "rows.update", "rows.delete"]) {
      expect(names.has(op), op).toBe(true);
    }
  });
});
