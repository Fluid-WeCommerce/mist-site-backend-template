import { BodyTooLargeError, readBody } from "./body.js";
import { readConfig, type Env } from "./config.js";
import { neonDb, type Db } from "./db.js";
import { ApiError, mapDbError } from "./errors.js";
import { findOperation } from "./operations/index.js";
import { isPlainObject } from "./operations/params.js";
import { verifySignature } from "./signature.js";

export interface HandlerOptions {
  /** Environment to read configuration from. Defaults to `process.env`. */
  env?: Env;
  /** Database to use. Defaults to Neon over HTTP from `DATABASE_URL`. */
  db?: Db;
  /** Current unix time in seconds. Defaults to the clock. */
  now?: () => number;
}

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

// bigint columns come back as BigInt, which JSON cannot carry; send them as strings.
const toJson = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

function json(status: number, body: unknown): Response {
  return new Response(toJson(body), { status, headers: HEADERS });
}

function failure(status: number, code: string, message?: string): Response {
  return json(status, { error: message === undefined ? { code } : { code, message } });
}

const unauthorized = () => failure(401, "unauthorized");

export function createHandler(options: HandlerOptions = {}): (request: Request) => Promise<Response> {
  let neon: { url: string; db: Db } | undefined;

  const databaseFor = (url: string): Db => {
    if (options.db) return options.db;
    if (neon?.url !== url) neon = { url, db: neonDb(url) };
    return neon.db;
  };

  return async function handle(request: Request): Promise<Response> {
    try {
      // 1. Method. No route is exempt, and the answer reveals nothing more.
      if (request.method !== "POST") return unauthorized();

      const config = readConfig(options.env ?? process.env);
      if (!config) return failure(500, "not_configured");

      // 2. Body, with a byte cap.
      let body: Uint8Array;
      try {
        body = await readBody(request);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return failure(413, "payload_too_large", "Request body must be 64 KiB or smaller");
        }
        throw error;
      }

      // 3 and 4. Headers, timestamp window and signature, over the raw bytes.
      if (!request.headers.get("x-fluid-shop")) return unauthorized();
      const valid = verifySignature({
        secret: config.signingSecret,
        timestamp: request.headers.get("x-fluid-timestamp"),
        signature: request.headers.get("x-fluid-signature"),
        body,
        now: options.now?.(),
      });
      if (!valid) return unauthorized();

      // 5. Only now parse.
      let envelope: unknown;
      try {
        envelope = JSON.parse(Buffer.from(body).toString("utf8"));
      } catch {
        return failure(400, "invalid_json", "Request body is not valid JSON");
      }
      if (!isPlainObject(envelope)) {
        return failure(400, "invalid_request", "Request body must be a JSON object");
      }

      // 6. The request must be for this copy's site and company.
      const site = isPlainObject(envelope.site) ? envelope.site : {};
      const company = isPlainObject(envelope.company) ? envelope.company : {};
      if (site.id !== config.siteId || company.id !== config.companyId) {
        return failure(403, "wrong_site", "This request is for a different site");
      }

      if (typeof envelope.operation !== "string") {
        return failure(400, "invalid_request", "operation must be a string");
      }
      const operation = findOperation(envelope.operation);
      if (!operation) return failure(400, "unknown_operation", "Unknown operation");

      const params = envelope.params ?? {};
      if (!isPlainObject(params)) {
        return failure(400, "invalid_params", "params must be an object");
      }

      try {
        return json(200, await operation(databaseFor(config.databaseUrl), params));
      } catch (error) {
        const mapped = error instanceof ApiError ? error : mapDbError(error);
        if (mapped) return failure(mapped.status, mapped.code, mapped.message);
        throw error;
      }
    } catch (error) {
      console.error("site backend request failed", error);
      return failure(500, "server_error", "Internal server error");
    }
  };
}
