import { isIPv6 } from "node:net";
/**
 * In-process fixed-window rate limiting.
 *
 * Kept in-house (instead of @fastify/rate-limit) because the API needs several limiters
 * applied to one request at explicitly chosen points — per client IP before
 * authentication, per authentication failure, and per credential and per tenant after
 * authentication — and that plugin runs only the first limiter hook on a request.
 *
 * Limits are per process. With N API instances the effective ceiling is N × limit;
 * a shared store is future work (docs/DECISIONS.md ADR-013).
 */

export interface LimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the current window resets. */
  resetMs: number;
}

export interface FixedWindowOptions {
  limit: number;
  windowMs: number;
  /** Cap on tracked keys, so key churn (many IPs or bogus keys) cannot grow memory. */
  maxKeys?: number;
  now?: () => number;
}

interface Window {
  start: number;
  count: number;
}

export class FixedWindowLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();

  constructor(opts: FixedWindowOptions) {
    if (!(opts.limit > 0)) throw new RangeError("limit must be > 0");
    if (!(opts.windowMs > 0)) throw new RangeError("windowMs must be > 0");
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? 50_000;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.windows.size;
  }

  /** Count one event for `key` and report whether it is within the limit. */
  hit(key: string): LimitResult {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      // Re-insert so Map order tracks recency of the window, for eviction.
      this.windows.delete(key);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      this.evict(now);
    }
    w.count += 1;
    return this.result(w, now);
  }

  /** Report the state for `key` without counting an event. */
  peek(key: string): LimitResult {
    const now = this.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) return { allowed: true, limit: this.limit, remaining: this.limit, resetMs: 0 };
    return this.result(w, now);
  }

  private result(w: Window, now: number): LimitResult {
    return {
      allowed: w.count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - w.count),
      resetMs: Math.max(0, w.start + this.windowMs - now),
    };
  }

  /**
   * Keep at most maxKeys windows: drop expired ones, then the oldest of those still
   * within their limit, and blocked ones only if nothing else is left. A blocked client
   * therefore cannot clear its own counter by flooding the limiter with other keys.
   */
  private evict(now: number) {
    if (this.windows.size <= this.maxKeys) return;
    for (const [k, w] of this.windows) {
      if (now - w.start >= this.windowMs) this.windows.delete(k);
    }
    // Map iterates in insertion order, oldest window first.
    for (const [k, w] of this.windows) {
      if (this.windows.size <= this.maxKeys) return;
      if (w.count <= this.limit) this.windows.delete(k);
    }
    for (const k of this.windows.keys()) {
      if (this.windows.size <= this.maxKeys) return;
      this.windows.delete(k);
    }
  }
}

/**
 * Parse TRUST_PROXY into Fastify's `trustProxy` option.
 * "false" (default) ignores X-Forwarded-For entirely, so clients cannot choose the IP
 * that per-IP limits key on. Behind a proxy, set a hop count or the proxy addresses.
 */
export function parseTrustProxy(value: string): boolean | string[] | ((addr: string, hop: number) => boolean) {
  const v = value.trim();
  if (v === "" || v === "false") return false;
  if (v === "true") return true;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_addr, hop) => hop < hops; // trust the nearest `hops` proxies
  }
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The key per-IP limits count a client under. IPv6 clients are keyed by their /64: a
 * single host or customer usually controls a whole /64, so per-address keys would let
 * it rotate addresses forever. IPv4-mapped IPv6 (::ffff:a.b.c.d) is keyed as IPv4.
 */
export function clientKey(ip: string): string {
  const addr = ip.split("%")[0]!; // drop an IPv6 zone id
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) return `ip:${mapped[1]}`;
  if (isIPv6(addr)) {
    const [head = "", tail] = addr.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
    return `ip6:${groups
      .slice(0, 4)
      .map((g) => parseInt(g, 16).toString(16))
      .join(":")}::/64`;
  }
  return `ip:${addr}`;
}
