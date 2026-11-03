/** An error that maps directly to an HTTP error response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const invalidParams = (message: string) => new ApiError(400, "invalid_params", message);

/**
 * Maps a Postgres error (by SQLSTATE) to an API error. Returns null for
 * anything that is not a 4xx-class database error; the caller then answers
 * 500 `server_error` without exposing the raw message.
 */
export function mapDbError(error: unknown): ApiError | null {
  const sqlstate = (error as { code?: unknown } | null)?.code;
  if (typeof sqlstate !== "string" || !/^[0-9A-Z]{5}$/.test(sqlstate)) return null;
  const message = error instanceof Error ? error.message : "Database error";

  if (sqlstate === "23505") return new ApiError(409, "conflict", message);
  if (sqlstate.startsWith("23")) return new ApiError(422, "constraint_violation", message);
  if (sqlstate === "42P01") return new ApiError(404, "not_found", message);
  if (sqlstate === "57014") return new ApiError(422, "timeout", message);
  if (sqlstate.startsWith("42") || sqlstate.startsWith("22")) {
    return new ApiError(422, "invalid_query", message);
  }
  return null;
}
