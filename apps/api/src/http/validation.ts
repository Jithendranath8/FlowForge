import { z } from "zod";
import { badRequest } from "../errors.js";

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw badRequest("Request validation failed", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

export const Uuid = z.uuid();
export const IdParams = z.object({ id: Uuid });
export const NameParams = z.object({ name: z.string().min(1).max(64) });

const JsonObject = z.record(z.string(), z.unknown());

export const SubmitRunBody = z.object({
  input: JsonObject.optional(),
  version: z.number().int().min(1).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  priority: z.number().int().min(-100).max(100).optional(),
});

export const ListRunsQuery = z.object({
  state: z.enum(["running", "succeeded", "failed", "cancelled"]).optional(),
  workflow: z.string().max(64).optional(),
  /** A run id, or the start of an idempotency key. */
  q: z.string().trim().min(1).max(200).optional(),
  /** By creation time. */
  order: z.enum(["desc", "asc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

/** Escape LIKE wildcards so user text matches literally. */
export const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const EventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const Name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const RegisterWorkerBody = z.object({
  name: z.string().min(1).max(100),
  hostname: z.string().max(255).optional(),
  sdkVersion: z.string().max(50).optional(),
  queues: z.array(Name).min(1).max(32),
  capabilities: z.array(z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/)).max(32).default([]),
  taskTypes: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/)).min(1).max(256),
  maxConcurrency: z.number().int().min(1).max(256),
  cpu: z.number().min(0.1).max(1024),
  memoryMb: z.number().int().min(16).max(4_194_304),
});

export const PollBody = z.object({
  freeSlots: z.number().int().min(0).max(256),
  freeCpu: z.number().min(0).max(1024),
  freeMemoryMb: z.number().int().min(0).max(4_194_304),
  waitMs: z.number().int().min(0).max(20_000).default(0),
});

export const HeartbeatBody = z.object({
  draining: z.boolean().default(false),
  active: z.array(z.object({ taskId: Uuid, fence: z.number().int().min(1) })).max(256).default([]),
});

const Fenced = z.object({ workerId: Uuid, fence: z.number().int().min(1) });
export const CompleteBody = Fenced.extend({ output: z.unknown().optional() });
export const FailBody = Fenced.extend({
  error: z.object({
    message: z.string().min(1).max(4_000),
    code: z.string().max(100).optional(),
    retryable: z.boolean().optional(),
  }),
});
export const CheckpointBody = Fenced.extend({ checkpoint: z.unknown() });

/** Keyset cursor over (createdAt desc, id desc). */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}
export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [ts, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const createdAt = new Date(ts ?? "");
  if (!id || Number.isNaN(createdAt.getTime()) || !Uuid.safeParse(id).success) throw badRequest("Invalid cursor");
  return { createdAt, id };
}
