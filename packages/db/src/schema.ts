import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Tenant isolation: every tenant-owned table carries tenant_id, and child tables
 * reference parents through composite (tenant_id, id) foreign keys so a row can never
 * point at another tenant's parent, even if application code passes a wrong id.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

export const memberRole = pgEnum("member_role", ["owner", "admin", "member", "viewer"]);
export const oauthProvider = pgEnum("oauth_provider", ["google", "github"]);
export const runState = pgEnum("run_state", ["running", "succeeded", "failed", "cancelled"]);
export const taskState = pgEnum("task_state", [
  "pending",
  "queued",
  "running",
  "retry_scheduled",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
]);
export const triggerRule = pgEnum("trigger_rule", ["all_succeeded", "all_done", "any_failed"]);
export const attemptOutcome = pgEnum("attempt_outcome", [
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "lease_expired",
  "cancelled",
]);
export const workerState = pgEnum("worker_state", ["active", "draining", "offline"]);

// ---------------------------------------------------------------- identity

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  // Quotas. Enforced under a tenant row lock (see ADR-013), so concurrent requests
  // cannot overshoot them. Change with `flowforge-admin set-quota`.
  /** Max tasks running at once across the tenant. */
  maxConcurrency: integer("max_concurrency").notNull().default(256),
  /** Max workflow runs in state `running`. */
  maxActiveRuns: integer("max_active_runs").notNull().default(500),
  maxWorkflows: integer("max_workflows").notNull().default(200),
  maxVersionsPerWorkflow: integer("max_versions_per_workflow").notNull().default(200),
  /** Max registered workers not marked offline. */
  maxActiveWorkers: integer("max_active_workers").notNull().default(100),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email"),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    createdAt: createdAt(),
  },
  // One user per email (case-insensitive): sign-in links identities by verified email,
  // and concurrent first sign-ins must not create two users (ADR-018).
  (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)],
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: oauthProvider("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("oauth_accounts_provider_account_uq").on(t.provider, t.providerAccountId)],
);

export const memberships = pgTable(
  "memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] }), index("memberships_user_idx").on(t.userId)],
);

