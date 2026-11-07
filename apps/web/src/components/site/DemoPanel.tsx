"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DagView, type DagNodeView } from "@/components/dag/DagView";
import { Icon } from "@/components/ui/icons";
import { DEMO_TASKS, armFailure, crashWorker, initialState, runToEnd, step, type SimState } from "@/lib/demo-sim";
import type { TaskState } from "@/lib/states";
import { WorkerLanes } from "./WorkerLanes";

const TICK_MS = 140;
/** Timeline width in ticks: a clean run takes about 50; a stopped worker adds about 15. */
const SPAN = 70;

/**
 * The interactive hero: the quick-start workflow on three simulated workers. Visitors
 * can stop a worker or fail an attempt and watch the lease expire and the work move.
 * It is a simulation, labelled as one.
 */
export function DemoPanel() {
  const [state, setState] = useState<SimState>(() => initialState());
  const [playing, setPlaying] = useState(false);
  const started = useRef(false);
  const root = useRef<HTMLDivElement>(null);

  // Start once, when the demo scrolls into view; with reduced motion, show the finished run.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting && !started.current) {
        started.current = true;
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) setState(runToEnd(initialState()));
        else setPlaying(true);
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // A finished run stops the clock by itself.
  const animating = playing && state.run === "running";
  useEffect(() => {
    if (!animating) return;
    const t = setInterval(() => setState((s) => step(s)), TICK_MS);
    return () => clearInterval(t);
  }, [animating]);

  const busy = state.workers.find((w) => w.alive && w.task !== null);
  const stopWorker = useCallback(() => {
    if (busy) setState((s) => crashWorker(s, busy.id));
  }, [busy]);
  const restart = () => {
    setState(initialState());
    setPlaying(true);
  };

  const nodes: DagNodeView[] = useMemo(
    () =>
      DEMO_TASKS.map((d) => {
        const t = state.tasks[d.key]!;
        return {
          id: d.key,
          label: d.key,
          detail: t.state === "running" ? `${t.worker}, attempt ${t.attempts}` : t.attempts > 1 ? `attempt ${t.attempts}` : d.triggerRule === "any_failed" ? "runs if extract fails" : undefined,
          state: t.state as TaskState,
          dependsOn: d.dependsOn,
        };
      }),
    [state.tasks],
  );

  const recent = state.log.slice(-4).reverse();
  return (
    <div ref={root} className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface shadow-[var(--shadow-pop)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <p className="text-sm text-muted">
          <span className="font-medium text-ink">daily-report</span> on three workers
        </p>
        <p className="text-xs text-faint">Simulated in your browser, not a live system</p>
      </div>

      {/* On narrow screens the diagrams keep a readable size and scroll sideways. */}
      <div className="overflow-x-auto px-4 pt-4 pb-2">
        <div className="min-w-[540px]">
          <DagView nodes={nodes} label="Demo workflow graph" />
        </div>
      </div>
      <div className="overflow-x-auto px-4 pb-3">
        <div className="min-w-[540px]">
          <WorkerLanes state={state} span={Math.max(SPAN, state.tick + 4)} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-raised px-4 py-3">
        {state.run === "running" ? (
          <button type="button" onClick={() => setPlaying((p) => !p)} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-line-strong bg-surface px-2.5 text-sm font-medium hover:bg-canvas">
            {playing ? <Icon.pause size={14} /> : <Icon.play size={14} />}
            {playing ? "Pause" : "Play"}
          </button>
        ) : (
          <button type="button" onClick={restart} className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-line-strong bg-surface px-2.5 text-sm font-medium hover:bg-canvas">
            <Icon.reset size={14} />
            Run again
          </button>
        )}
        <button
          type="button"
          onClick={stopWorker}
          disabled={!busy || state.run !== "running"}
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-line-strong bg-surface px-2.5 text-sm font-medium hover:bg-canvas disabled:opacity-50"
        >
          <Icon.stop size={14} />
          {busy ? `Stop ${busy.id}` : "Stop a worker"}
        </button>
        <button
          type="button"
          onClick={() => setState((s) => armFailure(s))}
          disabled={state.failNext || state.run !== "running"}
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-line-strong bg-surface px-2.5 text-sm font-medium hover:bg-canvas disabled:opacity-50"
        >
          <Icon.bolt size={14} />
          {state.failNext ? "Next attempt will fail" : "Fail the next attempt"}
        </button>
        <span className="ml-auto text-sm text-muted" aria-live="polite">
          {state.run === "running" ? `Running, tick ${state.tick}` : `Run ${state.run} at tick ${state.tick}`}
        </span>
      </div>
      <ol className="space-y-1 border-t border-line px-4 py-3 text-[0.8125rem] text-muted" aria-label="What happened most recently">
        {recent.map((l, i) => (
          <li key={`${l.tick}-${i}`} className={i === 0 ? "text-ink" : undefined}>
            <span className="tabular mr-2 inline-block w-14 text-faint">t={l.tick}</span>
            {l.text}
          </li>
        ))}
      </ol>
    </div>
  );
}
