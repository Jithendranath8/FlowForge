import { compileWorkflow, formatDagIssue, type WorkflowDefinitionInput } from "@flowforge/core";
import { HttpClient, type HttpOptions } from "./http.js";

export type RunState = "running" | "succeeded" | "failed" | "cancelled";
export type TaskState = "pending" | "queued" | "running" | "retry_scheduled" | "succeeded" | "failed" | "skipped" | "cancelled";

export interface Run {
  id: string;
  state: RunState;
  workflow?: string;
  version?: number;
  input: Record<string, unknown>;
  createdAt: string;
  finishedAt: string | null;
}

export interface Task {
  id: string;
  key: string;
  type: string;
  state: TaskState;
  attempts: number;
  output: unknown;
  error: { message: string; code: string } | null;
}

/**
 * Validate a workflow definition locally (same rules as the server) and return it.
 * Throws with every issue listed if the DAG is invalid.
 */
export function defineWorkflow<const T extends WorkflowDefinitionInput>(definition: T): T {
  const r = compileWorkflow(definition);
  if (!r.ok) throw new Error(`Invalid workflow "${String(definition.name)}":\n${r.issues.map((i) => `  - ${formatDagIssue(i)}`).join("\n")}`);
  return definition;
}

export interface StartRunOptions {
  input?: Record<string, unknown>;
  /** Submitting twice with the same key returns the original run. */
  idempotencyKey?: string;
  version?: number;
  priority?: number;
}

export class FlowForgeClient {
  private readonly http: HttpClient;
  constructor(opts: HttpOptions) {
    this.http = new HttpClient(opts);
  }

  registerWorkflow(definition: WorkflowDefinitionInput) {
    return this.http.request<{ workflowId: string; versionId: string; version: number; created: boolean }>("PUT", "/v1/workflows", definition);
  }

  async startRun(workflow: string, opts: StartRunOptions = {}): Promise<Run> {
    const r = await this.http.request<{ run: Run }>("POST", `/v1/workflows/${encodeURIComponent(workflow)}/runs`, opts);
    return r.run;
  }

  getRun(runId: string) {
    return this.http.request<{ run: Run; tasks: Task[] }>("GET", `/v1/runs/${encodeURIComponent(runId)}`);
  }

  listRuns(query: { state?: RunState; workflow?: string; limit?: number; cursor?: string } = {}) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return this.http.request<{ runs: Run[]; nextCursor: string | null }>("GET", `/v1/runs${qs.size ? `?${qs}` : ""}`);
  }

  async cancelRun(runId: string): Promise<Run> {
    return (await this.http.request<{ run: Run }>("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`)).run;
  }

  async retryTask(taskId: string): Promise<Task> {
    return (await this.http.request<{ task: Task }>("POST", `/v1/tasks/${encodeURIComponent(taskId)}/retry`)).task;
  }

  /** Poll until the run reaches a terminal state or the timeout elapses. */
  async waitForRun(runId: string, opts: { timeoutMs?: number; intervalMs?: number } = {}) {
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    for (;;) {
      const r = await this.getRun(runId);
      if (r.run.state !== "running") return r;
      if (Date.now() >= deadline) throw new Error(`Run ${runId} still running after ${opts.timeoutMs ?? 300_000}ms`);
      await new Promise((res) => setTimeout(res, opts.intervalMs ?? 500));
    }
  }
}
