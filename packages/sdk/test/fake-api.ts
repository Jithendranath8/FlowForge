import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A scripted stand-in for the FlowForge API, served over real HTTP so the SDK's fetch,
 * timeout and error-mapping paths run for real. Default handlers implement the worker
 * protocol; tests override routes or push tasks.
 */

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
  headers: http.IncomingHttpHeaders;
  at: number;
}

export interface Reply {
  status?: number;
  body?: unknown;
  /** Never answer (simulates a hung server). */
  hang?: boolean;
  /** Raw text body instead of JSON. */
  raw?: string;
}

type Handler = (req: Recorded) => Reply | Promise<Reply>;

export interface FakeTask {
  taskId: string;
  runId: string;
  key: string;
  type: string;
  attempt: number;
  fence: number;
  input: Record<string, unknown>;
  runInput: Record<string, unknown>;
  checkpoint: unknown;
  timeoutMs: number;
  resources: { cpu: number; memoryMb: number };
  leaseExpiresAt: string;
  attemptDeadline: string;
  deadlineInMs?: number;
  traceparent?: string | null;
  idempotencyKey: string;
}

let seq = 0;
export function makeTask(over: Partial<FakeTask> = {}): FakeTask {
  seq += 1;
  const now = Date.now();
  return {
    taskId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    runId: "11111111-1111-4111-8111-111111111111",
    key: `t${seq}`,
    type: "job",
    attempt: 1,
    fence: 1,
    input: {},
    runInput: {},
    checkpoint: null,
    timeoutMs: 30_000,
    resources: { cpu: 1, memoryMb: 128 },
    leaseExpiresAt: new Date(now + 30_000).toISOString(),
    attemptDeadline: new Date(now + 30_000).toISOString(),
    idempotencyKey: `run:t${seq}`,
    ...over,
  };
}

export class FakeApi {
  readonly requests: Recorded[] = [];
  /** Tasks handed out by the default poll handler, in order. */
  readonly pending: FakeTask[] = [];
  /** Revocations returned (once each) by the default heartbeat handler. */
  readonly revoke: { taskId: string; reason: string }[] = [];
  private readonly routes: { method: string; path: RegExp; handler: Handler }[] = [];
  private readonly hung = new Set<http.ServerResponse>();
  private server!: http.Server;
  url = "";
  workerCount = 0;

  static async start(): Promise<FakeApi> {
    const api = new FakeApi();
    api.server = http.createServer((req, res) => void api.handle(req, res));
    await new Promise<void>((r) => api.server.listen(0, "127.0.0.1", r));
    api.url = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    return api;
  }

  /** Override a route; later registrations win. */
  on(method: string, path: RegExp, handler: Handler): this {
    this.routes.unshift({ method, path, handler });
    return this;
  }

  calls(method: string, path: RegExp): Recorded[] {
    return this.requests.filter((r) => r.method === method && path.test(r.path));
  }

  async close() {
    for (const res of this.hung) res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const rec: Recorded = { method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined, headers: req.headers, at: Date.now() };
    this.requests.push(rec);
    const route = this.routes.find((r) => r.method === rec.method && r.path.test(rec.path));
    const reply = route ? await route.handler(rec) : await this.defaults(rec);
    if (reply.hang) {
      this.hung.add(res);
      return;
    }
    if (res.destroyed) return;
    res.statusCode = reply.status ?? 200;
    if (reply.raw !== undefined) return res.end(reply.raw);
    if (reply.status === 204) return res.end();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(reply.body ?? {}));
  }

  private async defaults(r: Recorded): Promise<Reply> {
    if (r.method === "POST" && r.path === "/v1/workers") {
      this.workerCount += 1;
      return { status: 201, body: { workerId: `w-${this.workerCount}`, leaseDurationMs: 30_000, heartbeatIntervalMs: 50 } };
    }
    if (r.method === "POST" && /\/poll$/.test(r.path)) {
      const { freeSlots, waitMs } = r.body as { freeSlots: number; waitMs: number };
      if (this.pending.length === 0) await new Promise((res) => setTimeout(res, Math.min(waitMs, 30)));
      return { body: { tasks: this.pending.splice(0, freeSlots) } };
    }
    if (r.method === "POST" && /\/heartbeat$/.test(r.path)) return { body: { renewed: [], revoked: this.revoke.splice(0) } };
    if (r.method === "POST" && /\/deregister$/.test(r.path)) return { body: { released: 0 } };
    if (r.method === "POST" && /\/(complete|fail)$/.test(r.path)) return { body: { duplicate: false } };
    if (r.method === "POST" && /\/checkpoint$/.test(r.path)) return { status: 204 };
    return { status: 404, body: { error: { code: "route_not_found", message: "no route" } } };
  }
}

export async function until(cond: () => boolean, timeoutMs = 3_000, what = "condition") {
  const deadline = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
