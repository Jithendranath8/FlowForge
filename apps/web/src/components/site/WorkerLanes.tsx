import type { SimState } from "@/lib/demo-sim";
import { WORKERS } from "@/lib/demo-sim";

const OUTCOME_COLOR: Record<string, string> = {
  running: "var(--st-running)",
  succeeded: "var(--st-succeeded)",
  failed: "var(--st-failed)",
  lease_expired: "var(--st-retrying)",
};

/** Which worker ran which attempt, over time. Hatched: the worker was down. */
export function WorkerLanes({ state, span }: { state: SimState; span: number }) {
  const W = 640;
  const laneH = 30;
  const top = 6;
  const labelW = 74;
  const H = top + WORKERS.length * (laneH + 8);
  const x = (t: number) => labelW + (Math.min(t, span) / span) * (W - labelW - 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Worker timeline: which worker ran each attempt">
      <defs>
        <pattern id="ff-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--raised)" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-strong)" strokeWidth="2" />
        </pattern>
      </defs>
      {WORKERS.map((w, i) => {
        const y = top + i * (laneH + 8);
        const alive = state.workers.find((v) => v.id === w)?.alive ?? true;
        return (
          <g key={w}>
            <text x={0} y={y + laneH / 2 + 4} fontSize={12} fill={alive ? "var(--muted)" : "var(--st-failed)"} fontFamily="var(--font-mono)">
              {w}
            </text>
            <rect x={labelW} y={y} width={W - labelW - 4} height={laneH} rx={6} fill="var(--raised)" />
            {state.outages
              .filter((o) => o.worker === w)
              .map((o) => (
                <rect key={o.start} x={x(o.start)} y={y} width={Math.max(2, x(Math.min(o.end, state.tick)) - x(o.start))} height={laneH} rx={6} fill="url(#ff-hatch)" />
              ))}
            {state.attempts
              .filter((a) => a.worker === w)
              .map((a) => {
                const x1 = x(a.start);
                const x2 = x(a.end ?? state.tick);
                const width = Math.max(3, x2 - x1);
                const color = OUTCOME_COLOR[a.outcome]!;
                return (
                  <g key={`${a.task}-${a.attempt}`}>
                    <rect x={x1} y={y + 4} width={width} height={laneH - 8} rx={4} fill={`color-mix(in srgb, ${color} 18%, var(--surface))`} stroke={color} strokeWidth={1.25} />
                    {width > 46 ? (
                      <text x={x1 + 7} y={y + laneH / 2 + 4} fontSize={11} fill="var(--ink)" fontFamily="var(--font-sans)">
                        {a.task}
                        {a.attempt > 1 ? ` #${a.attempt}` : ""}
                      </text>
                    ) : null}
                  </g>
                );
              })}
          </g>
        );
      })}
      {state.run === "running" ? <line x1={x(state.tick)} x2={x(state.tick)} y1={0} y2={H} stroke="var(--ink)" strokeWidth={1} opacity={0.35} /> : null}
    </svg>
  );
}
