import { schema } from "@flowforge/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { AppError, notFound } from "../errors.js";
import type { Executor, Tx } from "./context.js";

/*
 * Tenant quotas.
 *
 * Every quota check — and the tenant-wide running-task cap in `claimTasks` — runs while
 * holding the tenant row with FOR NO KEY UPDATE. Checks that would race (two submits
 * each seeing "one slot left") therefore serialise per tenant, so a quota can never be
 * overshot. NO KEY UPDATE (not UPDATE) is deliberate: it does not conflict with the
 * KEY SHARE locks taken by foreign-key checks, so inserting rows that reference the
 * tenant is not blocked. Lock order extends ADR-009: tenant -> run -> task.
 */

export type TenantRow = typeof schema.tenants.$inferSelect;

export const QUOTAS = {
  max_concurrency: "maxConcurrency",
  max_active_runs: "maxActiveRuns",
  max_workflows: "maxWorkflows",
  max_versions_per_workflow: "maxVersionsPerWorkflow",
  max_active_workers: "maxActiveWorkers",
} as const satisfies Record<string, keyof TenantRow>;
export type QuotaName = keyof typeof QUOTAS;

export async function lockTenant(tx: Tx, tenantId: string): Promise<TenantRow> {
  const [t] = await tx.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).for("no key update");
  if (!t) throw notFound("Tenant");
  return t;
}

export function quotaExceeded(quota: QuotaName, limit: number, usage: number): AppError {
  return new AppError(429, "quota_exceeded", `Tenant quota ${quota} (${limit}) reached`, { quota, limit, usage });
}

export async function countRunningTasks(ex: Executor, tenantId: string): Promise<number> {
  const [r] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.tenantId, tenantId), eq(schema.tasks.state, "running")));
  return r?.n ?? 0;
}

export async function countActiveRuns(ex: Executor, tenantId: string): Promise<number> {
  const [r] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.workflowRuns)
    .where(and(eq(schema.workflowRuns.tenantId, tenantId), eq(schema.workflowRuns.state, "running")));
  return r?.n ?? 0;
}

export async function countWorkflows(ex: Executor, tenantId: string): Promise<number> {
  const [r] = await ex.select({ n: sql<number>`count(*)::int` }).from(schema.workflows).where(eq(schema.workflows.tenantId, tenantId));
  return r?.n ?? 0;
}

export async function countActiveWorkers(ex: Executor, tenantId: string): Promise<number> {
  const [r] = await ex
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.workers)
    .where(and(eq(schema.workers.tenantId, tenantId), ne(schema.workers.state, "offline")));
  return r?.n ?? 0;
}

/** Limits and current usage, for operators and dashboards. */
export async function tenantQuotaReport(ex: Executor, tenantId: string) {
  const [t] = await ex.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  if (!t) throw notFound("Tenant");
  const [running, runs, workflows, workers] = await Promise.all([
    countRunningTasks(ex, tenantId),
    countActiveRuns(ex, tenantId),
    countWorkflows(ex, tenantId),
    countActiveWorkers(ex, tenantId),
  ]);
  return {
    tenant: { id: t.id, slug: t.slug, name: t.name },
    quotas: {
      max_concurrency: { limit: t.maxConcurrency, usage: running },
      max_active_runs: { limit: t.maxActiveRuns, usage: runs },
      max_workflows: { limit: t.maxWorkflows, usage: workflows },
      max_versions_per_workflow: { limit: t.maxVersionsPerWorkflow },
      max_active_workers: { limit: t.maxActiveWorkers, usage: workers },
    },
  };
}
