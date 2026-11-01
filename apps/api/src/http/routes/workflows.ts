import { schema } from "@flowforge/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { EngineContext } from "../../engine/context.js";
import { registerWorkflow } from "../../engine/workflows.js";
import { notFound } from "../../errors.js";
import { requireScope } from "../auth.js";
import { NameParams, parse } from "../validation.js";

export function workflowRoutes(app: FastifyInstance, ctx: EngineContext) {
  /** Register (or re-register) a workflow definition. Body is the definition itself. */
  app.put("/workflows", async (req, reply) => {
    const p = requireScope(req, "workflows:write");
    const result = await registerWorkflow(ctx, p.tenantId, req.body);
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.get("/workflows", async (req) => {
    const p = requireScope(req, "read");
    const rows = await ctx.db
      .select({
        id: schema.workflows.id,
        name: schema.workflows.name,
        description: schema.workflows.description,
        latestVersion: schema.workflows.latestVersion,
        updatedAt: schema.workflows.updatedAt,
        runs: sql<number>`(select count(*)::int from workflow_runs r where r.workflow_id = ${schema.workflows.id})`,
        lastRunAt: sql<string | null>`(select max(created_at) from workflow_runs r where r.workflow_id = ${schema.workflows.id})`,
        lastRunState: sql<string | null>`(select state from workflow_runs r where r.workflow_id = ${schema.workflows.id} order by created_at desc limit 1)`,
      })
      .from(schema.workflows)
      .where(eq(schema.workflows.tenantId, p.tenantId))
      .orderBy(schema.workflows.name);
    return { workflows: rows };
  });

  app.get("/workflows/:name", async (req) => {
    const p = requireScope(req, "read");
    const { name } = parse(NameParams, req.params);
    const [wf] = await ctx.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.tenantId, p.tenantId), eq(schema.workflows.name, name)));
    if (!wf) throw notFound("Workflow");
    const versions = await ctx.db
      .select({
        id: schema.workflowVersions.id,
        version: schema.workflowVersions.version,
        checksum: schema.workflowVersions.checksum,
        createdAt: schema.workflowVersions.createdAt,
        definition: schema.workflowVersions.definition,
      })
      .from(schema.workflowVersions)
      .where(and(eq(schema.workflowVersions.tenantId, p.tenantId), eq(schema.workflowVersions.workflowId, wf.id)))
      .orderBy(desc(schema.workflowVersions.version));
    return { workflow: wf, versions };
  });
}
