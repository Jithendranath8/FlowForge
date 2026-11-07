/*
 * The homepage demo: a deterministic, in-browser simulation of how FlowForge runs the
 * quick-start workflow on three workers. It follows the engine's rules (dependency
 * gating, leases renewed by heartbeats, lease expiry, retry with backoff, fencing, the
 * any_failed trigger rule) but it is a model, not telemetry: nothing here talks to a
 * FlowForge deployment, and the page says so.
 */

export type SimTaskState = "pending" | "queued" | "running" | "retry_scheduled" | "succeeded" | "failed" | "skipped";
export type AttemptOutcome = "running" | "succeeded" | "failed" | "lease_expired";

export interface SimTaskDef {
  key: string;
  dependsOn: string[];
  /** Ticks of work. */
  duration: number;
  triggerRule?: "all_succeeded" | "any_failed";
}

export const DEMO_TASKS: SimTaskDef[] = [
  { key: "extract", dependsOn: [], duration: 16 },
  { key: "clean", dependsOn: ["extract"], duration: 14 },
  { key: "enrich", dependsOn: ["extract"], duration: 20 },
  { key: "load", dependsOn: ["clean", "enrich"], duration: 12 },
  { key: "notify", dependsOn: ["extract"], duration: 6, triggerRule: "any_failed" },
];

export const WORKERS = ["worker-1", "worker-2", "worker-3"] as const;
/** Ticks a lease lasts without a heartbeat. */
export const LEASE_TICKS = 10;
/** Backoff before a retry is queued. */
export const BACKOFF_TICKS = 5;
/** Ticks a crashed worker stays down. */
export const RESTART_TICKS = 30;

export interface SimTask {
  state: SimTaskState;
  attempts: number;
  fence: number;
  worker: string | null;
  progress: number;
  leaseUntil: number;
  readyAt: number;
}

export interface SimWorker {
  id: string;
  alive: boolean;
  /** Task this worker believes it is running (kept while crashed: it lost its lease, not its memory). */
  task: string | null;
  fence: number;
  downUntil: number;
}

export interface SimAttempt {
  task: string;
  worker: string;
  attempt: number;
  fence: number;
  start: number;
  end: number | null;
  outcome: AttemptOutcome;
}

export interface SimState {
  tick: number;
  tasks: Record<string, SimTask>;
  workers: SimWorker[];
  attempts: SimAttempt[];
  log: { tick: number; text: string }[];
  /** When each stopped worker was down. */
  outages: { worker: string; start: number; end: number }[];
  /** The next attempt to finish fails instead (the visitor pressed "Fail the next attempt"). */
  failNext: boolean;
  run: "running" | "succeeded" | "failed";
}

export function initialState(): SimState {
  return {
    tick: 0,
    tasks: Object.fromEntries(DEMO_TASKS.map((t) => [t.key, { state: t.dependsOn.length ? "pending" : "queued", attempts: 0, fence: 0, worker: null, progress: 0, leaseUntil: 0, readyAt: 0 }])),
    workers: WORKERS.map((id) => ({ id, alive: true, task: null, fence: 0, downUntil: 0 })),
    attempts: [],
    log: [{ tick: 0, text: "Run submitted: extract is queued" }],
    outages: [],
    failNext: false,
    run: "running",
  };
}

const clone = (s: SimState): SimState => ({
  ...s,
  tasks: Object.fromEntries(Object.entries(s.tasks).map(([k, v]) => [k, { ...v }])),
  workers: s.workers.map((w) => ({ ...w })),
  attempts: s.attempts.map((a) => ({ ...a })),
  log: [...s.log],
  outages: s.outages.map((o) => ({ ...o })),
});

function finishAttempt(s: SimState, key: string, outcome: AttemptOutcome) {
  const t = s.tasks[key]!;
  const a = [...s.attempts].reverse().find((x) => x.task === key && x.end === null);
  if (a) {
    a.end = s.tick;
    a.outcome = outcome;
  }
  t.worker = null;
  t.progress = 0;
}

/** Dependency resolution, as the engine's advanceRun does after every change. */
function resolve(s: SimState) {
  for (const d of DEMO_TASKS) {
    const t = s.tasks[d.key]!;
    if (t.state !== "pending") continue;
    const deps = d.dependsOn.map((k) => s.tasks[k]!.state);
    const settled = deps.every((x) => x === "succeeded" || x === "failed" || x === "skipped");
    if (!settled) continue;
    const anyFailed = deps.some((x) => x === "failed");
    const allSucceeded = deps.every((x) => x === "succeeded");
    const runnable = (d.triggerRule ?? "all_succeeded") === "any_failed" ? anyFailed : allSucceeded;
    t.state = runnable ? "queued" : "skipped";
    s.log.push({ tick: s.tick, text: runnable ? `${d.key} is queued` : `${d.key} skipped (its trigger rule did not match)` });
  }
  const states = Object.values(s.tasks).map((t) => t.state);
  if (states.every((x) => x === "succeeded" || x === "failed" || x === "skipped")) {
    s.run = states.includes("failed") ? "failed" : "succeeded";
    s.log.push({ tick: s.tick, text: `Run ${s.run}` });
  }
}

