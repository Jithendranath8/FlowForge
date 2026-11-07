import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { DbTimeoutError, Semaphore, classifyDbError, guardClient } from "../src/guard.js";

/** Minimal stand-in for the postgres.js client surface the guard touches. */
function fakeClient() {
  const calls: { query: string; mode: string }[] = [];
  const gates: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const txLog: string[] = [];
  const makeQuery = (query: string) => {
    let mode = "objects";
    let p: Promise<unknown> | undefined;
    const q = {
      values() {
        mode = "values";
        return q;
      },
      raw() {
        mode = "raw";
        return q;
      },
      then(a: (v: unknown) => unknown, b: (e: unknown) => unknown) {
        p ??= new Promise((resolve, reject) => {
          calls.push({ query, mode });
          if (query === "hang") gates.push({ resolve, reject });
          else resolve([{ query, mode }]);
        });
        return p.then(a, b);
      },
    };
    return q;
  };
  const tx = { unsafe: (query: string) => makeQuery(query) };
  const sql = {
    unsafe: (query: string) => makeQuery(query),
    async begin(fn: (t: unknown) => Promise<unknown>) {
      txLog.push("begin");
      try {
        const r = await fn(tx);
        txLog.push("commit");
        return r;
      } catch (e) {
        txLog.push("rollback");
        throw e;
      }
    },
    options: { marker: "forwarded" },
  };
  return { sql: sql as unknown as postgres.Sql, calls, gates, txLog };
}

const timeouts = { acquireTimeoutMs: 40, queryTimeoutMs: 80, transactionTimeoutMs: 80 };
const kindOf = (e: unknown) => (e instanceof DbTimeoutError ? e.kind : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Semaphore", () => {
  it("grants FIFO and times out waiters without leaking permits", async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire(50);
    const waiter = s.acquire(30).then(() => "granted", kindOf);
    expect(s.queued).toBe(1);
    expect(await waiter).toBe("acquire");
    expect(s.queued).toBe(0);
    r1();
    r1(); // double release is a no-op
    expect(s.inUse).toBe(0);
    const r2 = await s.acquire(10);
    expect(s.inUse).toBe(1);
    r2();
  });
});

describe("guardClient", () => {
  it("passes queries, modes and other properties through", async () => {
    const f = fakeClient();
    const g = guardClient(f.sql, new Semaphore(2), timeouts);
    expect(await g.unsafe("select 1")).toEqual([{ query: "select 1", mode: "objects" }]);
    expect(await g.unsafe("select 2").values()).toEqual([{ query: "select 2", mode: "values" }]);
    expect((g.options as unknown as { marker: string }).marker).toBe("forwarded");
  });

  it("fails a query that exceeds its deadline, holding the permit until it really settles", async () => {
    const f = fakeClient();
    const permits = new Semaphore(1);
    const g = guardClient(f.sql, permits, timeouts);
    const started = Date.now();
    expect(await g.unsafe("hang").then(() => "ok", kindOf)).toBe("query");
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    // The connection is still busy, so the next caller waits and times out acquiring.
    expect(permits.inUse).toBe(1);
    expect(await g.unsafe("select 1").then(() => "ok", kindOf)).toBe("acquire");
    // Once the stuck query settles, the permit returns and work proceeds.
    f.gates[0]!.resolve([]);
    await sleep(1);
    expect(permits.inUse).toBe(0);
    expect(await g.unsafe("select 1")).toHaveLength(1);
  });

  it("times out acquisition when every connection is busy", async () => {
    const f = fakeClient();
    const g = guardClient(f.sql, new Semaphore(2), timeouts);
    const a = g.unsafe("hang").then(() => "ok", kindOf);
    const b = g.unsafe("hang").then(() => "ok", kindOf);
    const started = Date.now();
    expect(await g.unsafe("select 1").then(() => "ok", kindOf)).toBe("acquire");
    expect(Date.now() - started).toBeLessThan(75);
    expect(await Promise.all([a, b])).toEqual(["query", "query"]);
    for (const gate of f.gates) gate.resolve([]);
  });

  it("rolls back a transaction whose deadline fired and refuses later statements", async () => {
    const f = fakeClient();
    const g = guardClient(f.sql, new Semaphore(1), timeouts);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let lateStatement: string | undefined;
    const result = g
      .begin(async (tx) => {
        await tx.unsafe("insert 1");
        await gate; // the transaction stalls past its deadline
        lateStatement = await (tx.unsafe("insert 2") as unknown as Promise<unknown>).then(() => "ran", kindOf);
        return "done";
      })
      .then(() => "ok", kindOf);
    expect(await result).toBe("transaction");
    release();
    await sleep(5);
    expect(lateStatement).toBe("transaction");
    expect(f.txLog).toEqual(["begin", "rollback"]);
    expect(f.calls.map((c) => c.query)).toEqual(["insert 1"]);
  });

  it("rolls back when the deadline fired during the transaction's final statement", async () => {
    const f = fakeClient();
    const g = guardClient(f.sql, new Semaphore(1), timeouts);
    const result = g.begin(async (tx) => void (await tx.unsafe("hang"))).then(() => "ok", kindOf);
    expect(await result).toBe("transaction");
    f.gates[0]!.resolve([]); // the stalled statement finally completes...
    await sleep(5);
    expect(f.txLog).toEqual(["begin", "rollback"]); // ...but the transaction must not commit
  });

  it("commits a transaction that finishes in time", async () => {
    const f = fakeClient();
    const g = guardClient(f.sql, new Semaphore(1), timeouts);
    expect(await g.begin(async (tx) => (await tx.unsafe("insert 1"), "done"))).toBe("done");
    expect(f.txLog).toEqual(["begin", "commit"]);
  });
});

describe("classifyDbError", () => {
  it("walks wrapped causes", () => {
    const wrapped = Object.assign(new Error("Failed query"), { cause: new DbTimeoutError("query", 10) });
    expect(classifyDbError(wrapped)).toBe("timeout");
    expect(classifyDbError(Object.assign(new Error("x"), { cause: { code: "57014" } }))).toBe("timeout");
    expect(classifyDbError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("unavailable");
    expect(classifyDbError(Object.assign(new Error("x"), { cause: { code: "CONNECTION_CLOSED" } }))).toBe("unavailable");
    expect(classifyDbError(new Error("syntax"))).toBeNull();
    expect(classifyDbError(Object.assign(new Error("x"), { code: "23505" }))).toBeNull();
  });
});
