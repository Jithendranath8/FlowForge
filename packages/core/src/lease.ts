/**
 * Lease and fencing model.
 *
 * When a worker claims a task the engine increments the task's `fence` and stores
 * `leaseExpiresAt`. Every subsequent heartbeat / completion must present the fence it
 * was granted. If the lease expired and the task was re-claimed, the fence has moved
 * on, so the stale worker's writes are rejected. This prevents a paused or
 * partitioned worker from overwriting results produced by the new lease owner.
 */

export interface LeaseState {
  fence: number;
  leaseExpiresAt: Date | null;
  workerId: string | null;
}

export type FenceCheck =
  | { ok: true }
  | { ok: false; reason: "stale_fence" | "lease_expired" | "not_owner" | "not_running" };

export function checkFence(
  lease: LeaseState & { running: boolean },
  presented: { fence: number; workerId: string },
  now: Date,
): FenceCheck {
  if (!lease.running) return { ok: false, reason: "not_running" };
  if (presented.fence !== lease.fence) return { ok: false, reason: "stale_fence" };
  if (presented.workerId !== lease.workerId) return { ok: false, reason: "not_owner" };
  if (lease.leaseExpiresAt === null || lease.leaseExpiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "lease_expired" };
  }
  return { ok: true };
}

export function isLeaseExpired(leaseExpiresAt: Date | null, now: Date): boolean {
  return leaseExpiresAt !== null && leaseExpiresAt.getTime() <= now.getTime();
}

/**
 * The lease is renewed by heartbeats but never extended past the attempt deadline
 * (start + timeout), so an attempt that hangs while still heart-beating times out.
 */
export function nextLeaseExpiry(now: Date, leaseDurationMs: number, attemptDeadline: Date): Date {
  return new Date(Math.min(now.getTime() + leaseDurationMs, attemptDeadline.getTime()));
}
