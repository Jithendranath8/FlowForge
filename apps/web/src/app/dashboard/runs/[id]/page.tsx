"use client";

import Link from "next/link";
import { use, useMemo, useState } from "react";
import { DagView, type DagNodeView } from "@/components/dag/DagView";
import { RunDuration, RunState_, Since } from "@/components/app/bits";
import { useLiveReload, useSession } from "@/components/app/session";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/icons";
import { DataTable, Dialog, EmptyState, ErrorState, JsonView, KeyValue, PageHeader, Panel, SkeletonRows } from "@/components/ui/kit";
import { AttemptBadge, StatusBadge } from "@/components/ui/StatusBadge";
import { ApiError, api } from "@/lib/api";
import { formatDateTime, formatDuration, shortId } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import type { Attempt, EventRow, RunDetail, TaskSummary } from "@/lib/types";

function TaskInspector({ task, runState, onChanged }: { task: TaskSummary; runState: string; onChanged: () => void }) {
  const { can } = useSession();
  const detail = useApi<{ task: TaskSummary & { input: unknown; checkpoint: unknown; output: unknown }; attempts: Attempt[] }>(`/v1/tasks/${task.id}`);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Follow this task's own events (attempts, outputs); the run view follows the run's.
  useLiveReload(detail.reload, (e) => e.taskId === task.id, 250);

  const retry = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/v1/tasks/${task.id}/retry`, { method: "POST" });
      setConfirm(false);
      onChanged();
      detail.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const canRetry = task.state === "failed" && runState !== "cancelled" && can("write");
  const d = detail.data;
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono">{task.key}</span>
          <StatusBadge state={task.state} size="xs" />
        </span>
      }
      actions={
        canRetry ? (
          <Button size="sm" onClick={() => setConfirm(true)}>
            <Icon.retry size={14} />
            Retry task
          </Button>
        ) : null
      }
    >
      <KeyValue
        items={[
          ["Type", <span key="t" className="font-mono text-[0.8125rem]">{task.type}</span>],
          ["Queue", <span key="q" className="font-mono text-[0.8125rem]">{task.queue}</span>],
          ["Attempts", task.attempts],
          ["Depends on", task.dependsOn.length ? task.dependsOn.join(", ") : "nothing"],
          ["Trigger rule", task.triggerRule.replaceAll("_", " ")],
          ["Timeout", formatDuration(task.timeoutMs)],
          ["Started", formatDateTime(task.startedAt)],
          ["Finished", formatDateTime(task.finishedAt)],
        ]}
      />
      {task.error ? (
        <div className="mt-4">
          <h3 className="mb-1 text-sm font-semibold text-ink">Last error</h3>
          <p className="rounded-[var(--radius-control)] border px-3 py-2 text-sm text-ink" style={{ borderColor: "color-mix(in srgb, var(--st-failed) 40%, transparent)" }}>
            {task.error.message}
            {task.error.code ? <span className="ml-2 font-mono text-xs text-muted">{task.error.code}</span> : null}
          </p>
        </div>
      ) : null}
      <h3 className="mt-5 mb-2 text-sm font-semibold text-ink">Attempts</h3>
      {detail.error ? (
        <ErrorState error={detail.error} onRetry={detail.reload} />
      ) : !d ? (
        <SkeletonRows rows={2} cols={4} />
      ) : d.attempts.length === 0 ? (
        <p className="text-sm text-muted">Not leased to a worker yet.</p>
      ) : (
        <ol className="space-y-2">
          {d.attempts.map((a) => (
            <li key={a.id} className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-ink">Attempt {a.attempt}</span>
                <AttemptBadge outcome={a.outcome} />
                <span className="tabular text-muted">{formatDuration(a.durationMs)}</span>
                <span className="text-xs text-faint">{a.workerName ?? <span className="font-mono">worker {shortId(a.workerId)}</span>}</span>
              </div>
              {a.error ? <p className="mt-1 text-muted">{a.error.message}</p> : null}
              {a.error?.reported ? (
                <p className="mt-1 text-muted">
                  <span className="text-faint">Handler reported: </span>
                  {a.error.reported.message}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {d ? (
        <div className="mt-5 space-y-4">
          <div>
            <h3 className="mb-1 text-sm font-semibold text-ink">Output</h3>
            <JsonView value={d.task.output ?? null} label={`Output of ${task.key}`} />
          </div>
          {d.task.checkpoint !== null && d.task.checkpoint !== undefined ? (
            <div>
              <h3 className="mb-1 text-sm font-semibold text-ink">Last checkpoint</h3>
              <JsonView value={d.task.checkpoint} label={`Checkpoint of ${task.key}`} />
            </div>
          ) : null}
          <div>
            <h3 className="mb-1 text-sm font-semibold text-ink">Input</h3>
            <JsonView value={d.task.input} label={`Input of ${task.key}`} />
          </div>
        </div>
      ) : null}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Retry ${task.key}?`}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Keep it failed</Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void retry()}>Retry task</Button>
          </>
        }
      >
        <p>The task goes back to the queue with a fresh retry budget. Tasks that were skipped because it failed are re-opened, and the run continues.</p>
        {err ? <p role="alert" className="mt-3 text-st-failed">{err}</p> : null}
      </Dialog>
    </Panel>
  );
}

