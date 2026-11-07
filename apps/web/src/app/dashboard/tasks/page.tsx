"use client";

import { useState } from "react";
import { RunLink, Since } from "@/components/app/bits";
import { useLiveReload } from "@/components/app/session";
import { Button } from "@/components/ui/Button";
import { DataTable, EmptyState, ErrorState, PageHeader, Panel, Select, SkeletonRows } from "@/components/ui/kit";
import { AttemptBadge } from "@/components/ui/StatusBadge";
import { formatDuration } from "@/lib/format";
import { usePagedApi } from "@/lib/hooks";
import { ATTEMPT_OUTCOMES, ATTEMPT_STYLE } from "@/lib/states";
import type { Attempt } from "@/lib/types";

export default function TasksPage() {
  const [outcome, setOutcome] = useState("");
  const path = `/v1/attempts?limit=50${outcome ? `&outcome=${outcome}` : ""}`;
  const page = usePagedApi<Attempt>(path, "attempts");
  useLiveReload(() => {
    if (!page.extended) page.reload();
  }, (e) => e.type === "task.started" || e.type === "task.succeeded" || e.type === "task.failed" || e.type === "task.retry_scheduled");
  const { rows, cursor } = page;
  return (
    <>
      <PageHeader title="Task executions" description="Every attempt to run a task: which worker ran it, how long it took and how it ended." />
      <div className="mb-4">
        <Select label="Outcome" hideLabel className="max-w-[16rem]" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">All outcomes</option>
          {ATTEMPT_OUTCOMES.map((o) => (
            <option key={o} value={o}>{ATTEMPT_STYLE[o].label}</option>
          ))}
        </Select>
      </div>
      <Panel padded={false}>
        {page.error ? (
          <ErrorState error={page.error} onRetry={page.reload} />
        ) : !page.data ? (
          <SkeletonRows rows={8} cols={6} />
        ) : rows.length === 0 ? (
          <EmptyState title="No task executions">{outcome ? "No attempts ended this way. Choose another outcome." : "Attempts appear when workers lease tasks."}</EmptyState>
        ) : (
          <>
            <DataTable
              caption="Task executions"
              rows={rows}
              rowKey={(a) => a.id}
              columns={[
                { key: "task", header: "Task", render: (a) => <span className="font-mono text-[0.8125rem]">{a.taskKey ?? "–"}</span>, sort: (a) => a.taskKey ?? "" },
                { key: "type", header: "Type", render: (a) => <span className="font-mono text-xs text-muted">{a.taskType ?? "–"}</span> },
                { key: "attempt", header: "Attempt", render: (a) => <span className="tabular">{a.attempt}</span>, sort: (a) => a.attempt },
                { key: "outcome", header: "Outcome", render: (a) => <AttemptBadge outcome={a.outcome} />, sort: (a) => a.outcome },
                { key: "worker", header: "Worker", render: (a) => <span className="text-muted">{a.workerName ?? a.workerId.slice(0, 8)}</span> },
                { key: "started", header: "Started", render: (a) => <Since iso={a.startedAt} />, sort: (a) => a.startedAt },
                { key: "duration", header: "Duration", render: (a) => <span className="tabular text-muted">{formatDuration(a.durationMs)}</span>, sort: (a) => a.durationMs ?? -1 },
                { key: "run", header: "Run", render: (a) => <RunLink id={a.runId} /> },
                { key: "error", header: "Error", render: (a) => <span className="block max-w-[24rem] truncate text-muted" title={a.error?.message}>{a.error?.message ?? ""}</span> },
              ]}
            />
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
              <p className="text-sm text-muted">{rows.length} shown</p>
              {page.moreError ? <p className="text-sm text-st-failed">{page.moreError.message}</p> : null}
              {cursor ? (
                <Button size="sm" onClick={page.loadMore} loading={page.loadingMore}>
                  Load more
                </Button>
              ) : (
                <p className="text-sm text-faint">That is every attempt.</p>
              )}
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
