import { schema } from "@flowforge/db";
import { observeEvents } from "../infra/metrics.js";
import type { Tx } from "./context.js";

export type EventType =
  | "run.created"
  | "run.succeeded"
  | "run.failed"
  | "run.cancelled"
  | "run.reopened"
  | "task.queued"
  | "task.started"
  | "task.succeeded"
  | "task.retry_scheduled"
  | "task.failed"
  | "task.skipped"
  | "task.cancelled"
  | "task.reopened"
  | "task.checkpointed"
  | "worker.registered"
  | "worker.offline"
  | "worker.deregistered";

export interface EventInput {
  tenantId: string;
  type: EventType;
  runId?: string | null;
  taskId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Append durable history and the matching outbox rows in the caller's transaction.
 * The outbox relay later publishes them to Redis; if the transaction rolls back, neither exists.
 *
 * `now` is the engine time of the state change (ctx.now()). It is written explicitly so
 * event timestamps share one clock with the task and run timestamps they describe; the
 * column's database default is never relied on (ADR-015).
 */
/**
 * Write history events and their outbox rows. Takes a transaction only, so an event always
 * commits together with the state change it describes (the compiler refuses ctx.db).
 */
export async function recordEvents(tx: Tx, now: Date, events: EventInput[]): Promise<void> {
  if (events.length === 0) return;
  const rows = events.map((e) => ({
    tenantId: e.tenantId,
    runId: e.runId ?? null,
    taskId: e.taskId ?? null,
    type: e.type,
    data: e.data ?? {},
    createdAt: now,
  }));
  await tx.insert(schema.events).values(rows);
  await tx.insert(schema.outbox).values(
    rows.map((r) => ({ tenantId: r.tenantId, topic: "event", payload: { type: r.type, runId: r.runId, taskId: r.taskId, data: r.data }, createdAt: now })),
  );
  observeEvents(events);
}
