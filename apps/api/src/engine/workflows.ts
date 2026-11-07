import { createHash } from "node:crypto";
import { compileWorkflow, formatDagIssue, type CompiledWorkflow } from "@flowforge/core";
import { schema } from "@flowforge/db";
import { and, desc, eq } from "drizzle-orm";
import { AppError, notFound } from "../errors.js";
import type { EngineContext } from "./context.js";
import { countWorkflows, lockTenant, quotaExceeded } from "./quotas.js";

export interface RegisteredVersion {
  workflowId: string;
  versionId: string;
  version: number;
  created: boolean;
}

/**
 * Validate a definition and store it as a new immutable version. Registering a
 * definition identical to an existing version returns that version (idempotent deploys).
 */
export const DEFAULT_DEFINITION_MAX_BYTES = 256 * 1024;

export async function registerWorkflow(
  ctx: EngineContext,
  tenantId: string,
  input: unknown,
  opts: { maxDefinitionBytes?: number } = {},
): Promise<RegisteredVersion> {
  const compiled = compileWorkflow(input);
  if (!compiled.ok) {
    throw new AppError(422, "invalid_workflow", "Workflow definition is invalid", {
      issues: compiled.issues.map((i) => ({ ...i, message: formatDagIssue(i) })),
    });
  }
  const def = compiled.workflow.definition;
  const canonical = canonicalJson(def);
  const maxBytes = opts.maxDefinitionBytes ?? DEFAULT_DEFINITION_MAX_BYTES;
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > maxBytes) {
    throw new AppError(413, "definition_too_large", `Workflow definition is ${bytes} bytes; the limit is ${maxBytes}`, { bytes, limit: maxBytes });
  }
  const checksum = createHash("sha256").update(canonical).digest("hex");

  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const tenant = await lockTenant(tx, tenantId);
    const [known] = await tx
      .select({ id: schema.workflows.id })
      .from(schema.workflows)
      .where(and(eq(schema.workflows.tenantId, tenantId), eq(schema.workflows.name, def.name)));
    if (!known) {
      const count = await countWorkflows(tx, tenantId);
      if (count >= tenant.maxWorkflows) throw quotaExceeded("max_workflows", tenant.maxWorkflows, count);
    }
    // Upsert the workflow row and lock it so concurrent registrations serialise.
    await tx
      .insert(schema.workflows)
      .values({ tenantId, name: def.name, description: def.description ?? null, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [schema.workflows.tenantId, schema.workflows.name] });
    const [wf] = await tx
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.tenantId, tenantId), eq(schema.workflows.name, def.name)))
      .for("update");
    if (!wf) throw new Error("workflow row missing after upsert");

    const [existing] = await tx
      .select({ id: schema.workflowVersions.id, version: schema.workflowVersions.version })
      .from(schema.workflowVersions)
      .where(and(eq(schema.workflowVersions.workflowId, wf.id), eq(schema.workflowVersions.checksum, checksum)));
    if (existing) return { workflowId: wf.id, versionId: existing.id, version: existing.version, created: false };

    // Versions are never deleted, so latestVersion is the version count.
    if (wf.latestVersion >= tenant.maxVersionsPerWorkflow) {
      throw quotaExceeded("max_versions_per_workflow", tenant.maxVersionsPerWorkflow, wf.latestVersion);
    }
    const version = wf.latestVersion + 1;
    const [row] = await tx
      .insert(schema.workflowVersions)
      .values({ tenantId, workflowId: wf.id, version, definition: def, checksum, createdAt: now })
      .returning({ id: schema.workflowVersions.id });
    await tx
      .update(schema.workflows)
      .set({ latestVersion: version, description: def.description ?? null, updatedAt: now })
      .where(eq(schema.workflows.id, wf.id));
    return { workflowId: wf.id, versionId: row!.id, version, created: true };
  });
}

export interface LoadedVersion {
  workflowId: string;
  versionId: string;
  version: number;
  compiled: CompiledWorkflow;
}

export async function loadVersion(
  ctx: Pick<EngineContext, "db">,
  tenantId: string,
  workflowName: string,
  version?: number,
): Promise<LoadedVersion> {
  const [wf] = await ctx.db
    .select()
    .from(schema.workflows)
    .where(and(eq(schema.workflows.tenantId, tenantId), eq(schema.workflows.name, workflowName)));
  if (!wf) throw notFound("Workflow");
  const conds = [eq(schema.workflowVersions.workflowId, wf.id), eq(schema.workflowVersions.tenantId, tenantId)];
  if (version !== undefined) conds.push(eq(schema.workflowVersions.version, version));
  const [v] = await ctx.db
    .select()
    .from(schema.workflowVersions)
    .where(and(...conds))
    .orderBy(desc(schema.workflowVersions.version))
    .limit(1);
  if (!v) throw notFound("Workflow version");
  const compiled = compileWorkflow(v.definition);
  // Stored definitions were validated at registration; failing here means corruption.
  if (!compiled.ok) throw new Error(`stored workflow version ${v.id} no longer compiles`);
  return { workflowId: wf.id, versionId: v.id, version: v.version, compiled: compiled.workflow };
}

/** Stable JSON with sorted keys so equal definitions hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
