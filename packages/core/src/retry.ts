import type { RetryPolicy } from "./definition.js";

/**
 * Exponential backoff for attempt `attempt` (1-based: the delay after the first
 * failure uses attempt = 1). `random` is injectable so tests are deterministic.
 * Jitter subtracts up to `jitter * delay`, so the result never exceeds maxDelayMs.
 */
export function computeBackoffMs(policy: RetryPolicy, attempt: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("attempt must be a positive integer");
  const raw = policy.initialDelayMs * Math.pow(policy.backoffCoefficient, attempt - 1);
  const capped = Math.min(policy.maxDelayMs, raw);
  const jitterAmount = capped * policy.jitter * clamp01(random());
  return Math.max(0, Math.round(capped - jitterAmount));
}

export type FailureKind =
  | "error" // handler threw / reported failure
  | "timeout" // attempt exceeded timeoutMs
  | "lease_expired" // worker stopped heart-beating (crash, partition)
  | "non_retryable"; // handler explicitly marked the error as permanent

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

/** `attemptsMade` counts attempts already started, including the one that just failed. */
export function decideRetry(
  policy: RetryPolicy,
  attemptsMade: number,
  kind: FailureKind,
  random: () => number = Math.random,
): RetryDecision {
  if (kind === "non_retryable") return { retry: false, delayMs: 0 };
  if (attemptsMade >= policy.maxAttempts) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: computeBackoffMs(policy, attemptsMade, random) };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
