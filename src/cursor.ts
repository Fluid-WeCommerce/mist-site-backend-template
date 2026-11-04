import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.js";

const MAX_OFFSET = 1_000_000_000;

const invalidCursor = () => new ApiError(422, "invalid_cursor", "cursor was not issued for this query");

function mac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update("cursor\n").update(payload).digest();
}

/** Identifies a query's table, filters and sort, so a cursor only pages the query it came from. */
export function queryFingerprint(query: unknown): string {
  return createHash("sha256").update(JSON.stringify(query)).digest("hex").slice(0, 16);
}

/** An opaque cursor: an offset bound to one query and signed under the signing secret. */
export function issueCursor(secret: string, fingerprint: string, offset: number): string {
  const payload = `${offset}.${fingerprint}`;
  return Buffer.from(`${payload}.${mac(secret, payload).toString("hex")}`).toString("base64url");
}

/** Returns the offset of a cursor this template issued for this query, else 422 `invalid_cursor`. */
export function readCursor(secret: string, fingerprint: string, cursor: unknown): number {
  if (typeof cursor !== "string") throw invalidCursor();
  const match = /^([0-9]{1,10})\.([0-9a-f]{16})\.([0-9a-f]{64})$/.exec(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  if (!match) throw invalidCursor();
  const [, offset, issuedFor, tag] = match as unknown as [string, string, string, string];

  const expected = mac(secret, `${offset}.${issuedFor}`);
  const actual = Buffer.from(tag, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalidCursor();
  if (issuedFor !== fingerprint || Number(offset) > MAX_OFFSET) throw invalidCursor();
  return Number(offset);
}
