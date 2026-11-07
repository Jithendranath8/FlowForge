"use client";

import Link from "next/link";
import { useState } from "react";
import { HourlyBars } from "@/components/charts/HourlyBars";
import { ErrorState, PageHeader, Panel, Segmented } from "@/components/ui/kit";
import { formatDuration } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import type { TimeseriesBucket } from "@/lib/types";

export default function MonitoringPage() {
  const [hours, setHours] = useState<"24" | "72" | "168">("24");
  const ts = useApi<{ buckets: TimeseriesBucket[]; generatedAt: string }>(`/v1/stats/timeseries?hours=${hours}`, { refreshMs: 60_000 });
  const b = ts.data?.buckets ?? [];
  const sum = (f: (x: TimeseriesBucket) => number) => b.reduce((a, x) => a + f(x), 0);
  const attempts = sum((x) => Object.values(x.attempts).reduce((a, n) => a + (n ?? 0), 0));
  const bad = sum((x) => (x.attempts.failed ?? 0) + (x.attempts.timed_out ?? 0) + (x.attempts.lease_expired ?? 0));
  const p95s = b.map((x) => x.succeededDurationMs?.p95).filter((v): v is number => typeof v === "number");
  return (
    <>
      <PageHeader
        title="Monitoring"
        description="Throughput and outcomes for this workspace, computed from its run history. Infrastructure metrics (API latency, queues, database) are exported to Prometheus."
        actions={<Segmented<"24" | "72" | "168"> label="Time range" value={hours} onChange={setHours} options={[{ value: "24", label: "24 hours" }, { value: "72", label: "3 days" }, { value: "168", label: "7 days" }]} />}
      />
      {ts.error ? (
        <Panel><ErrorState error={ts.error} onRetry={ts.reload} /></Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-4">
            {[
              ["Runs finished", ts.data ? sum((x) => (x.runs.succeeded ?? 0) + (x.runs.failed ?? 0) + (x.runs.cancelled ?? 0)) : "–"],
              ["Task attempts", ts.data ? attempts : "–"],
              ["Attempts that failed", ts.data ? (attempts ? `${((bad / attempts) * 100).toFixed(1)}%` : "0%") : "–"],
              ["Slowest hour, p95", ts.data ? formatDuration(p95s.length ? Math.max(...p95s) : null) : "–"],
            ].map(([k, v]) => (
              <div key={String(k)} className="bg-surface px-4 py-3">
                <p className="text-sm text-muted">{k}</p>
                <p className="tabular mt-1 text-2xl font-semibold text-ink">{v}</p>
              </div>
            ))}
          </div>
          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <Panel>
              {!ts.data ? <div className="h-48 animate-pulse rounded bg-raised" /> : (
                <HourlyBars
                  title="Runs finished per hour"
                  buckets={b.map((x) => ({ start: x.start, values: x.runs as Record<string, number> }))}
                  series={[
                    { key: "succeeded", label: "Succeeded", color: "var(--st-succeeded)" },
                    { key: "failed", label: "Failed", color: "var(--st-failed)" },
                    { key: "cancelled", label: "Cancelled", color: "var(--st-cancelled)" },
                  ]}
                />
              )}
            </Panel>
            <Panel>
              {!ts.data ? <div className="h-48 animate-pulse rounded bg-raised" /> : (
                <HourlyBars
                  title="Task attempts per hour, by outcome"
                  buckets={b.map((x) => ({ start: x.start, values: x.attempts as Record<string, number> }))}
                  series={[
                    { key: "succeeded", label: "Succeeded", color: "var(--st-succeeded)" },
                    { key: "lease_expired", label: "Lease expired", color: "var(--st-retrying)" },
                    { key: "timed_out", label: "Timed out", color: "var(--st-serious)" },
                    { key: "failed", label: "Failed", color: "var(--st-failed)" },
                  ]}
                />
              )}
            </Panel>
          </div>
          <Panel className="mt-6" title="Infrastructure metrics and alerts">
            <p className="max-w-[72ch] text-sm text-muted">
              Each API instance serves Prometheus metrics on its own port (9464 by default): request latency, queue depth and age, lease expiries, database pool, Redis health and more. The repository ships a
              Grafana dashboard and 14 alert rules, 7 of them covered by promtool unit tests. See <Link href="/docs/operations" className="text-ink underline underline-offset-4">Operations</Link> to run them.
            </p>
          </Panel>
        </>
      )}
    </>
  );
}
