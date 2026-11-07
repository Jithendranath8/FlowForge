import type { AttemptOutcome, RunState, TaskState } from "./states";

/* Response shapes of the FlowForge API endpoints the dashboard reads. */

export interface RunRow {
  id: string;
  state: RunState;
  workflow: string;
  version: number;
  priority: number;
  createdAt: string;
  finishedAt: string | null;
  triggeredBy: string;
  idempotencyKey: string | null;
}

export interface TaskSummary {
  id: string;
  key: string;
  type: string;
  state: TaskState;
  queue: string;
  priority: number;
  triggerRule: string;
  dependsOn: string[];
  attempts: number;
  timeoutMs: number;
  workerId: string | null;
  enqueuedAt: string | null;
  availableAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  leaseExpiresAt: string | null;
  error: { message: string; code?: string; kind?: string; attempt?: number } | null;
  output: unknown;
  outputTruncated: boolean;
  outputBytes: number | null;
  createdAt: string;
}

export interface RunDetail {
  run: RunRow & { input: Record<string, unknown>; cancelledAt: string | null; maxConcurrency: number; traceContext: string | null };
  tasks: TaskSummary[];
}

export interface Attempt {
  id: string;
  taskId: string;
  runId: string;
  attempt: number;
  fence?: number;
  workerId: string;
  workerName?: string | null;
  taskKey?: string | null;
  taskType?: string | null;
  outcome: AttemptOutcome;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** `reported`: the handler's own error, when the API had already ended the attempt (lease expiry, timeout). */
  error: { message: string; code?: string; reported?: { message: string; code?: string | null } } | null;
}

export interface EventRow {
  id: number;
  runId: string | null;
  taskId: string | null;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface WorkerRow {
  id: string;
  name: string;
  hostname: string | null;
  sdkVersion: string | null;
  state: "active" | "draining" | "offline";
  queues: string[];
  capabilities: string[];
  taskTypes: string[];
  maxConcurrency: number;
  cpu: number;
  memoryMb: number;
  registeredAt: string;
  lastHeartbeatAt: string;
  running: number;
}

export interface Overview {
  runs: Partial<Record<RunState, number>>;
  queues: { queue: string; state: string; n: number; oldest: string | null }[];
  workers: Partial<Record<"active" | "draining" | "offline", number>>;
  deadLetters: number;
  generatedAt: string;
}

export interface TimeseriesBucket {
  start: string;
  runs: Partial<Record<"succeeded" | "failed" | "cancelled", number>>;
  attempts: Partial<Record<Attempt["outcome"], number>>;
  succeededDurationMs: { p50: number | null; p95: number | null } | null;
}

export interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  latestVersion: number;
  updatedAt: string;
}

export interface WorkflowTaskDef {
  key: string;
  type: string;
  dependsOn?: string[];
  queue?: string;
  triggerRule?: string;
  timeoutMs?: number;
  retry?: { maxAttempts: number };
}
