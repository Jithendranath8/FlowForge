import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { redactDbError } from "../src/redact.js";

/*
 * A failed query's bound parameters are tenant data (run inputs, task outputs,
 * checkpoints), and Postgres's `detail` can echo a whole row. The API logs and exports
 * traces only through this redaction (apps/api/test/unit/redaction.test.ts).
 */

const SECRET = "SECRET-TASK-OUTPUT-7f3a";

/** Shaped like postgres.js's PostgresError (a subclass with enumerable backend fields). */
class PostgresError extends Error {
  override name = "PostgresError";
}
function pgError() {
  return Object.assign(new PostgresError("new row for relation \"tasks\" violates check constraint \"x\""), {
    code: "23514",
    severity: "ERROR",
    constraint_name: "x",
    table_name: "tasks",
    detail: `Failing row contains (${SECRET}).`,
    where: `SQL statement with ${SECRET}`,
  });
}

describe("redactDbError", () => {
  it("drops a Drizzle query error's parameters and the cause's row detail, keeping what diagnoses it", () => {
    const err = new DrizzleQueryError("update tasks set output = $1 where id = $2", [JSON.stringify({ card: SECRET }), "t1"], pgError());
    expect(err.message + err.stack).toContain(SECRET); // what Drizzle produces on its own
    const r = redactDbError(err) as Error & { cause: Record<string, unknown> };
    const all = JSON.stringify({ message: r.message, stack: r.stack, cause: r.cause, keys: Object.keys(r) });
    expect(all).not.toContain(SECRET);
    expect(r).toBeInstanceOf(DrizzleQueryError);
    expect(r.name).toBe("DrizzleQueryError");
    expect(r).not.toHaveProperty("params");
    expect(r.message).toMatch(/^Failed query: update tasks set output = \$1 where id = \$2\nparams: \[redacted\]\ncause: new row for relation/);
    expect(r.stack).toMatch(/\n {4}at /); // the frames survive
    expect(r.cause).toMatchObject({ name: "PostgresError", code: "23514", constraint_name: "x", table_name: "tasks" });
    expect(r.cause).not.toHaveProperty("detail");
  });

  it("leaves other errors untouched", () => {
    const plain = new Error("boom");
    expect(redactDbError(plain)).toBe(plain);
    expect(redactDbError("text")).toBe("text");
  });
});

