"use client";

import { use, useState } from "react";
import { RunDuration, RunLink, RunState_, Since } from "@/components/app/bits";
import { useLiveReload } from "@/components/app/session";
import { Button } from "@/components/ui/Button";
import { DataTable, EmptyState, ErrorState, PageHeader, Panel, Segmented, Select, SkeletonRows, TextInput } from "@/components/ui/kit";
import { useApi, usePagedApi } from "@/lib/hooks";
import { useNow } from "@/lib/now";
import type { RunRow, WorkflowRow } from "@/lib/types";

type StateFilter = "all" | "running" | "succeeded" | "failed" | "cancelled";

/** `?workflow=name` (the link from a workflow's page) preselects that workflow. */
export default function RunsPage({ searchParams }: { searchParams: Promise<{ workflow?: string | string[] }> }) {
  const initialWorkflow = use(searchParams).workflow;
  const [state, setState] = useState<StateFilter>("all");
  const [workflow, setWorkflow] = useState(typeof initialWorkflow === "string" ? initialWorkflow : "");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<"desc" | "asc">("desc");

  const params = new URLSearchParams({ limit: "25", order });
  if (state !== "all") params.set("state", state);
  if (workflow) params.set("workflow", workflow);
  if (query) params.set("q", query);
  const path = `/v1/runs?${params}`;
  const page = usePagedApi<RunRow>(path, "runs");
  const workflows = useApi<{ workflows: WorkflowRow[] }>("/v1/workflows");
  const now = useNow();
  useLiveReload(() => {
    if (!page.extended) page.reload();
  }, (e) => e.type.startsWith("run."));
  const { rows, cursor } = page;

  return (
    <>
      <PageHeader title="Runs" description="Every run of every workflow in this workspace. Updates as runs change." />
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
        role="search"
      >
        <Segmented<StateFilter>
          label="Run state"
          value={state}
          onChange={setState}
          options={[
            { value: "all", label: "All" },
            { value: "running", label: "Running" },
            { value: "succeeded", label: "Succeeded" },
            { value: "failed", label: "Failed" },
            { value: "cancelled", label: "Cancelled" },
          ]}
        />
        <Select label="Workflow" hideLabel value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
          <option value="">All workflows</option>
          {workflows.data?.workflows.map((w) => (
            <option key={w.id} value={w.name}>
              {w.name}
            </option>
          ))}
        </Select>
        <TextInput label="Search by run id or idempotency key" hideLabel placeholder="Run id or idempotency key" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
        <Button type="submit" size="sm">Search</Button>
        {query ? (
          <Button size="sm" variant="ghost" onClick={() => { setQ(""); setQuery(""); }}>Clear search</Button>
        ) : null}
        <div className="ml-auto">
          <Segmented<"desc" | "asc"> label="Order" value={order} onChange={setOrder} options={[{ value: "desc", label: "Newest first" }, { value: "asc", label: "Oldest first" }]} />
        </div>
      </form>
      <Panel padded={false}>
        {page.error ? (
          <ErrorState error={page.error} onRetry={page.reload} />
        ) : !page.data ? (
          <SkeletonRows rows={8} cols={6} />
        ) : rows.length === 0 ? (
          <EmptyState title={query || state !== "all" || workflow ? "No runs match these filters" : "No runs yet"}>
            {query || state !== "all" || workflow ? "Clear a filter to see more runs." : "Start a run with the SDK or the API; it appears here immediately."}
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption="Runs"
              rows={rows}
              rowKey={(r) => r.id}
              columns={[
                { key: "id", header: "Run", render: (r) => <RunLink id={r.id} /> },
                { key: "wf", header: "Workflow", render: (r) => <span>{r.workflow} <span className="text-faint">v{r.version}</span></span>, sort: (r) => r.workflow },
                { key: "state", header: "State", render: (r) => <RunState_ state={r.state} />, sort: (r) => r.state },
                { key: "created", header: "Started", render: (r) => <Since iso={r.createdAt} />, sort: (r) => r.createdAt },
                { key: "duration", header: "Duration", render: (r) => <RunDuration createdAt={r.createdAt} finishedAt={r.finishedAt} />, sort: (r) => (r.finishedAt ? Date.parse(r.finishedAt) : now) - Date.parse(r.createdAt) },
                { key: "by", header: "Started by", render: (r) => <span className="font-mono text-xs text-muted">{r.triggeredBy}</span> },
                { key: "key", header: "Idempotency key", render: (r) => <span className="font-mono text-xs text-muted">{r.idempotencyKey ?? "–"}</span> },
              ]}
            />
            <div className="flex items-center justify-between border-t border-line px-4 py-3">
              <p className="text-sm text-muted">{rows.length} shown</p>
              {page.moreError ? <p className="text-sm text-st-failed">{page.moreError.message}</p> : null}
              {cursor ? (
                <Button size="sm" onClick={page.loadMore} loading={page.loadingMore}>
                  Load more
                </Button>
              ) : (
                <p className="text-sm text-faint">That is every run.</p>
              )}
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
