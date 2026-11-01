import type { Database } from "@flowforge/db";
import type { Logger } from "pino";
import type { Notifier } from "../infra/notifier.js";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Tx;

/** Dependencies shared by every engine module. `now` is injectable for tests. */
export interface EngineContext {
  db: Database;
  now: () => Date;
  notifier: Notifier;
  log: Logger;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  workerOfflineAfterMs: number;
  /** Optional advisory scorer (predictive scheduling). Must never throw into the engine. */
  advisor?: SchedulingAdvisor;
}

export interface SchedulingAdvisor {
  readonly modelVersion: string;
  /** Called once per claim with the candidate task types; returns per-type advice. */
  advise(tx: Tx, tenantId: string, taskTypes: string[]): Promise<Map<string, Advice>>;
}

export interface Advice {
  adjustment: number;
  predictedDurationMs: number | null;
  confidence: number;
}
