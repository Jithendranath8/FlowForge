import { sql, type SQL } from "drizzle-orm";
import type { EngineContext } from "./context.js";

/*
 * Data retention (ADR-016).
 *
 * Execution history grows with every run: tasks, attempts, events, scheduling decisions
 * and outbox rows. Retention deletes what has aged out, in bounded batches, so no
 * statement or transaction grows with the backlog and a large first pass cannot pin the
 * database. Every category is independent, safe to run on several API instances at once
 * (rows are taken with SKIP LOCKED) and measured against engine time (ADR-015).
 *
 * What is never deleted: tenants, users, API keys, workflows and workflow versions, task
 * type statistics, unfinished runs, and outbox rows not yet relayed.
 */

export type RetentionContext = Pick<EngineContext, "db" | "now">;

export interface RetentionPolicy {
  /** Finished runs, with their tasks, attempts, dead letters and events (days; 0 keeps them). */
  runsDays: number;
  /** Events not tied to a run, e.g. worker registrations (days; 0 keeps them). */
  workerEventsDays: number;
  /** Per-lease scheduling decisions (days; 0 keeps them). */
  schedulingDecisionsDays: number;
  /** Workers offline for this long (days; 0 keeps them). */
  offlineWorkersDays: number;
  /** Sessions this long past expiry (days; 0 keeps them). */
  expiredSessionsDays: number;
  /** Relayed outbox rows (hours). */
  outboxHours: number;
  /** Rows per delete statement; runs are deleted batchSize/10 at a time (each carries its tasks). */
  batchSize: number;
  /** Statements per category per pass. */
  maxBatches: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  runsDays: 30,
  workerEventsDays: 30,
  schedulingDecisionsDays: 14,
  offlineWorkersDays: 7,
  expiredSessionsDays: 1,
  outboxHours: 24,
  batchSize: 500,
  maxBatches: 20,
};

export const RETENTION_CATEGORIES = [
  "runs",
  "tasks",
  "run_events",
  "worker_events",
  "scheduling_decisions",
  "offline_workers",
  "expired_sessions",
  "outbox",
] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

