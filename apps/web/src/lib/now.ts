"use client";

import { useSyncExternalStore } from "react";

/*
 * One shared clock for relative times ("2 min ago") and running durations, so they
 * keep counting without each component starting its own timer, and so render stays
 * pure (no Date.now() during render). It ticks only while something is subscribed.
 */
const TICK_MS = 1_000;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const subscribers = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  subscribers.add(onChange);
  if (!timer) {
    // Idle until now: catch up at once (React re-checks the snapshot after subscribing).
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const f of subscribers) f();
    }, TICK_MS);
  }
  return () => {
    subscribers.delete(onChange);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

const snapshot = () => now;

/** The current time in ms, updated every second while mounted. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
