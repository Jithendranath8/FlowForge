"use client";

import { RunLink, Since } from "@/components/app/bits";
import { useLiveReload } from "@/components/app/session";
import { DataTable, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows } from "@/components/ui/kit";
import { formatDuration } from "@/lib/format";
import { useApi } from "@/lib/hooks";

interface Decision {
  id: number;
  runId: string | null;
  taskKey: string | null;
  taskType: string | null;
  workerName: string | null;
  workerId: string;
  strategy: string;
  score: number;
  advisorUsed: boolean;
  predictedDurationMs: number | null;
  confidence: number | null;
  createdAt: string;
}
interface TypeStat {
  taskType: string;
  samples: number;
  failures: number;
  meanDurationMs: number;
  stddevDurationMs: number | null;
  ewmaDurationMs: number;
  updatedAt: string;
}

export default function SchedulingPage() {
  const decisions = useApi<{ decisions: Decision[] }>("/v1/scheduling/decisions?limit=50");
  const stats = useApi<{ taskTypes: TypeStat[] }>("/v1/scheduling/stats");
  useLiveReload(decisions.reload, (e) => e.type === "task.started", 800);
  return (
    <>
      <PageHeader title="Scheduling" description="How tasks were placed, and how long each task type takes. Workers pull work: each task goes to the first eligible worker that asks, highest effective priority first (its priority, plus 1 for every 30 s it has waited, up to 50). An advisor, when enabled, can shift that by at most 10." />
      <Panel title="Task types" padded={false}>
        {stats.error ? (
          <ErrorState error={stats.error} onRetry={stats.reload} />
        ) : !stats.data ? (
          <SkeletonRows rows={3} cols={5} />
        ) : stats.data.taskTypes.length === 0 ? (
          <EmptyState title="No statistics yet">They are collected as attempts finish.</EmptyState>
        ) : (
          <DataTable
            caption="Duration statistics by task type"
            rows={stats.data.taskTypes}
            rowKey={(s) => s.taskType}
            columns={[
              { key: "type", header: "Task type", render: (s) => <span className="font-mono text-[0.8125rem]">{s.taskType}</span>, sort: (s) => s.taskType },
              { key: "n", header: "Successful attempts", render: (s) => <span className="tabular">{s.samples}</span>, sort: (s) => s.samples },
              { key: "fail", header: "Failed attempts", render: (s) => <span className="tabular">{s.failures}</span>, sort: (s) => s.failures },
              { key: "mean", header: "Mean", render: (s) => <span className="tabular">{formatDuration(s.meanDurationMs)}</span>, sort: (s) => s.meanDurationMs },
              { key: "sd", header: "Std. deviation", render: (s) => <span className="tabular text-muted">{formatDuration(s.stddevDurationMs)}</span> },
              { key: "ewma", header: "Recent (EWMA)", render: (s) => <span className="tabular">{formatDuration(s.ewmaDurationMs)}</span>, sort: (s) => s.ewmaDurationMs },
            ]}
          />
        )}
      </Panel>
      <Panel className="mt-6" title="Recent decisions" padded={false}>
        {decisions.error ? (
          <ErrorState error={decisions.error} onRetry={decisions.reload} />
        ) : !decisions.data ? (
          <SkeletonRows rows={6} cols={6} />
        ) : decisions.data.decisions.length === 0 ? (
          <EmptyState title="No scheduling decisions yet">One is recorded each time a task is leased to a worker.</EmptyState>
        ) : (
          <DataTable
            caption="Scheduling decisions"
            rows={decisions.data.decisions}
            rowKey={(d) => String(d.id)}
            columns={[
              { key: "at", header: "When", render: (d) => <Since iso={d.createdAt} /> },
              { key: "task", header: "Task", render: (d) => <span className="font-mono text-[0.8125rem]">{d.taskKey ?? "–"}</span> },
              { key: "worker", header: "Worker", render: (d) => d.workerName ?? d.workerId.slice(0, 8) },
              { key: "strategy", header: "Strategy", render: (d) => d.strategy },
              { key: "score", header: "Effective priority", render: (d) => <span className="tabular">{Number.isInteger(d.score) ? d.score : d.score.toFixed(2)}</span>, sort: (d) => d.score },
              { key: "pred", header: "Predicted", render: (d) => (d.advisorUsed ? <span className="tabular">{formatDuration(d.predictedDurationMs)} ({Math.round((d.confidence ?? 0) * 100)}% confident)</span> : <span className="text-faint">not used</span>) },
              { key: "run", header: "Run", render: (d) => (d.runId ? <RunLink id={d.runId} /> : "–") },
            ]}
          />
        )}
      </Panel>
    </>
  );
}
