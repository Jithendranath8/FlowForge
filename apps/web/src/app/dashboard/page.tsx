"use client";

import Link from "next/link";
import { HourlyBars } from "@/components/charts/HourlyBars";
import { RunDuration, RunLink, RunState_, Since, Stat } from "@/components/app/bits";
import { useLiveReload } from "@/components/app/session";
import { DataTable, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows } from "@/components/ui/kit";
import { formatRelative } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { useNow } from "@/lib/now";
import type { Overview, RunRow, TimeseriesBucket } from "@/lib/types";

export default function OverviewPage() {
  const overview = useApi<Overview>("/v1/stats/overview");
  const runs = useApi<{ runs: RunRow[] }>("/v1/runs?limit=8");
  const ts = useApi<{ buckets: TimeseriesBucket[] }>("/v1/stats/timeseries?hours=24", { refreshMs: 60_000 });
  useLiveReload(() => {
    overview.reload();
    runs.reload();
  }, (e) => e.type.startsWith("run.") || e.type.startsWith("task.") || e.type.startsWith("worker."), 600);

  const now = useNow();
  const o = overview.data;
  const queued = o?.queues.filter((q) => q.state === "queued") ?? [];
  const oldestQueued = queued.map((q) => q.oldest).filter(Boolean).sort()[0] ?? null;
  return (
    <>
      <PageHeader title="Overview" description="What is running in this workspace now, and how the last day went." />
      {overview.error ? (
        <Panel><ErrorState error={overview.error} onRetry={overview.reload} /></Panel>
      ) : (
        <div className="grid grid-cols-2 divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
          <Stat label="Running runs" value={o ? (o.runs.running ?? 0) : "–"} />
          <Stat label="Queued tasks" value={o ? queued.reduce((a, q) => a + q.n, 0) : "–"} hint={oldestQueued ? `oldest waiting ${formatRelative(oldestQueued, now).replace(" ago", "")}` : undefined} />
          <Stat label="Running tasks" value={o ? o.queues.filter((q) => q.state === "running").reduce((a, q) => a + q.n, 0) : "–"} />
          <Stat label="Active workers" value={o ? (o.workers.active ?? 0) : "–"} hint={o && (o.workers.offline ?? 0) > 0 ? `${o.workers.offline} offline` : undefined} />
          <Stat label="Open dead letters" value={o ? o.deadLetters : "–"} />
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title="Runs finished per hour (last 24 hours)">
          {ts.error ? (
            <ErrorState error={ts.error} onRetry={ts.reload} />
          ) : !ts.data ? (
            <div className="h-48 animate-pulse rounded bg-raised" />
          ) : (
            <HourlyBars
              title="Runs finished per hour"
              buckets={ts.data.buckets.map((b) => ({ start: b.start, values: b.runs as Record<string, number> }))}
              series={[
                { key: "succeeded", label: "Succeeded", color: "var(--st-succeeded)" },
                { key: "failed", label: "Failed", color: "var(--st-failed)" },
                { key: "cancelled", label: "Cancelled", color: "var(--st-cancelled)" },
              ]}
            />
          )}
        </Panel>
        <Panel title="Queues" padded={false}>
          {!o ? (
            <SkeletonRows rows={3} cols={3} />
          ) : o.queues.length === 0 ? (
            <EmptyState title="No work waiting or running">Tasks appear here while they are queued, running or waiting to retry.</EmptyState>
          ) : (
            <DataTable
              caption="Tasks by queue and state"
              rows={o.queues}
              rowKey={(q) => `${q.queue}:${q.state}`}
              columns={[
                { key: "queue", header: "Queue", render: (q) => <span className="font-mono text-[0.8125rem]">{q.queue}</span>, sort: (q) => q.queue },
                { key: "state", header: "State", render: (q) => q.state.replace("_", " ") },
                { key: "n", header: "Tasks", render: (q) => <span className="tabular">{q.n}</span>, sort: (q) => q.n },
                { key: "oldest", header: "Oldest", render: (q) => <Since iso={q.oldest} /> },
              ]}
            />
          )}
        </Panel>
      </div>

      <Panel className="mt-6" title="Recent runs" actions={<Link href="/dashboard/runs" className="text-sm text-muted hover:text-ink">All runs</Link>} padded={false}>
        {runs.error ? (
          <ErrorState error={runs.error} onRetry={runs.reload} />
        ) : !runs.data ? (
          <SkeletonRows rows={4} cols={5} />
        ) : runs.data.runs.length === 0 ? (
          <EmptyState title="No runs yet" action={<Link href="/docs/quick-start" className="text-sm text-ink underline underline-offset-4">Run the quick start</Link>}>
            Register a workflow and start a run with the SDK; it shows up here as soon as it is created.
          </EmptyState>
        ) : (
          <DataTable
            caption="Recent runs"
            rows={runs.data.runs}
            rowKey={(r) => r.id}
            columns={[
              { key: "id", header: "Run", render: (r) => <RunLink id={r.id} /> },
              { key: "wf", header: "Workflow", render: (r) => <span>{r.workflow} <span className="text-faint">v{r.version}</span></span> },
              { key: "state", header: "State", render: (r) => <RunState_ state={r.state} /> },
              { key: "created", header: "Started", render: (r) => <Since iso={r.createdAt} /> },
              { key: "duration", header: "Duration", render: (r) => <RunDuration createdAt={r.createdAt} finishedAt={r.finishedAt} /> },
            ]}
          />
        )}
      </Panel>
    </>
  );
}
