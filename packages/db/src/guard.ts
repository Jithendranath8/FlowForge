import type postgres from "postgres";

/*
 * Client-side deadlines for the postgres.js pool.
 *
 * Server-side `statement_timeout` cannot fire when the server (or the network to it) is
 * frozen, and postgres.js queues work indefinitely when every connection is busy. This
 * guard bounds both: a permit semaphore sized to the pool gives an acquisition timeout,
 * and every root query / transaction races a deadline. A transaction whose deadline
 * fired is forced to roll back if its callback is still running, so a caller that saw a
 * timeout never has that transaction commit afterwards (unless COMMIT itself was already
 * in flight — the irreducible ambiguity of any network timeout).
 */

export type DbTimeoutKind = "acquire" | "query" | "transaction";

export class DbTimeoutError extends Error {
  readonly code = "DB_TIMEOUT";
  constructor(
    readonly kind: DbTimeoutKind,
    readonly timeoutMs: number,
  ) {
    super(
      kind === "acquire"
        ? `Timed out after ${timeoutMs}ms waiting for a database connection`
        : `Database ${kind} exceeded ${timeoutMs}ms`,
    );
    this.name = "DbTimeoutError";
  }
}

export interface DbTimeouts {
  /** Max wait for a pooled connection before failing. */
  acquireTimeoutMs: number;
  /** Deadline for a single statement outside a transaction (includes network). */
  queryTimeoutMs: number;
  /** Deadline for a whole transaction, BEGIN through COMMIT. */
  transactionTimeoutMs: number;
}

/** FIFO counting semaphore whose acquisition can time out. */
export class Semaphore {
  private available: number;
  private readonly waiters: { grant: () => void }[] = [];

  constructor(readonly size: number) {
    this.available = size;
  }

  get inUse(): number {
    return this.size - this.available;
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(timeoutMs: number): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve(this.releaser());
        },
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new DbTimeoutError("acquire", timeoutMs));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.grant();
      else this.available += 1;
    };
  }
}

function withDeadline<T>(p: Promise<T>, ms: number, kind: DbTimeoutKind, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new DbTimeoutError(kind, ms));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type Mode = "objects" | "values" | "raw";

/** Lazy thenable mirroring the parts of a postgres.js Query that Drizzle uses. */
class GuardedQuery<T> implements PromiseLike<T> {
  private mode: Mode = "objects";
  private promise: Promise<T> | undefined;

  constructor(private readonly start: (mode: Mode) => Promise<T>) {}

  values(): this {
    this.mode = "values";
    return this;
  }

  raw(): this {
    this.mode = "raw";
    return this;
  }

  then<A = T, B = never>(onFulfilled?: ((v: T) => A | PromiseLike<A>) | null, onRejected?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    this.promise ??= this.start(this.mode);
    return this.promise.then(onFulfilled, onRejected);
  }

  catch<B = never>(onRejected?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<T | B> {
    return this.then(undefined, onRejected);
  }
}

type AnyQuery = postgres.PendingQuery<postgres.Row[]>;

function applyMode(q: AnyQuery, mode: Mode): AnyQuery {
  if (mode === "values") return q.values() as unknown as AnyQuery;
  if (mode === "raw") return q.raw() as unknown as AnyQuery;
  return q;
}

/**
 * Wrap a postgres.js client so every root query and transaction is bounded. Only `unsafe`
 * and `begin` are intercepted — the two entry points Drizzle uses. Everything else is
 * forwarded unchanged. The tagged-template call form is NOT guarded (not used by Drizzle).
 */
export function guardClient(sql: postgres.Sql, permits: Semaphore, t: DbTimeouts): postgres.Sql {
  const runQuery = (args: unknown[]) => async (mode: Mode) => {
    const release = await permits.acquire(t.acquireTimeoutMs);
    let underlying: Promise<unknown>;
    try {
      const q = (sql.unsafe as (...a: unknown[]) => AnyQuery)(...args);
      underlying = Promise.resolve(applyMode(q, mode));
    } catch (err) {
      release();
      throw err;
    }
    // The permit tracks the real connection, so it is held until the query settles,
    // even if the caller has already been told it timed out.
    underlying.then(release, release);
    return withDeadline(underlying, t.queryTimeoutMs, "query");
  };

  const begin = async (...args: unknown[]) => {
    const fn = args.pop() as (tx: postgres.TransactionSql) => unknown;
    const release = await permits.acquire(t.acquireTimeoutMs);
    const state = { expired: false };
    const wrapped = async (tx: postgres.TransactionSql) => {
      const result = await fn(guardTransaction(tx, state, t.transactionTimeoutMs));
      // The caller was already told this transaction failed: roll it back.
      if (state.expired) throw new DbTimeoutError("transaction", t.transactionTimeoutMs);
      return result;
    };
    let underlying: Promise<unknown>;
    try {
      underlying = (sql.begin as (...a: unknown[]) => Promise<unknown>)(...args, wrapped);
    } catch (err) {
      release();
      throw err;
    }
    underlying.then(release, release);
    return withDeadline(underlying, t.transactionTimeoutMs, "transaction", () => {
      state.expired = true;
    });
  };

  return new Proxy(sql, {
    get(target, prop) {
      if (prop === "unsafe") return (...args: unknown[]) => new GuardedQuery(runQuery(args));
      if (prop === "begin") return begin;
      return Reflect.get(target, prop, target);
    },
  });
}

/** Inside an expired transaction, refuse to issue further statements. */
function guardTransaction(tx: postgres.TransactionSql, state: { expired: boolean }, ms: number): postgres.TransactionSql {
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "unsafe") {
        return (...args: unknown[]) => {
          if (state.expired) return new GuardedQuery(() => Promise.reject(new DbTimeoutError("transaction", ms)));
          return (target.unsafe as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, prop, target);
    },
  });
}

const UNAVAILABLE_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "25P03", // idle_in_transaction_session_timeout
]);

/**
 * Classify an error (walking `cause`, since Drizzle wraps driver errors) as a database
 * timeout, unavailability, or neither.
 */
export function classifyDbError(err: unknown): "timeout" | "unavailable" | null {
  for (let e = err, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof DbTimeoutError) return "timeout";
    const code = (e as { code?: unknown }).code;
    if (code === "57014") return "timeout"; // query_canceled, incl. statement_timeout
    if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return "unavailable";
  }
  return null;
}
