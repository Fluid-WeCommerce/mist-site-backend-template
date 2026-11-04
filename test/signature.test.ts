import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../src/body.js";
import { sign, verifySignature } from "../src/signature.js";
import { NOW, SECRET, envelope, makeHandler, readJson, signedRequest } from "./helpers.js";

const VECTOR = JSON.parse(
  readFileSync(new URL("../contract/signature-vector.json", import.meta.url), "utf8"),
) as { secret: string; timestamp: string; body: string; signature: string };

const verify = (overrides: Partial<Parameters<typeof verifySignature>[0]> = {}) =>
  verifySignature({
    secret: VECTOR.secret,
    timestamp: VECTOR.timestamp,
    signature: VECTOR.signature,
    body: Buffer.from(VECTOR.body),
    now: 1_800_000_000,
    ...overrides,
  });

describe("signature module", () => {
  it("computes the pinned vector", () => {
    expect(sign(VECTOR.secret, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.signature);
  });

  it("verifies the pinned vector", () => {
    expect(verify()).toBe(true);
  });

  it("fails when one byte of the body changes", () => {
    expect(verify({ body: Buffer.from(VECTOR.body.replace('"limit":10', '"limit":11')) })).toBe(false);
  });

  it("fails when the timestamp changes", () => {
    expect(verify({ timestamp: "1800000001" })).toBe(false);
  });

  it("fails when the secret changes", () => {
    expect(verify({ secret: "whsec_backend_vector_secret2" })).toBe(false);
  });

  it("fails for missing values", () => {
    expect(verify({ timestamp: null })).toBe(false);
    expect(verify({ signature: undefined })).toBe(false);
    expect(verify({ secret: "" })).toBe(false);
  });

  it("rejects malformed signatures without comparing them", () => {
    expect(verify({ signature: VECTOR.signature.toUpperCase() })).toBe(false);
    expect(verify({ signature: VECTOR.signature.slice(2) })).toBe(false);
    expect(verify({ signature: `${VECTOR.signature}00` })).toBe(false);
  });

  it("accepts timestamps within 300 seconds and rejects beyond", () => {
    expect(verify({ now: 1_800_000_300 })).toBe(true);
    expect(verify({ now: 1_799_999_700 })).toBe(true);
    expect(verify({ now: 1_800_000_301 })).toBe(false);
    expect(verify({ now: 1_799_999_699 })).toBe(false);
  });

  it("rejects timestamps that are not all digits", () => {
    for (const timestamp of ["1800000000.5", "+1800000000", " 1800000000", "1.8e9", "0x6b49d200", "-1800000000", ""]) {
      expect(verify({ timestamp }), timestamp).toBe(false);
    }
  });
});

describe("request verification", () => {
  let pg: PGlite;
  let handle: ReturnType<typeof makeHandler>;

  beforeAll(async () => {
    pg = new PGlite();
    handle = makeHandler(pg);
  });
  afterAll(() => pg.close());

  const body = envelope("tables.list");

  it("accepts a correctly signed request", async () => {
    const response = await handle(signedRequest(body));
    expect(response.status).toBe(200);
  });

  it.each(["GET", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])(
    "answers 401 to %s",
    async (method) => {
      const response = await handle(signedRequest(body, { method }));
      expect(response.status).toBe(401);
      expect(await readJson(response)).toEqual({ error: { code: "unauthorized" } });
    },
  );

  it.each(["x-fluid-shop", "x-fluid-timestamp", "x-fluid-signature"])(
    "answers 401 when %s is missing",
    async (header) => {
      const response = await handle(signedRequest(body, { omit: [header] }));
      expect(response.status).toBe(401);
      expect(await readJson(response)).toEqual({ error: { code: "unauthorized" } });
    },
  );

  it("answers 401 for a wrong secret", async () => {
    const response = await handle(signedRequest(body, { secret: "whsec_other" }));
    expect(response.status).toBe(401);
  });

  it("answers 401 for a body changed after signing", async () => {
    const good = JSON.stringify(body);
    const response = await handle(
      signedRequest(good.replace("tables.list", "tables.lisx"), {
        signature: sign(SECRET, String(NOW), good),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("answers 401 outside the timestamp window and accepts the edges", async () => {
    expect((await handle(signedRequest(body, { timestamp: String(NOW - 301) }))).status).toBe(401);
    expect((await handle(signedRequest(body, { timestamp: String(NOW + 301) }))).status).toBe(401);
    expect((await handle(signedRequest(body, { timestamp: String(NOW - 300) }))).status).toBe(200);
    expect((await handle(signedRequest(body, { timestamp: String(NOW + 300) }))).status).toBe(200);
  });

  it("answers 401 for a timestamp that is not all digits", async () => {
    for (const timestamp of ["1800000000.0", "18e8", "-1800000000", "abc"]) {
      expect((await handle(signedRequest(body, { timestamp }))).status, timestamp).toBe(401);
    }
  });

  it("answers 413 for a body over 64 KiB, signed or not", async () => {
    const big = JSON.stringify({ ...body, padding: "x".repeat(MAX_BODY_BYTES) });
    const signed = await handle(signedRequest(big));
    expect(signed.status).toBe(413);
    expect((await readJson(signed)).error.code).toBe("invalid_request");
    const unsigned = await handle(signedRequest(big, { omit: ["x-fluid-signature"] }));
    expect(unsigned.status).toBe(413);
  });

  it("caps a body streamed without a content-length", async () => {
    const chunk = new Uint8Array(MAX_BODY_BYTES / 2 + 1);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await handle(
      new Request("https://site.example/", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
  });

  it("accepts a body of exactly 64 KiB", async () => {
    const base = JSON.stringify({ ...body, padding: "" });
    const padded = JSON.stringify({ ...body, padding: "x".repeat(MAX_BODY_BYTES - base.length) });
    expect(Buffer.byteLength(padded)).toBe(MAX_BODY_BYTES);
    expect((await handle(signedRequest(padded))).status).toBe(200);
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const response = await handle(signedRequest("not json"));
    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("invalid_request");
  });

  it("does not parse before verifying: unsigned garbage is a 401, not a 400", async () => {
    const response = await handle(signedRequest("not json", { signature: "0".repeat(64) }));
    expect(response.status).toBe(401);
  });
});
