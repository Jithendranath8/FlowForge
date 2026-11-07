import { Writable } from "node:stream";
import { DrizzleQueryError } from "drizzle-orm/errors";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { EngineContext } from "../../src/engine/context.js";
import { buildApp } from "../../src/http/app.js";
import { logSerializers, redactUrl } from "../../src/infra/logging.js";
import { NullNotifier } from "../../src/infra/notifier.js";

/*
 * A failed query's bound parameters are tenant data (run inputs, task outputs,
 * checkpoints), and Postgres's `detail` can echo a whole row. Neither may reach logs or
 * trace exports.
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

describe("log serializers", () => {
  it("keep query parameters and row details out of log lines", () => {
    const lines: string[] = [];
    const sink = new Writable({ write: (chunk: Buffer, _e, cb) => (lines.push(chunk.toString()), cb()) });
    const log = pino({ serializers: logSerializers }, sink);
    log.error({ err: new DrizzleQueryError("select $1", [SECRET], pgError()) }, "database failure");
    log.error({ err: pgError() }, "raw driver error");
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).not.toContain(SECRET);
    expect(lines[0]).toContain("params: [redacted]");
    expect(JSON.parse(lines[1]!).err).toMatchObject({ code: "23514", type: "PostgresError" });
  });
});

describe("API error logging", () => {
  it("logs an unexpected query failure through the redacting serializers", async () => {
    const lines: string[] = [];
    const sink = new Writable({ write: (chunk: Buffer, _e, cb) => (lines.push(chunk.toString()), cb()) });
    const log = pino({ serializers: logSerializers }, sink);
    const ctx = { db: {}, now: () => new Date(), notifier: new NullNotifier(), log, leaseDurationMs: 30_000, heartbeatIntervalMs: 10_000, workerOfflineAfterMs: 60_000 } as unknown as EngineContext;
    const app = await buildApp({
      config: { MAX_PAYLOAD_BYTES: 65_536, allowedOrigins: [], NODE_ENV: "test", LOG_LEVEL: "info" },
      ctx,
      extraRoutes: async (a) => {
        a.get("/boom", async () => {
          throw new DrizzleQueryError("update tasks set output = $1", [SECRET], pgError());
        });
      },
    });
    try {
      const res = await app.inject({ method: "GET", url: "/boom" });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(SECRET);
      const logged = lines.join("");
      expect(logged).toContain("unhandled error");
      expect(logged).toContain("params: [redacted]");
      expect(logged).not.toContain(SECRET);
    } finally {
      await app.close();
    }
  });
});

describe("request logging", () => {
  it("redacts OAuth codes, state and other credentials in logged URLs, keeping the rest", () => {
    expect(redactUrl("/auth/google/callback?code=4%2F0Ab-SECRET&state=st.SIG&scope=email")).toBe("/auth/google/callback?code=[redacted]&state=[redacted]&scope=email");
    expect(redactUrl("/v1/runs?limit=25&cursor=abc")).toBe("/v1/runs?limit=25&cursor=abc");
    expect(redactUrl("/x?Token=1&api_key=2&access_token=3&id_token=4&key=5&password=6&secret=7&session=8&sig=9")).toBe(
      "/x?Token=[redacted]&api_key=[redacted]&access_token=[redacted]&id_token=[redacted]&key=[redacted]&password=[redacted]&secret=[redacted]&session=[redacted]&sig=[redacted]",
    );
    expect(redactUrl("/plain")).toBe("/plain");
    expect(redactUrl("/x?code")).toBe("/x?code");
  });

  it("the API's request log lines never carry the OAuth code or state", async () => {
    const lines: string[] = [];
    const sink = new Writable({ write: (chunk: Buffer, _e, cb) => (lines.push(chunk.toString()), cb()) });
    const log = pino({ serializers: logSerializers }, sink);
    const ctx = { db: {}, now: () => new Date(), notifier: new NullNotifier(), log, leaseDurationMs: 30_000, heartbeatIntervalMs: 10_000, workerOfflineAfterMs: 60_000 } as unknown as EngineContext;
    const app = await buildApp({
      config: { MAX_PAYLOAD_BYTES: 65_536, allowedOrigins: [], NODE_ENV: "test", LOG_LEVEL: "info" },
      ctx,
      extraRoutes: async (a) => {
        a.get("/auth/stub/callback", async () => ({ ok: true }));
      },
    });
    try {
      await app.inject({ method: "GET", url: `/auth/stub/callback?code=${SECRET}&state=${SECRET}-state` });
      const logged = lines.join("");
      expect(logged).toContain("/auth/stub/callback?code=[redacted]&state=[redacted]");
      expect(logged).not.toContain(SECRET);
    } finally {
      await app.close();
    }
  });
});