/** Browser sessions. `id` is the SHA-256 of the cookie token; the raw token is never stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeTenantId: uuid("active_tenant_id").references(() => tenants.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

/** API keys for SDK clients and workers. Stored as SHA-256 hash; `prefix` is shown in the UI. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    lastUsedAt: ts("last_used_at"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("api_keys_tenant_idx").on(t.tenantId)],
);

// ---------------------------------------------------------------- workflows

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    latestVersion: integer("latest_version").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("workflows_tenant_name_uq").on(t.tenantId, t.name), unique("workflows_tenant_id_uq").on(t.tenantId, t.id)],
);

/** Immutable, validated definitions. Re-registering an identical definition returns the existing version. */
export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    workflowId: uuid("workflow_id").notNull(),
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull(),
    checksum: text("checksum").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.workflowId], foreignColumns: [workflows.tenantId, workflows.id] }).onDelete("cascade"),
    unique("workflow_versions_version_uq").on(t.workflowId, t.version),
    unique("workflow_versions_checksum_uq").on(t.workflowId, t.checksum),
    unique("workflow_versions_tenant_id_uq").on(t.tenantId, t.id),
  ],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    workflowId: uuid("workflow_id").notNull(),
    workflowVersionId: uuid("workflow_version_id").notNull(),
    state: runState("state").notNull().default("running"),
    input: jsonb("input").notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    maxConcurrency: integer("max_concurrency").notNull(),
    priority: integer("priority").notNull().default(0),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
    cancelledAt: ts("cancelled_at"),
    triggeredBy: text("triggered_by").notNull(),
    /** W3C traceparent active when the run was created: the run's trace (ADR-017). Null with tracing off. */
    traceContext: text("trace_context"),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.workflowId], foreignColumns: [workflows.tenantId, workflows.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.tenantId, t.workflowVersionId], foreignColumns: [workflowVersions.tenantId, workflowVersions.id] }),
    unique("workflow_runs_tenant_id_uq").on(t.tenantId, t.id),
    uniqueIndex("workflow_runs_idempotency_uq")
      .on(t.tenantId, t.workflowId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("workflow_runs_tenant_created_idx").on(t.tenantId, t.createdAt.desc()),
    index("workflow_runs_tenant_state_idx").on(t.tenantId, t.state),
    // Retention: finished runs, oldest first (ADR-016).
    index("workflow_runs_finished_idx").on(t.finishedAt).where(sql`${t.finishedAt} is not null`),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    runId: uuid("run_id").notNull(),
    key: text("key").notNull(),
    type: text("type").notNull(),
    state: taskState("state").notNull().default("pending"),
    queue: text("queue").notNull(),
    priority: integer("priority").notNull(),
    triggerRule: triggerRule("trigger_rule").notNull(),
    dependsOn: text("depends_on").array().notNull(),
    retryPolicy: jsonb("retry_policy").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    cpu: doublePrecision("cpu").notNull(),
    memoryMb: integer("memory_mb").notNull(),
    requiredCapabilities: text("required_capabilities").array().notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    error: jsonb("error"),
    attempts: integer("attempts").notNull().default(0),
    /** Attempts made before the latest manual retry; the retry policy counts from here. */
    retryBaseAttempts: integer("retry_base_attempts").notNull().default(0),
    /** Fencing token: incremented on every lease grant. */
    fence: bigint("fence", { mode: "number" }).notNull().default(0),
    workerId: uuid("worker_id"),
    leaseExpiresAt: ts("lease_expires_at"),
    attemptDeadline: ts("attempt_deadline"),
    enqueuedAt: ts("enqueued_at"),
    /** retry_scheduled tasks become queued at this time. */
    availableAt: ts("available_at"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    checkpoint: jsonb("checkpoint"),
    checkpointAt: ts("checkpoint_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.runId], foreignColumns: [workflowRuns.tenantId, workflowRuns.id] }).onDelete("cascade"),
    unique("tasks_run_key_uq").on(t.runId, t.key),
    unique("tasks_tenant_id_uq").on(t.tenantId, t.id),
    index("tasks_claim_idx")
      .on(t.tenantId, t.queue, t.priority.desc(), t.enqueuedAt)
      .where(sql`${t.state} = 'queued'`),
    // The claim's longest-waiting lane (apps/api/src/engine/execution.ts).
    index("tasks_aging_idx").on(t.tenantId, t.enqueuedAt).where(sql`${t.state} = 'queued'`),
    index("tasks_lease_idx").on(t.leaseExpiresAt).where(sql`${t.state} = 'running'`),
    index("tasks_retry_idx").on(t.availableAt).where(sql`${t.state} = 'retry_scheduled'`),
    index("tasks_run_idx").on(t.runId),
    index("tasks_tenant_state_idx").on(t.tenantId, t.state),
  ],
);

export const taskAttempts = pgTable(
  "task_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    taskId: uuid("task_id").notNull(),
    runId: uuid("run_id").notNull(),
    attempt: integer("attempt").notNull(),
    fence: bigint("fence", { mode: "number" }).notNull(),
    workerId: uuid("worker_id").notNull(),
    outcome: attemptOutcome("outcome").notNull().default("running"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
    durationMs: integer("duration_ms"),
    error: jsonb("error"),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.taskId], foreignColumns: [tasks.tenantId, tasks.id] }).onDelete("cascade"),
    unique("task_attempts_task_attempt_uq").on(t.taskId, t.attempt),
    index("task_attempts_worker_idx").on(t.workerId, t.startedAt.desc()),
    // Dashboard throughput over time (GET /v1/stats/timeseries).
    index("task_attempts_tenant_finished_idx").on(t.tenantId, t.finishedAt).where(sql`${t.finishedAt} is not null`),
  ],
);

