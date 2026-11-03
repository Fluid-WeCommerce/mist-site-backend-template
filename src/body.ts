/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "BodyTooLargeError";
  }
}

/** Reads the raw body, stopping as soon as it exceeds `limit` bytes. */
export async function readBody(request: Request, limit = MAX_BODY_BYTES): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > limit) {
    throw new BodyTooLargeError();
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
