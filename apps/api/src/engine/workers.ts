import { schema } from "@flowforge/db";
import { and, eq, inArray } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";
import type { EngineContext } from "./context.js";
import { failAttempt, type WorkerRow } from "./execution.js";
import { recordEvents } from "./history.js";
import { countActiveWorkers, lockTenant, quotaExceeded } from "./quotas.js";
import { lockRun } from "./runs.js";

export interface RegisterWorkerInput {
  name: string;
  hostname?: string;
  sdkVersion?: string;
  queues: string[];
  capabilities: string[];
  taskTypes: string[];
  maxConcurrency: number;
  cpu: number;
  memoryMb: number;
}

export async function registerWorker(ctx: EngineContext, tenantId: string, input: RegisterWorkerInput) {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const tenant = await lockTenant(tx, tenantId);
    const active = await countActiveWorkers(tx, tenantId);
    if (active >= tenant.maxActiveWorkers) throw quotaExceeded("max_active_workers", tenant.maxActiveWorkers, active);
    const [w] = await tx
      .insert(schema.workers)
      .values({ tenantId, ...input, hostname: input.hostname ?? null, sdkVersion: input.sdkVersion ?? null, registeredAt: now, lastHeartbeatAt: now })
      .returning();
    await recordEvents(tx, now, [{ tenantId, type: "worker.registered", data: { workerId: w!.id, name: input.name, queues: input.queues } }]);
    return w!;
  });
}

/** Load a worker for a request, enforcing tenant ownership. */
export async function getWorker(ctx: Pick<EngineContext, "db">, tenantId: string, workerId: string): Promise<WorkerRow> {
  const [w] = await ctx.db
    .select()
    .from(schema.workers)
    .where(and(eq(schema.workers.tenantId, tenantId), eq(schema.workers.id, workerId)));
  if (!w) throw notFound("Worker");
  return w;
}

/**
 * Worker liveness heartbeat. A worker that was marked offline (missed heartbeats) must
 * re-register: its leases may already have been reassigned.
 */
export async function touchWorker(ctx: EngineContext, tenantId: string, workerId: string, draining: boolean): Promise<WorkerRow> {
  const now = ctx.now();
  const [w] = await ctx.db
    .update(schema.workers)
    .set({ lastHeartbeatAt: now, ...(draining ? { state: "draining" as const } : {}) })
    .where(and(eq(schema.workers.tenantId, tenantId), eq(schema.workers.id, workerId), inArray(schema.workers.state, ["active", "draining"])))
    .returning();
  if (!w) {
    await getWorker(ctx, tenantId, workerId); // 404 if unknown
    throw conflict("worker_offline", "Worker was marked offline; register again");
  }
  return w;
}

/**
 * Graceful shutdown. Tasks still leased to the worker are released immediately as a
 * failed attempt (kind lease_expired) so they are retried without waiting for expiry.
 */
export async function deregisterWorker(ctx: EngineContext, tenantId: string, workerId: string): Promise<{ released: number }> {
  const now = ctx.now();
  await getWorker(ctx, tenantId, workerId);
  const held = await ctx.db
    .select({ id: schema.tasks.id, runId: schema.tasks.runId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.tenantId, tenantId), eq(schema.tasks.workerId, workerId), eq(schema.tasks.state, "running")));
  let released = 0;
  for (const h of held) {
    await ctx.db.transaction(async (tx) => {
      const run = await lockRun(tx, tenantId, h.runId);
      const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, h.id)).for("update");
      if (!run || !task || task.state !== "running" || task.workerId !== workerId) return;
      await failAttempt(tx, run, task, "lease_expired", { message: "Worker shut down before completing the task", code: "worker_shutdown" }, now);
      released += 1;
    });
  }
  await ctx.db.transaction(async (tx) => {
    await tx.update(schema.workers).set({ state: "offline", stoppedAt: now }).where(eq(schema.workers.id, workerId));
    await recordEvents(tx, now, [{ tenantId, type: "worker.deregistered", data: { workerId, released } }]);
  });
  return { released };
}
