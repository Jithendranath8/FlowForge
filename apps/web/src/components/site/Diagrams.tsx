/* Static explanatory diagrams for the homepage. Real architecture, no fabricated numbers. */

function Box({ x, y, w, h, title, lines, accent }: { x: number; y: number; w: number; h: number; title: string; lines: string[]; accent?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={w} height={h} rx={10} fill="var(--surface)" stroke={accent ? "var(--ember)" : "var(--line-strong)"} strokeWidth={accent ? 1.5 : 1} />
      <text x={14} y={24} fontSize={14} fontWeight={600} fill="var(--ink)" fontFamily="var(--font-sans)">
        {title}
      </text>
      {lines.map((l, i) => (
        <text key={l} x={14} y={46 + i * 18} fontSize={12} fill="var(--muted)" fontFamily="var(--font-sans)">
          {l}
        </text>
      ))}
    </g>
  );
}

function Arrow({ d, label, lx, ly, dashed }: { d: string; label?: string; lx?: number; ly?: number; dashed?: boolean }) {
  return (
    <g>
      <path d={d} fill="none" stroke="var(--faint)" strokeWidth={1.25} strokeDasharray={dashed ? "4 4" : undefined} markerEnd="url(#ff-arrow)" />
      {label ? (
        <text x={lx} y={ly} fontSize={11} fill="var(--muted)" fontFamily="var(--font-sans)">
          {label}
        </text>
      ) : null}
    </g>
  );
}

export function ArchitectureDiagram() {
  return (
    <svg viewBox="0 0 880 340" className="h-auto w-full" role="img" aria-labelledby="arch-title arch-desc">
      <title id="arch-title">FlowForge architecture</title>
      <desc id="arch-desc">
        Your code and the dashboard call the FlowForge API over HTTP. API instances are stateless and keep all state in PostgreSQL. Redis carries wake-ups only. Workers long-poll the API for leased tasks and report results.
      </desc>
      <defs>
        <marker id="ff-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--faint)" />
        </marker>
      </defs>
      <Box x={0} y={30} w={200} h={92} title="Your services" lines={["SDK: register workflows,", "start and watch runs"]} />
      <Box x={0} y={160} w={200} h={92} title="Dashboard" lines={["Sign-in, runs, workers,", "live updates"]} />
      <Box x={340} y={60} w={200} h={150} title="API (any number)" lines={["Validates DAGs, leases tasks,", "fences results, reaps", "expired leases, retries"]} accent />
      <Box x={680} y={40} w={200} h={92} title="PostgreSQL" lines={["Source of truth: runs, tasks,", "attempts, events"]} />
      <Box x={680} y={160} w={200} h={72} title="Redis" lines={["Wake-ups only"]} />
      <Box x={340} y={252} w={200} h={72} title="Workers (any number)" lines={["Run your task handlers"]} />
      <Arrow d="M200 92 H 334" label="HTTPS" lx={246} ly={84} />
      <Arrow d="M200 196 H 334" label="HTTPS, live events" lx={214} ly={188} />
      <Arrow d="M540 92 H 674" label="transactions" lx={572} ly={84} />
      <Arrow d="M540 196 H 674" label="publish wake-ups" lx={560} ly={188} dashed />
      <Arrow d="M440 248 V 216" label="long-poll, heartbeat, report" lx={450} ly={238} />
    </svg>
  );
}

/** A worker dies mid-task; its lease expires; another worker takes the task with a newer fence. */
export function RecoveryTimeline() {
  const lane = (y: number, name: string) => (
    <g>
      <text x={0} y={y + 21} fontSize={14} fill="var(--muted)" className="font-mono">
        {name}
      </text>
      <rect x={96} y={y} width={644} height={32} rx={6} fill="var(--raised)" />
    </g>
  );
  const label = (x: number, y: number, text: string, color = "var(--ink)") => (
    <text x={x} y={y} fontSize={13} fill={color} className="font-sans">
      {text}
    </text>
  );
  return (
    <svg viewBox="0 0 760 150" className="h-auto w-full" role="img" aria-labelledby="rec-title rec-desc">
      <title id="rec-title">Recovering from a crashed worker</title>
      <desc id="rec-desc">
        Worker A leases a task with fence 1 and crashes. Its lease expires and the task is retried on worker B with fence 2. When worker A comes back and reports a result for fence 1, the API rejects it.
      </desc>
      <defs>
        <pattern id="rec-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="var(--raised)" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-strong)" strokeWidth="2" />
        </pattern>
      </defs>
      {lane(16, "worker A")}
      {lane(70, "worker B")}
      <rect x={102} y={20} width={150} height={24} rx={4} fill="color-mix(in srgb, var(--st-retrying) 18%, var(--surface))" stroke="var(--st-retrying)" />
      {label(110, 37, "attempt 1, fence 1")}
      <rect x={252} y={16} width={268} height={32} rx={6} fill="url(#rec-hatch)" />
      {label(264, 37, "crashed: no heartbeats", "var(--muted)")}
      <rect x={430} y={74} width={260} height={24} rx={4} fill="color-mix(in srgb, var(--st-succeeded) 18%, var(--surface))" stroke="var(--st-succeeded)" />
      {label(438, 91, "attempt 2, fence 2: succeeds")}
      <line x1={402} x2={402} y1={8} y2={112} stroke="var(--st-failed)" strokeDasharray="3 3" />
      {label(410, 128, "lease expires", "var(--st-failed)")}
      <rect x={528} y={20} width={150} height={24} rx={4} fill="var(--surface)" stroke="var(--st-failed)" strokeDasharray="3 2" />
      {label(536, 37, "late result: fence 1", "var(--st-failed)")}
    </svg>
  );
}
