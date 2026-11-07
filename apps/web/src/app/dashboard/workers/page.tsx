"use client";

import { Since } from "@/components/app/bits";
import { useLiveReload } from "@/components/app/session";
import { DataTable, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows } from "@/components/ui/kit";
import { useApi } from "@/lib/hooks";
import { useNow } from "@/lib/now";
import type { WorkerRow } from "@/lib/types";

/** Health from heartbeat age: workers heartbeat every 10 s by default and go offline after 60 s of silence. */
function Health({ w }: { w: WorkerRow }) {
  const age = (useNow() - Date.parse(w.lastHeartbeatAt)) / 1000;
  const [label, color] =
    w.state === "offline" ? ["Offline", "var(--st-cancelled)"] : w.state === "draining" ? ["Draining", "var(--st-retrying)"] : age > 30 ? ["Heartbeat late", "var(--st-retrying)"] : ["Healthy", "var(--st-succeeded)"];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className="size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

export default function WorkersPage() {
  const list = useApi<{ workers: WorkerRow[] }>("/v1/workers", { refreshMs: 15_000 });
  useLiveReload(list.reload, (e) => e.type.startsWith("worker.") || e.type === "task.started" || e.type === "task.succeeded");
  return (
    <>
      <PageHeader title="Workers" description="Processes running your task handlers. A worker that stops heartbeating is marked offline and its tasks are retried elsewhere." />
      <Panel padded={false}>
        {list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : !list.data ? (
          <SkeletonRows rows={5} cols={6} />
        ) : list.data.workers.length === 0 ? (
          <EmptyState title="No workers have registered">Start a worker with the SDK and a key that has the worker scope; it registers on start.</EmptyState>
        ) : (
          <DataTable
            caption="Workers"
            rows={list.data.workers}
            rowKey={(w) => w.id}
            columns={[
              { key: "name", header: "Worker", render: (w) => <span><span className="font-medium text-ink">{w.name}</span>{w.hostname ? <span className="ml-2 text-xs text-faint">{w.hostname}</span> : null}</span>, sort: (w) => w.name },
              { key: "health", header: "Health", render: (w) => <Health w={w} />, sort: (w) => w.state },
              { key: "load", header: "Running", render: (w) => <span className="tabular">{w.running} of {w.maxConcurrency}</span>, sort: (w) => w.running / Math.max(1, w.maxConcurrency) },
              { key: "queues", header: "Queues", render: (w) => <span className="font-mono text-xs text-muted">{w.queues.join(", ")}</span> },
              { key: "types", header: "Task types", render: (w) => <span className="block max-w-[18rem] truncate font-mono text-xs text-muted" title={w.taskTypes.join(", ")}>{w.taskTypes.join(", ")}</span> },
              { key: "res", header: "Resources", render: (w) => <span className="tabular text-muted">{w.cpu} CPU, {w.memoryMb} MB</span> },
              { key: "hb", header: "Last heartbeat", render: (w) => <Since iso={w.lastHeartbeatAt} />, sort: (w) => w.lastHeartbeatAt },
              { key: "sdk", header: "SDK", render: (w) => <span className="font-mono text-xs text-faint">{w.sdkVersion ?? "–"}</span> },
            ]}
          />
        )}
      </Panel>
    </>
  );
}
