"use client";

import Link from "next/link";
import { Since } from "@/components/app/bits";
import { DataTable, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows } from "@/components/ui/kit";
import { useApi } from "@/lib/hooks";
import type { WorkflowRow } from "@/lib/types";

export default function WorkflowsPage() {
  const list = useApi<{ workflows: WorkflowRow[] }>("/v1/workflows");
  return (
    <>
      <PageHeader title="Workflows" description="Registered workflow definitions. Each registration of a changed definition creates a new, immutable version." />
      <Panel padded={false}>
        {list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : !list.data ? (
          <SkeletonRows rows={5} cols={4} />
        ) : list.data.workflows.length === 0 ? (
          <EmptyState title="No workflows registered" action={<Link href="/docs/workflows" className="text-sm underline underline-offset-4">How to define a workflow</Link>}>
            Register one with <code className="font-mono text-ink">client.registerWorkflow()</code> from the SDK or <code className="font-mono text-ink">PUT /v1/workflows</code>.
          </EmptyState>
        ) : (
          <DataTable
            caption="Workflows"
            rows={list.data.workflows}
            rowKey={(w) => w.id}
            initialSort={{ key: "updated", dir: "desc" }}
            columns={[
              {
                key: "name",
                header: "Name",
                sort: (w) => w.name,
                render: (w) => (
                  <Link href={`/dashboard/workflows/${encodeURIComponent(w.name)}`} className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                    {w.name}
                  </Link>
                ),
              },
              { key: "desc", header: "Description", render: (w) => <span className="text-muted">{w.description ?? "–"}</span> },
              { key: "version", header: "Latest version", sort: (w) => w.latestVersion, render: (w) => <span className="tabular">v{w.latestVersion}</span> },
              { key: "updated", header: "Updated", sort: (w) => w.updatedAt, render: (w) => <Since iso={w.updatedAt} /> },
            ]}
          />
        )}
      </Panel>
    </>
  );
}