/** One tick of the simulated system. */
export function step(prev: SimState): SimState {
  if (prev.run !== "running") return prev;
  const s = clone(prev);
  s.tick += 1;

  // Workers come back after a crash; a stale result from before is fenced off.
  for (const w of s.workers) {
    if (!w.alive && s.tick >= w.downUntil) {
      w.alive = true;
      if (w.task) {
        const t = s.tasks[w.task]!;
        s.log.push({ tick: s.tick, text: `${w.id} is back and reports ${w.task} (fence ${w.fence}); rejected, the current fence is ${t.fence}` });
      } else {
        s.log.push({ tick: s.tick, text: `${w.id} is back and registers again` });
      }
      w.task = null;
    }
  }

  // Running work: live workers heartbeat (renewing the lease) and make progress.
  for (const d of DEMO_TASKS) {
    const t = s.tasks[d.key]!;
    if (t.state !== "running") continue;
    const w = s.workers.find((x) => x.id === t.worker)!;
    if (w.alive) {
      t.leaseUntil = s.tick + LEASE_TICKS;
      t.progress += 1;
      if (t.progress >= d.duration) {
        if (s.failNext) {
          s.failNext = false;
          finishAttempt(s, d.key, "failed");
          t.state = "retry_scheduled";
          t.readyAt = s.tick + BACKOFF_TICKS;
          w.task = null;
          s.log.push({ tick: s.tick, text: `${d.key} attempt ${t.attempts} failed on ${w.id}; retry in ${BACKOFF_TICKS} ticks` });
        } else {
          finishAttempt(s, d.key, "succeeded");
          t.state = "succeeded";
          w.task = null;
          s.log.push({ tick: s.tick, text: `${d.key} succeeded on ${w.id}` });
        }
      }
    } else if (s.tick >= t.leaseUntil) {
      // The reaper: no heartbeat for a whole lease.
      finishAttempt(s, d.key, "lease_expired");
      t.state = "retry_scheduled";
      t.readyAt = s.tick + BACKOFF_TICKS;
      s.log.push({ tick: s.tick, text: `Lease on ${d.key} expired (${w.id} stopped heartbeating); retry in ${BACKOFF_TICKS} ticks` });
    }
  }

  for (const d of DEMO_TASKS) {
    const t = s.tasks[d.key]!;
    if (t.state === "retry_scheduled" && s.tick >= t.readyAt) {
      t.state = "queued";
      s.log.push({ tick: s.tick, text: `${d.key} is queued for attempt ${t.attempts + 1}` });
    }
  }
  resolve(s);

  // Scheduling: queued tasks, in definition order, to idle live workers.
  for (const d of DEMO_TASKS) {
    const t = s.tasks[d.key]!;
    if (t.state !== "queued") continue;
    const w = s.workers.find((x) => x.alive && x.task === null);
    if (!w) break;
    t.state = "running";
    t.attempts += 1;
    t.fence += 1;
    t.worker = w.id;
    t.leaseUntil = s.tick + LEASE_TICKS;
    w.task = d.key;
    w.fence = t.fence;
    s.attempts.push({ task: d.key, worker: w.id, attempt: t.attempts, fence: t.fence, start: s.tick, end: null, outcome: "running" });
    s.log.push({ tick: s.tick, text: `${d.key} leased to ${w.id} (attempt ${t.attempts}, fence ${t.fence})` });
  }
  return s;
}

/** The visitor stops a worker: it vanishes without a word, as a crashed process does. */
export function crashWorker(prev: SimState, id: string): SimState {
  const s = clone(prev);
  const w = s.workers.find((x) => x.id === id);
  if (!w || !w.alive || s.run !== "running") return prev;
  w.alive = false;
  w.downUntil = s.tick + RESTART_TICKS;
  s.outages.push({ worker: id, start: s.tick, end: w.downUntil });
  s.log.push({ tick: s.tick, text: `${id} stopped${w.task ? ` while running ${w.task}` : ""}` });
  return s;
}

export function armFailure(prev: SimState): SimState {
  if (prev.failNext || prev.run !== "running") return prev;
  return { ...prev, failNext: true, log: [...prev.log, { tick: prev.tick, text: "The next attempt to finish will fail" }] };
}

/** Run the simulation to the end (tests and the reduced-motion view). */
export function runToEnd(s: SimState, limit = 1_000): SimState {
  let cur = s;
  for (let i = 0; i < limit && cur.run === "running"; i++) cur = step(cur);
  return cur;
}
