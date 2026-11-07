/**
 * Errors from a failed query carry tenant data: Drizzle's DrizzleQueryError embeds the
 * bound parameters (run inputs, task outputs, checkpoints) in its message and stack, and
 * a Postgres error's `detail`/`where` can echo a whole row. Logs and trace exports get
 * this redacted copy, which keeps what diagnoses the failure (SQL text with placeholders,
 * the database's message and code, constraint, table, column).
 */
export function redactDbError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  if ("query" in err && "params" in err) {
    const cause = redactDbError(err.cause);
    const causeMessage = cause instanceof Error ? `\ncause: ${cause.message}` : "";
    // Same prototype (instanceof and the class name survive), but no `params`.
    const redacted = Object.create(Object.getPrototypeOf(err) as object) as Error & { query: unknown };
    const name = err.name !== "Error" ? err.name : (err.constructor?.name ?? "Error");
    const message = `Failed query: ${String(err.query)}\nparams: [redacted]${causeMessage}`;
    // The original stack starts with the unredacted message; keep only its frames.
    const frames = (err.stack ?? "").split("\n").filter((l) => /^\s+at /.test(l));
    Object.defineProperties(redacted, {
      name: { value: name, writable: true, configurable: true },
      message: { value: message, writable: true, configurable: true },
      stack: { value: [`${name}: ${message}`, ...frames].join("\n"), writable: true, configurable: true },
      query: { value: err.query, enumerable: true, writable: true, configurable: true },
      cause: { value: cause, writable: true, configurable: true },
    });
    return redacted;
  }
  if ("detail" in err || "where" in err) {
    const { detail: _detail, where: _where, ...rest } = err as Error & Record<string, unknown>;
    return Object.assign(Object.create(Object.getPrototypeOf(err) as object) as Error, rest, { name: err.name, message: err.message, stack: err.stack });
  }
  return err;
}