/** Dead-letter queue: tasks that exhausted retries or failed permanently. */
export const deadLetters = pgTable(
  "dead_letters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    taskId: uuid("task_id").notNull(),
    runId: uuid("run_id").notNull(),
    reason: text("reason").notNull(),
    attempts: integer("attempts").notNull(),
    lastError: jsonb("last_error"),
    createdAt: createdAt(),
    resolvedAt: ts("resolved_at"),
    resolution: text("resolution"),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId, t.taskId], foreignColumns: [tasks.tenantId, tasks.id] }).onDelete("cascade"),
    index("dead_letters_open_idx").on(t.tenantId, t.createdAt.desc()).where(sql`${t.resolvedAt} is null`),
    // Serves the cascade from tasks when retention deletes runs.
    index("dead_letters_task_idx").on(t.taskId),
  ],
);

// ---------------------------------------------------------------- workers

export const workers = pgTable(
  "workers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hostname: text("hostname"),
    sdkVersion: text("sdk_version"),
    queues: text("queues").array().notNull(),
    capabilities: text("capabilities").array().notNull(),
    taskTypes: text("task_types").array().notNull(),
    maxConcurrency: integer("max_concurrency").notNull(),
    cpu: doublePrecision("cpu").notNull(),
    memoryMb: integer("memory_mb").notNull(),
    state: workerState("state").notNull().default("active"),
    registeredAt: ts("registered_at").notNull().defaultNow(),
    lastHeartbeatAt: ts("last_heartbeat_at").notNull().defaultNow(),
    stoppedAt: ts("stopped_at"),
  },
  (t) => [index("workers_tenant_state_idx").on(t.tenantId, t.state), index("workers_heartbeat_idx").on(t.lastHeartbeatAt)],
);

// ---------------------------------------------------------------- events

/** Durable, append-only execution history (audit trail of every state transition). */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    runId: uuid("run_id"),
    taskId: uuid("task_id"),
    type: text("type").notNull(),
    data: jsonb("data").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("events_run_idx").on(t.runId, t.id), index("events_tenant_idx").on(t.tenantId, t.id.desc())],
);

/**
 * Transactional outbox. Written in the same transaction as the state change it
 * describes; a relay publishes rows to Redis (worker wake-ups, live UI updates) and
 * marks them published. Losing Redis never loses the event.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
    publishedAt: ts("published_at"),
    /**
     * A relay claims rows by setting this, then publishes with no transaction open. A
     * relay that dies mid-publish leaves rows reclaimable once the claim lapses.
     */
    relayClaimedUntil: ts("relay_claimed_until"),
  },
  (t) => [index("outbox_unpublished_idx").on(t.id).where(sql`${t.publishedAt} is null`), index("outbox_created_idx").on(t.createdAt)],
);

// ---------------------------------------------------------------- scheduling intelligence

/** Online statistics per task type used by the predictive scheduler. */
export const taskTypeStats = pgTable(
  "task_type_stats",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    taskType: text("task_type").notNull(),
    samples: integer("samples").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    meanDurationMs: doublePrecision("mean_duration_ms").notNull().default(0),
    m2DurationMs: doublePrecision("m2_duration_ms").notNull().default(0),
    ewmaDurationMs: doublePrecision("ewma_duration_ms").notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.taskType] })],
);

export const schedulingDecisions = pgTable(
  "scheduling_decisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    taskId: uuid("task_id").notNull(),
    workerId: uuid("worker_id").notNull(),
    strategy: text("strategy").notNull(),
    score: doublePrecision("score").notNull(),
    advisorUsed: boolean("advisor_used").notNull().default(false),
    predictedDurationMs: doublePrecision("predicted_duration_ms"),
    confidence: doublePrecision("confidence"),
    modelVersion: text("model_version"),
    createdAt: createdAt(),
  },
  (t) => [index("scheduling_decisions_tenant_idx").on(t.tenantId, t.id.desc()), index("scheduling_decisions_created_idx").on(t.createdAt)],
);
