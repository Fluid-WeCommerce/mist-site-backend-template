import { PGlite } from "@electric-sql/pglite";
import { createHandler } from "../src/handler.js";
import { sign } from "../src/signature.js";
import { pgliteDb } from "../scripts/pglite-db.js";

export const SECRET = "whsec_test_secret";
export const SITE_ID = "0198c7a4-6a10-7c11-8e2f-3b5d7a9c1e47";
export const COMPANY_ID = 7;
export const NOW = 1_800_000_000;

export const env = {
  DATABASE_URL: "postgresql://unused",
  FLUID_SIGNING_SECRET: SECRET,
  FLUID_SITE_ID: SITE_ID,
  FLUID_COMPANY_ID: String(COMPANY_ID),
};

export function envelope(operation: string, params: unknown = {}, overrides: object = {}) {
  return {
    operation,
    params,
    company: { id: COMPANY_ID, fluid_shop: "example.fluid.app" },
    member: { id: "m", public_id: "p", external_id: null },
    site: { id: SITE_ID },
    ...overrides,
  };
}

export interface SignedOptions {
  secret?: string;
  timestamp?: string;
  method?: string;
  /** Header names to leave out. */
  omit?: string[];
  signature?: string;
}

/** A request signed the way Fluid signs it. `body` is sent exactly as given if a string. */
export function signedRequest(body: unknown, options: SignedOptions = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = options.timestamp ?? String(NOW);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-fluid-shop": "example.fluid.app",
    "x-fluid-timestamp": timestamp,
    "x-fluid-signature": options.signature ?? sign(options.secret ?? SECRET, timestamp, raw),
  };
  for (const name of options.omit ?? []) delete headers[name];
  const method = options.method ?? "POST";
  return new Request("https://site.example/anything", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : raw,
  });
}

export function makeHandler(pg: PGlite, overrideEnv: Record<string, string | undefined> = env) {
  return createHandler({ env: overrideEnv, db: pgliteDb(pg), now: () => NOW });
}

// Parsed response bodies are asserted on directly, so they stay loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export async function readJson(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

/** Sends one operation and returns status and parsed JSON. */
export async function call(
  handle: (request: Request) => Promise<Response>,
  operation: string,
  params: unknown = {},
) {
  const response = await handle(signedRequest(envelope(operation, params)));
  return { status: response.status, body: await readJson(response) };
}

export async function resetDatabase(pg: PGlite) {
  await pg.exec("DROP SCHEMA IF EXISTS other CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}