export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  // Encoded once: a crafted link must not be able to aim this page's requests (including
  // "Cancel run") at another API path with "../" or "?".
  const id = encodeURIComponent(use(params).id);
  const { can } = useSession();
  const run = useApi<RunDetail>(`/v1/runs/${id}`);
  const events = useApi<{ events: EventRow[] }>(`/v1/runs/${id}/events?limit=500`);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  useLiveReload(() => {
    run.reload();
    events.reload();
  }, (e) => e.runId === id, 250);

  const tasks = run.data?.tasks;
  // Until the visitor picks a task, show the one most worth a look.
  const current = selected ?? (tasks?.find((t) => t.state === "failed") ?? tasks?.find((t) => t.state === "running") ?? tasks?.find((t) => t.state === "queued") ?? tasks?.[0])?.key ?? null;
  const nodes: DagNodeView[] = useMemo(
    () => (tasks ?? []).map((t) => ({ id: t.key, label: t.key, detail: t.attempts > 1 ? `attempt ${t.attempts}` : t.type, state: t.state, dependsOn: t.dependsOn })),
    [tasks],
  );

  if (run.error) {
    return (
      <>
        <PageHeader title="Run" />
        <Panel>
          {run.error.status === 404 ? (
            <EmptyState title="This run does not exist in this workspace" action={<Link href="/dashboard/runs" className="text-sm underline underline-offset-4">All runs</Link>}>
              It may belong to another workspace, or retention may have removed it.
            </EmptyState>
          ) : (
            <ErrorState error={run.error} onRetry={run.reload} />
          )}
        </Panel>
      </>
    );
  }
  const r = run.data?.run;
  const task = tasks?.find((t) => t.key === current);
  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await api(`/v1/runs/${id}/cancel`, { method: "POST" });
      setConfirmCancel(false);
      run.reload();
    } catch (e) {
      setCancelError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <Link href="/dashboard/runs" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <Icon.arrowLeft size={14} />
        Runs
      </Link>
      <PageHeader
        title={r ? `${r.workflow} v${r.version}` : "Run"}
        description={
          r ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <RunState_ state={r.state} />
              <span className="font-mono text-xs">{r.id}</span>
              <span>started <Since iso={r.createdAt} /></span>
              <RunDuration createdAt={r.createdAt} finishedAt={r.finishedAt} />
            </span>
          ) : undefined
        }
        actions={
          r?.state === "running" && can("write") ? (
            <Button variant="danger" size="sm" onClick={() => setConfirmCancel(true)}>
              <Icon.stop size={14} />
              Cancel run
            </Button>
          ) : null
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(22rem,2fr)]">
        <div className="min-w-0 space-y-6">
          <Panel title="Tasks">
            {!tasks ? (
              <div className="h-48 animate-pulse rounded bg-raised" />
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[520px]">
                  <DagView nodes={nodes} selectedId={current} onSelect={setSelected} label="Run tasks: select one to inspect it" />
                </div>
              </div>
            )}
          </Panel>
          <Panel title="Timeline" padded={false}>
            {events.error ? (
              <ErrorState error={events.error} onRetry={events.reload} />
            ) : !events.data ? (
              <SkeletonRows rows={5} cols={3} />
            ) : (
              <DataTable
                caption="Run events"
                rows={[...events.data.events].reverse()}
                rowKey={(e) => String(e.id)}
                columns={[
                  { key: "at", header: "When", render: (e) => <Since iso={e.createdAt} /> },
                  { key: "type", header: "Event", render: (e) => <span className="font-mono text-xs">{e.type}</span> },
                  { key: "task", header: "Task", render: (e) => <span className="font-mono text-xs">{String(e.data.key ?? "")}</span> },
                  {
                    key: "detail",
                    header: "Detail",
                    render: (e) => (
                      <span className="text-muted">
                        {[e.data.attempt ? `attempt ${String(e.data.attempt)}` : "", e.data.kind ? String(e.data.kind).replaceAll("_", " ") : "", typeof e.data.durationMs === "number" ? formatDuration(e.data.durationMs) : "", e.data.by ? `by ${String(e.data.by)}` : ""]
                          .filter(Boolean)
                          .join(", ")}
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </Panel>
        </div>
        <div className="min-w-0 space-y-6">
          {task && r ? <TaskInspector key={task.id} task={task} runState={r.state} onChanged={run.reload} /> : <Panel><SkeletonRows rows={4} cols={2} /></Panel>}
          {r ? (
            <Panel title="Run input">
              <JsonView value={r.input} label="Run input" />
            </Panel>
          ) : null}
        </div>
      </div>
      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this run?"
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>Keep running</Button>
            <Button size="sm" variant="primary" loading={cancelling} onClick={() => void cancel()}>Cancel run</Button>
          </>
        }
      >
        <p>Queued and waiting tasks are cancelled at once. Running tasks are told to stop at their next heartbeat, and any result they report afterwards is refused. This cannot be undone.</p>
        {cancelError ? <p role="alert" className="mt-3 text-st-failed">{cancelError}</p> : null}
      </Dialog>
    </>
  );
}
