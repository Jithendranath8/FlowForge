/** Errors safe to show to clients. Anything else is reported as a generic 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Response headers to send with the error (e.g. Retry-After). */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const rateLimited = (code: string, message: string, retryAfterMs: number, details?: unknown) =>
  new AppError(429, code, message, details, { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const badRequest = (message: string, details?: unknown) => new AppError(400, "invalid_request", message, details);
export const unauthorized = () => new AppError(401, "unauthorized", "Authentication required");
export const forbidden = (message = "Not allowed") => new AppError(403, "forbidden", message);
