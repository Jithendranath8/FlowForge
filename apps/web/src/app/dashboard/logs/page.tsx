"use client";

import Link from "next/link";
import { RunLink, Since } from "@/components/app/bits";
import { DataTable, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows } from "@/components/ui/kit";
import { AttemptBadge } from "@/components/ui/StatusBadge";
import { useApi } from "@/lib/hooks";
import type { Attempt } from "@/lib/types";

export default function LogsPage() {
  const failed = useApi<{ attempts: Attempt[] }>("/v1/attempts?outcome=failed&limit=25");
  const timedOut = useApi<{ attempts: Attempt[] }>("/v1/attempts?outcome=timed_out&limit=25");
  const expired = useApi<{ attempts: Attempt[] }>("/v1/attempts?outcome=lease_expired&limit=25");
  const all = [...(failed.data?.attempts ?? []), ...(timedOut.data?.attempts ?? []), ...(expired.data?.attempts ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
  const error = failed.error ?? timedOut.error ?? expired.error;
  return (
    <>
      <PageHeader title="Logs" description="What FlowForge records about failures, and where your workers' own output goes." />
      <Panel title="Worker output is not collected">
        <div className="max-w-[72ch] space-y-2 text-sm text-muted">
          <p>FlowForge does not capture what your task handlers print. Send worker logs to your logging system as you would for any service.</p>
          <p>
            To connect them to FlowForge, log the task&apos;s <code className="font-mono text-ink">runId</code>, <code className="font-mono text-ink">taskId</code> and attempt from the handler context. With tracing enabled, API logs carry
            <code className="font-mono text-ink"> trace_id</code>, and each run is one trace. See <Link href="/docs/operations" className="text-ink underline underline-offset-4">Operations</Link>.
          </p>
        </div>
      </Panel>
      <Panel className="mt-6" title="Recent task errors" padded={false}>
        {error ? (
          <ErrorState error={error} onRetry={() => { failed.reload(); timedOut.reload(); expired.reload(); }} />
        ) : !failed.data || !timedOut.data || !expired.data ? (
          <SkeletonRows rows={6} cols={4} />
        ) : all.length === 0 ? (
          <EmptyState title="No failed attempts">Errors that workers report, timeouts and expired leases appear here.</EmptyState>
        ) : (
          <DataTable
            caption="Recent task errors"
            rows={all}
            rowKey={(a) => a.id}
            columns={[
              { key: "at", header: "When", render: (a) => <Since iso={a.startedAt} /> },
              { key: "task", header: "Task", render: (a) => <span className="font-mono text-[0.8125rem]">{a.taskKey}</span> },
              { key: "kind", header: "Kind", render: (a) => <AttemptBadge outcome={a.outcome} /> },
              { key: "msg", header: "Message", render: (a) => <span className="block max-w-[32rem] truncate text-ink" title={[a.error?.message, a.error?.reported ? `Handler reported: ${a.error.reported.message}` : ""].filter(Boolean).join("\n")}>{a.error?.reported ? `${a.error.message}. Handler reported: ${a.error.reported.message}` : (a.error?.message ?? "–")}</span> },
              { key: "worker", header: "Worker", render: (a) => <span className="text-muted">{a.workerName ?? a.workerId.slice(0, 8)}</span> },
              { key: "run", header: "Run", render: (a) => <RunLink id={a.runId} /> },
            ]}
          />
        )}
      </Panel>
    </>
  );
}