export interface RetentionResult {
  deleted: Record<RetentionCategory, number>;
  /** False if some category hit maxBatches: more aged-out rows remain for the next pass. */
  complete: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Delete up to maxBatches batches; complete when a batch comes back short. */
async function drain(policy: RetentionPolicy, batch: number, step: () => Promise<number>): Promise<{ n: number; complete: boolean }> {
  let n = 0;
  for (let i = 0; i < policy.maxBatches; i++) {
    const got = await step();
    n += got;
    if (got < batch) return { n, complete: true };
  }
  return { n, complete: false };
}

const count = (rows: Iterable<{ n: number }>) => Number([...rows][0]?.n ?? 0);
/** A Postgres array literal for ids read from the database (uuids), sent as one parameter. */
const uuidArray = (ids: string[]) => `{${ids.join(",")}}`;

/** One retention pass over every category. */
export async function applyRetention(ctx: RetentionContext, policy: RetentionPolicy = DEFAULT_RETENTION): Promise<RetentionResult> {
  const now = ctx.now().getTime();
  const before = (ms: number) => new Date(now - ms).toISOString();
  const deleted = Object.fromEntries(RETENTION_CATEGORIES.map((c) => [c, 0])) as Record<RetentionCategory, number>;
  let complete = true;
  const b = policy.batchSize;

  if (policy.runsDays > 0) {
    const cutoff = before(policy.runsDays * DAY);
    const runBatch = Math.max(1, Math.floor(b / 10));
    const r = await drain(policy, runBatch, () =>
      ctx.db.transaction(async (tx) => {
        // Lock order run -> task (ADR-009): runs are locked here, tasks by the deletes below.
        // A run being retried right now is locked by that request and skipped; a run
        // reopened since it finished no longer matches (finished_at is cleared).
        const runs = await tx.execute<{ id: string }>(sql`
          select r.id from workflow_runs r
          where ${deletableRun(cutoff)}
          order by r.finished_at
          limit ${runBatch}
          for update of r skip locked`);
        const ids = [...runs].map((x) => x.id);
        if (ids.length === 0) return 0;
        const arr = uuidArray(ids);
        deleted.run_events += count(
          await tx.execute<{ n: number }>(sql`with d as (delete from events where run_id = any(${arr}::uuid[]) returning 1) select count(*)::int as n from d`),
        );
        // Attempts and dead letters go with their tasks (ON DELETE CASCADE).
        deleted.tasks += count(
          await tx.execute<{ n: number }>(sql`with d as (delete from tasks where run_id = any(${arr}::uuid[]) returning 1) select count(*)::int as n from d`),
        );
        await tx.execute(sql`delete from workflow_runs where id = any(${arr}::uuid[])`);
        return ids.length;
      }),
    );
    deleted.runs = r.n;
    complete &&= r.complete;
  }

  const prune = async (category: RetentionCategory, enabled: boolean, statement: () => SQL) => {
    if (!enabled) return;
    const r = await drain(policy, b, async () => count(await ctx.db.execute<{ n: number }>(statement())));
    deleted[category] = r.n;
    complete &&= r.complete;
  };

  await prune(
    "worker_events",
    policy.workerEventsDays > 0,
    () => sql`with d as (delete from events where id in (
      select id from events where run_id is null and created_at < ${before(policy.workerEventsDays * DAY)}::timestamptz
      order by id limit ${b} for update skip locked) returning 1) select count(*)::int as n from d`,
  );
  await prune(
    "scheduling_decisions",
    policy.schedulingDecisionsDays > 0,
    () => sql`with d as (delete from scheduling_decisions where id in (
      select id from scheduling_decisions where created_at < ${before(policy.schedulingDecisionsDays * DAY)}::timestamptz
      order by created_at limit ${b} for update skip locked) returning 1) select count(*)::int as n from d`,
  );
  await prune(
    "offline_workers",
    policy.offlineWorkersDays > 0,
    () => sql`with d as (delete from workers where id in (
      select id from workers where state = 'offline' and coalesce(stopped_at, last_heartbeat_at) < ${before(policy.offlineWorkersDays * DAY)}::timestamptz
      limit ${b} for update skip locked) returning 1) select count(*)::int as n from d`,
  );
  await prune(
    "expired_sessions",
    policy.expiredSessionsDays > 0,
    () => sql`with d as (delete from sessions where id in (
      select id from sessions where expires_at < ${before(policy.expiredSessionsDays * DAY)}::timestamptz
      order by expires_at limit ${b} for update skip locked) returning 1) select count(*)::int as n from d`,
  );
  // Only relayed rows: an unpublished row is a pending wake-up, kept until the relay sends it.
  await prune(
    "outbox",
    true,
    () => sql`with d as (delete from outbox where id in (
      select id from outbox where created_at < ${before(policy.outboxHours * HOUR)}::timestamptz and published_at is not null
      order by created_at limit ${b} for update skip locked) returning 1) select count(*)::int as n from d`,
  );

  return { deleted, complete };
}

/**
 * The runs retention deletes (alias `r`): finished before the cutoff, and with no task
 * still in flight. Shared by the deletion and the backlog report so they cannot disagree.
 */
function deletableRun(cutoff: string): SQL {
  return sql`r.finished_at is not null and r.finished_at < ${cutoff}::timestamptz and r.state <> 'running'
    and not exists (select 1 from tasks inflight where inflight.run_id = r.id and inflight.state in ('pending', 'queued', 'running', 'retry_scheduled'))`;
}

/** Rows each category would delete now (for `flowforge-admin retention`); no batching limits. */
export async function retentionBacklog(ctx: RetentionContext, policy: RetentionPolicy = DEFAULT_RETENTION): Promise<Partial<Record<RetentionCategory, number>>> {
  const now = ctx.now().getTime();
  const before = (ms: number) => new Date(now - ms).toISOString();
  const q = async (s: SQL) => count(await ctx.db.execute<{ n: number }>(s));
  const out: Partial<Record<RetentionCategory, number>> = {};
  if (policy.runsDays > 0) {
    const c = before(policy.runsDays * DAY);
    out.runs = await q(sql`select count(*)::int as n from workflow_runs r where ${deletableRun(c)}`);
    out.tasks = await q(sql`select count(*)::int as n from tasks t join workflow_runs r on r.id = t.run_id where ${deletableRun(c)}`);
  }
  if (policy.workerEventsDays > 0) {
    out.worker_events = await q(sql`select count(*)::int as n from events where run_id is null and created_at < ${before(policy.workerEventsDays * DAY)}::timestamptz`);
  }
  if (policy.schedulingDecisionsDays > 0) {
    out.scheduling_decisions = await q(
      sql`select count(*)::int as n from scheduling_decisions where created_at < ${before(policy.schedulingDecisionsDays * DAY)}::timestamptz`,
    );
  }
  if (policy.offlineWorkersDays > 0) {
    out.offline_workers = await q(
      sql`select count(*)::int as n from workers where state = 'offline' and coalesce(stopped_at, last_heartbeat_at) < ${before(policy.offlineWorkersDays * DAY)}::timestamptz`,
    );
  }
  if (policy.expiredSessionsDays > 0) {
    out.expired_sessions = await q(sql`select count(*)::int as n from sessions where expires_at < ${before(policy.expiredSessionsDays * DAY)}::timestamptz`);
  }
  out.outbox = await q(
    sql`select count(*)::int as n from outbox where created_at < ${before(policy.outboxHours * HOUR)}::timestamptz and published_at is not null`,
  );
  return out;
}
