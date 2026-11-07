import { z } from "zod";

/**
 * Workflow definition schema. A definition is pure data: it names task *types*
 * that workers implement, never code. The API process never executes user code.
 */

export const LIMITS = {
  maxTasksPerWorkflow: 500,
  maxDependenciesPerTask: 64,
  maxRetryAttempts: 25,
  maxTimeoutMs: 24 * 60 * 60 * 1000,
  minTimeoutMs: 1_000,
  maxBackoffMs: 6 * 60 * 60 * 1000,
  maxPriority: 100,
  minPriority: -100,
} as const;

const keyPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const typePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const queuePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const capabilityPattern = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

export const TaskKey = z.string().regex(keyPattern, "must match ^[a-z0-9][a-z0-9_-]{0,63}$");
export const WorkflowName = z.string().regex(keyPattern, "must match ^[a-z0-9][a-z0-9_-]{0,63}$");
export const QueueName = z.string().regex(queuePattern, "must match ^[a-z0-9][a-z0-9_-]{0,63}$");
export const Capability = z.string().regex(capabilityPattern, "must match ^[a-z0-9][a-z0-9_.:-]{0,63}$");

export const RetryPolicySchema = z
  .object({
    /** Total attempts including the first one. 1 = no retries. */
    maxAttempts: z.number().int().min(1).max(LIMITS.maxRetryAttempts),
    initialDelayMs: z.number().int().min(0).max(LIMITS.maxBackoffMs),
    maxDelayMs: z.number().int().min(0).max(LIMITS.maxBackoffMs),
    backoffCoefficient: z.number().min(1).max(10),
    /** Fraction of the computed delay that is randomised (0 = deterministic). */
    jitter: z.number().min(0).max(1),
  })
  .refine((p) => p.maxDelayMs >= p.initialDelayMs, {
    message: "maxDelayMs must be >= initialDelayMs",
    path: ["maxDelayMs"],
  });
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffCoefficient: 2,
  jitter: 0.2,
};

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_QUEUE = "default";

/**
 * Trigger rules decide when a task becomes runnable once its dependencies are
 * terminal. They are the supported form of conditional execution.
 *  - all_succeeded: every dependency succeeded (default). Otherwise skipped.
 *  - all_done: every dependency reached a terminal state, none of them cancelled
 *    (a cancelled dependency skips it; tasks are only cancelled with their run).
 *  - any_failed: at least one dependency failed (compensation / alerting tasks).
 */
export const TriggerRule = z.enum(["all_succeeded", "all_done", "any_failed"]);
export type TriggerRule = z.infer<typeof TriggerRule>;

export const ResourceRequestSchema = z.object({
  cpu: z.number().min(0).max(256).default(1),
  memoryMb: z.number().int().min(0).max(1_048_576).default(256),
});
export type ResourceRequest = z.infer<typeof ResourceRequestSchema>;

export const TaskDefinitionSchema = z.object({
  key: TaskKey,
  /** Handler name a worker registers, e.g. "email.send". */
  type: z.string().regex(typePattern, "must match ^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$"),
  dependsOn: z.array(TaskKey).max(LIMITS.maxDependenciesPerTask).default([]),
  queue: QueueName.default(DEFAULT_QUEUE),
  priority: z.number().int().min(LIMITS.minPriority).max(LIMITS.maxPriority).default(0),
  retry: RetryPolicySchema.optional(),
  timeoutMs: z.number().int().min(LIMITS.minTimeoutMs).max(LIMITS.maxTimeoutMs).optional(),
  triggerRule: TriggerRule.default("all_succeeded"),
  resources: ResourceRequestSchema.optional(),
  requiredCapabilities: z.array(Capability).max(16).default([]),
  /** Static input. Handlers receive it as `input`, separately from the run's `runInput` (not merged). */
  input: z.record(z.string(), z.unknown()).optional(),
});
export type TaskDefinitionInput = z.input<typeof TaskDefinitionSchema>;
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;

export const WorkflowDefinitionSchema = z.object({
  name: WorkflowName,
  description: z.string().max(2_000).optional(),
  tasks: z.array(TaskDefinitionSchema).min(1).max(LIMITS.maxTasksPerWorkflow),
  defaults: z
    .object({
      retry: RetryPolicySchema.optional(),
      timeoutMs: z.number().int().min(LIMITS.minTimeoutMs).max(LIMITS.maxTimeoutMs).optional(),
      queue: QueueName.optional(),
    })
    .default({}),
  /** Max tasks of a single run executing at once. */
  maxConcurrency: z.number().int().min(1).max(1_000).default(32),
});
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinitionSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/** Task definition with every default resolved; what the engine persists per task. */
export interface ResolvedTask {
  key: string;
  type: string;
  dependsOn: string[];
  queue: string;
  priority: number;
  retry: RetryPolicy;
  timeoutMs: number;
  triggerRule: TriggerRule;
  resources: ResourceRequest;
  requiredCapabilities: string[];
  input: Record<string, unknown>;
}

export function resolveTask(def: WorkflowDefinition, task: TaskDefinition): ResolvedTask {
  return {
    key: task.key,
    type: task.type,
    dependsOn: [...new Set(task.dependsOn)],
    // compileWorkflow already gave tasks without a queue the workflow's defaults.queue.
    queue: task.queue,
    priority: task.priority,
    retry: task.retry ?? def.defaults.retry ?? DEFAULT_RETRY_POLICY,
    timeoutMs: task.timeoutMs ?? def.defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    triggerRule: task.triggerRule,
    resources: task.resources ?? { cpu: 1, memoryMb: 256 },
    requiredCapabilities: [...new Set(task.requiredCapabilities)].sort(),
    input: task.input ?? {},
  };
}
