import { createHmac, timingSafeEqual } from "node:crypto";

/** Requests whose timestamp is further than this from now (seconds) are rejected. */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,15}$/;

/** Lowercase hex HMAC-SHA256 of `"<timestamp>.<body>"` under `secret`. */
export function sign(secret: string, timestamp: string, body: Uint8Array | string): string {
  return createHmac("sha256", secret).update(timestamp).update(".").update(body).digest("hex");
}

export interface VerifyInput {
  secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  /** The raw request body bytes, exactly as received. */
  body: Uint8Array;
  /** Current unix time in seconds. Injectable for tests. */
  now?: number;
}

/** True only for a well-formed, fresh timestamp and a matching signature. */
export function verifySignature({ secret, timestamp, signature, body, now }: VerifyInput): boolean {
  if (!secret || !timestamp || !signature) return false;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return false;
  if (!SIGNATURE_PATTERN.test(signature)) return false;

  const current = now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(current - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(sign(secret, timestamp, body), "hex");
  const actual = Buffer.from(signature, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
