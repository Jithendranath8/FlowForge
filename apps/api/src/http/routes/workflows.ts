import { schema } from "@flowforge/db";
import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EngineContext } from "../../engine/context.js";
import { tenantQuotaReport } from "../../engine/quotas.js";
import { registerWorkflow } from "../../engine/workflows.js";
import { badRequest, notFound } from "../../errors.js";
import { requireScope } from "../auth.js";
import { NameParams, parse } from "../validation.js";

const VersionParams = z.object({ name: z.string().min(1).max(64), version: z.coerce.number().int().min(1) });
const VersionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Opaque cursor: return versions older than this one. */
  cursor: z.string().max(20).optional(),
});

export interface WorkflowRouteOptions {
  maxDefinitionBytes?: number;
}

export function workflowRoutes(app: FastifyInstance, ctx: EngineContext, opts: WorkflowRouteOptions = {}) {
  /** Register (or re-register) a workflow definition. Body is the definition itself. */
  app.put("/workflows", async (req, reply) => {
    const p = requireScope(req, "workflows:write");
    const result = await registerWorkflow(ctx, p.tenantId, req.body, { maxDefinitionBytes: opts.maxDefinitionBytes });
    return reply.code(result.created ? 201 : 200).send(result);
  });

  /** Bounded by the tenant's max_workflows quota. */
  app.get("/workflows", async (req) => {
    const p = requireScope(req, "read");
    const rows = await ctx.db
      .select({
        id: schema.workflows.id,
        name: schema.workflows.name,
        description: schema.workflows.description,
        latestVersion: schema.workflows.latestVersion,
        updatedAt: schema.workflows.updatedAt,
        // The outer table is named in full: Drizzle renders ${schema.workflows.id} as a bare
        // "id" here, which inside the subquery would mean workflow_runs.id.
        runs: sql<number>`(select count(*)::int from workflow_runs r where r.workflow_id = "workflows"."id")`,
        lastRunAt: sql<Date | null>`(select max(r.created_at) from workflow_runs r where r.workflow_id = "workflows"."id")`.mapWith(schema.workflowRuns.createdAt),
        lastRunState: sql<string | null>`(select r.state from workflow_runs r where r.workflow_id = "workflows"."id" order by r.created_at desc limit 1)`,
      })
      .from(schema.workflows)
      .where(eq(schema.workflows.tenantId, p.tenantId))
      .orderBy(schema.workflows.name);
    return { workflows: rows };
  });

  /** The workflow with its latest definition only. Older versions: see /versions. */
  app.get("/workflows/:name", async (req) => {
    const p = requireScope(req, "read");
    const { name } = parse(NameParams, req.params);
    const wf = await findWorkflow(p.tenantId, name);
    const [latest] = await ctx.db
      .select()
      .from(schema.workflowVersions)
      .where(and(eq(schema.workflowVersions.tenantId, p.tenantId), eq(schema.workflowVersions.workflowId, wf.id)))
      .orderBy(desc(schema.workflowVersions.version))
      .limit(1);
    return { workflow: wf, latest: latest ? versionView(latest) : null };
  });

  /**
   * Version history without definitions, newest first, keyset-paginated. Each page is
   * bounded by `limit` (max 100) rows of fixed-size metadata, however large or numerous
   * the stored definitions are.
   */
  app.get("/workflows/:name/versions", async (req) => {
    const p = requireScope(req, "read");
    const { name } = parse(NameParams, req.params);
    const q = parse(VersionsQuery, req.query);
    const wf = await findWorkflow(p.tenantId, name);
    const conds: SQL[] = [eq(schema.workflowVersions.tenantId, p.tenantId), eq(schema.workflowVersions.workflowId, wf.id)];
    if (q.cursor !== undefined) {
      if (!/^\d+$/.test(q.cursor)) throw badRequest("Invalid cursor");
      conds.push(lt(schema.workflowVersions.version, Number(q.cursor)));
    }
    const rows = await ctx.db
      .select({
        id: schema.workflowVersions.id,
        version: schema.workflowVersions.version,
        checksum: schema.workflowVersions.checksum,
        createdAt: schema.workflowVersions.createdAt,
        definitionBytes: sql<number>`octet_length(${schema.workflowVersions.definition}::text)`,
      })
      .from(schema.workflowVersions)
      .where(and(...conds))
      .orderBy(desc(schema.workflowVersions.version))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return { versions: page, nextCursor: rows.length > q.limit && last ? String(last.version) : null };
  });

  /** One version's full definition. */
  app.get("/workflows/:name/versions/:version", async (req) => {
    const p = requireScope(req, "read");
    const { name, version } = parse(VersionParams, req.params);
    const wf = await findWorkflow(p.tenantId, name);
    const [v] = await ctx.db
      .select()
      .from(schema.workflowVersions)
      .where(
        and(
          eq(schema.workflowVersions.tenantId, p.tenantId),
          eq(schema.workflowVersions.workflowId, wf.id),
          eq(schema.workflowVersions.version, version),
        ),
      );
    if (!v) throw notFound("Workflow version");
    return { version: versionView(v) };
  });

  /** The caller's tenant: quota limits and current usage. */
  app.get("/tenant", async (req) => {
    const p = requireScope(req, "read");
    return tenantQuotaReport(ctx.db, p.tenantId);
  });

  async function findWorkflow(tenantId: string, name: string) {
    const [wf] = await ctx.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.tenantId, tenantId), eq(schema.workflows.name, name)));
    if (!wf) throw notFound("Workflow");
    return wf;
  }
}

function versionView(v: typeof schema.workflowVersions.$inferSelect) {
  return { id: v.id, version: v.version, checksum: v.checksum, createdAt: v.createdAt, definition: v.definition };
}
