import { vi } from "vitest";

/*
 * Test doubles for the browser surface the web app talks to: fetch (the API through
 * the /api proxy), EventSource (the live stream) and matchMedia. Each test installs
 * what it needs; `vi.unstubAllGlobals()` in afterEach removes them.
 */

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/**
 * Route fetch calls by "METHOD /path?query" (the /api prefix removed). An unrouted call
 * fails the test loudly rather than hanging.
 */
export function stubFetch(routes: Record<string, Handler | Response | (() => Promise<Response>)>) {
  const calls: { method: string; path: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.replace(/^\/api/, "");
    calls.push({ method, path, init });
    const route = routes[`${method} ${path}`];
    if (route === undefined) throw new Error(`unrouted fetch: ${method} ${path}`);
    if (route instanceof Response) return route.clone();
    return route(url, init);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

/** A promise you resolve later, to control the order responses arrive in. */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((ev: MessageEvent) => void)[]>();

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Server side: the connection opened. */
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  /** Server side: send one SSE message (`event: type`, `data: raw`). */
  send(type: string, data: unknown) {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: raw }));
  }

  /** The connection dropped; `closed` means the browser gave up (no retry). */
  drop(closed = false) {
    this.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.();
  }

  static latest(): FakeEventSource {
    const s = FakeEventSource.instances.at(-1);
    if (!s) throw new Error("no EventSource was opened");
    return s;
  }
}

export function stubEventSource() {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
}

/** matchMedia with fixed answers (jsdom has none); `set` flips one and notifies listeners. */
export function stubMatchMedia(initial: Record<string, boolean> = {}) {
  const state = { ...initial };
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return state[query] ?? false;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => (listeners.get(query) ?? listeners.set(query, new Set()).get(query)!).add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.get(query)?.delete(fn),
  }));
  return {
    set(query: string, matches: boolean) {
      state[query] = matches;
      for (const fn of listeners.get(query) ?? []) fn();
    },
  };
}

export const run = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "6f1d0c52-0000-4000-8000-000000000001",
  state: "succeeded",
  workflow: "etl",
  version: 1,
  priority: 0,
  createdAt: "2026-11-06T10:00:00.000Z",
  finishedAt: "2026-11-06T10:00:04.000Z",
  triggeredBy: "api-key:ci",
  idempotencyKey: null,
  ...over,
});
