"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useMemo, useState } from "react";
import { DagView } from "@/components/dag/DagView";
import { Since } from "@/components/app/bits";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/icons";
import { DataTable, Dialog, EmptyState, ErrorState, JsonView, PageHeader, Panel, SkeletonRows } from "@/components/ui/kit";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { WorkflowRow, WorkflowTaskDef } from "@/lib/types";

interface VersionView {
  id: string;
  version: number;
  checksum: string;
  createdAt: string;
  definition: { name: string; description?: string; tasks: WorkflowTaskDef[] };
}

export default function WorkflowPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: raw } = use(params);
  const name = decodeURIComponent(raw);
  const router = useRouter();
  const { can } = useSession();
  const wf = useApi<{ workflow: WorkflowRow; latest: VersionView | null }>(`/v1/workflows/${encodeURIComponent(name)}`);
  const versions = useApi<{ versions: { id: string; version: number; checksum: string; createdAt: string; definitionBytes: number }[] }>(`/v1/workflows/${encodeURIComponent(name)}/versions?limit=50`);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const latest = wf.data?.latest;
  const nodes = useMemo(
    () => (latest?.definition.tasks ?? []).map((t) => ({ id: t.key, label: t.key, detail: t.type, dependsOn: t.dependsOn ?? [] })),
    [latest],
  );

  const start = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input || "{}");
    } catch {
      setErr("The input is not valid JSON.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setErr("The input must be a JSON object, such as {} or {\"day\": \"2026-11-01\"}.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ run: { id: string } }>(`/v1/workflows/${encodeURIComponent(name)}/runs`, { method: "POST", body: { input: parsed } });
      router.push(`/dashboard/runs/${r.run.id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  if (wf.error) {
    return (
      <>
        <PageHeader title={name} />
        <Panel>{wf.error.status === 404 ? <EmptyState title="No workflow with this name in this workspace" /> : <ErrorState error={wf.error} onRetry={wf.reload} />}</Panel>
      </>
    );
  }
  return (
    <>
      <Link href="/dashboard/workflows" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <Icon.arrowLeft size={14} />
        Workflows
      </Link>
      <PageHeader
        title={name}
        description={wf.data ? (wf.data.workflow.description ?? `Version ${wf.data.workflow.latestVersion}`) : undefined}
        actions={
          <>
            <Link href={`/dashboard/runs?workflow=${encodeURIComponent(name)}`} className="text-sm text-muted hover:text-ink">Runs of this workflow</Link>
            {can("write") && latest ? (
              <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
                <Icon.play size={14} />
                Start a run
              </Button>
            ) : null}
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
        <Panel title={latest ? `Graph of version ${latest.version}` : "Graph"}>
          {!latest ? (
            <div className="h-48 animate-pulse rounded bg-raised" />
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[520px]">
                <DagView nodes={nodes} label={`Tasks of ${name} version ${latest.version}`} />
              </div>
            </div>
          )}
        </Panel>
        <Panel title="Versions" padded={false}>
          {versions.error ? (
            <ErrorState error={versions.error} onRetry={versions.reload} />
          ) : !versions.data ? (
            <SkeletonRows rows={3} cols={3} />
          ) : (
            <DataTable
              caption="Versions"
              minWidth={360}
              rows={versions.data.versions}
              rowKey={(v) => v.id}
              columns={[
                { key: "v", header: "Version", render: (v) => <span className="tabular">v{v.version}</span> },
                { key: "at", header: "Registered", render: (v) => <Since iso={v.createdAt} /> },
                { key: "size", header: "Size", render: (v) => <span className="tabular text-muted">{(v.definitionBytes / 1024).toFixed(1)} KiB</span> },
                { key: "sum", header: "Checksum", render: (v) => <span className="font-mono text-xs text-faint">{v.checksum.slice(0, 12)}</span> },
              ]}
            />
          )}
        </Panel>
      </div>
      {latest ? (
        <Panel className="mt-6" title="Definition">
          <JsonView value={latest.definition} label="Workflow definition" />
        </Panel>
      ) : null}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Start a run of ${name}`}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void start()}>Start run</Button>
          </>
        }
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">Run input (JSON object)</span>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={6}
            spellCheck={false}
            className="rounded-[var(--radius-control)] border border-line-strong bg-surface p-2 font-mono text-xs text-ink"
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? "start-run-error" : undefined}
          />
        </label>
        <p className="mt-2 text-xs">Handlers receive this as runInput. The run starts on version {latest?.version}.</p>
        {err ? <p id="start-run-error" role="alert" className="mt-3 text-st-failed">{err}</p> : null}
      </Dialog>
    </>
  );
}
