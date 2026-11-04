/** An error that maps directly to an HTTP error response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const invalidParams = (message: string, field?: string) =>
  new ApiError(422, "invalid_params", message, field === undefined ? {} : { field });

export const invalidRequest = (status: number, message: string) =>
  new ApiError(status, "invalid_request", message);

export const tableNotFound = (table: string) =>
  new ApiError(404, "table_not_found", `Table "${table}" does not exist`, { table });

export const rowNotFound = () => new ApiError(404, "row_not_found", "No row has that key");

export const invalidStatement = (message: string) =>
  new ApiError(422, "invalid_statement", message);

// Connection loss and server shutdown or overload: Neon is not answering.
const UNAVAILABLE_CLASSES = ["08", "53", "57", "58"];
const UNAVAILABLE_NETWORK_CODES = ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"];

function isUnavailable(error: unknown, sqlstate: string | undefined): boolean {
  if (sqlstate && UNAVAILABLE_CLASSES.some((c) => sqlstate.startsWith(c))) return true;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof cause?.code === "string" && UNAVAILABLE_NETWORK_CODES.includes(cause.code)) return true;
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

/**
 * Maps any error thrown while running an operation to the plan's error table.
 * Postgres messages are returned for 4xx (it is the site owner's own
 * database); 5xx answers never carry the raw message.
 */
export function toApiError(error: unknown, operation: string): ApiError {
  if (error instanceof ApiError) return error;

  const raw = (error as { code?: unknown } | null)?.code;
  const sqlstate = typeof raw === "string" && /^[0-9A-Z]{5}$/.test(raw) ? raw : undefined;
  const message = error instanceof Error ? error.message : "Database error";
  const details = { sqlstate };

  if (sqlstate) {
    if (sqlstate === "23505" || sqlstate === "23503") return new ApiError(409, "conflict", message, details);
    if (sqlstate.startsWith("23")) return new ApiError(422, "constraint_violation", message, details);
    if (sqlstate === "42P01") return new ApiError(404, "table_not_found", message, details);
    if (sqlstate === "57014") return new ApiError(422, "statement_timeout", message, details);
    if (sqlstate === "42601") return new ApiError(422, "invalid_statement", message, details);
    if (sqlstate.startsWith("42") || sqlstate.startsWith("22")) {
      // In sql.run the statement is at fault; in a row operation a column or value is.
      const code = operation === "sql.run" ? "invalid_statement" : "invalid_params";
      return new ApiError(422, code, message, details);
    }
  }
  if (isUnavailable(error, sqlstate)) {
    return new ApiError(503, "database_unavailable", "The database is not available");
  }
  return new ApiError(500, "internal_error", "Internal error");
}
