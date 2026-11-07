"use client";

import { useState } from "react";
import { RunLink, Since } from "@/components/app/bits";
import { useLiveEvents } from "@/components/app/session";
import { Button } from "@/components/ui/Button";
import { DataTable, EmptyState, ErrorState, PageHeader, Panel, Select, SkeletonRows } from "@/components/ui/kit";
import { api } from "@/lib/api";
import { STREAM_EVENT_TYPES, useApi } from "@/lib/hooks";
import type { EventRow } from "@/lib/types";


export default function HistoryPage() {
  const [type, setType] = useState("");
  const path = `/v1/events?limit=50${type ? `&type=${type}` : ""}`;
  const first = useApi<{ events: EventRow[]; nextBefore: number | null }>(path);
  const [live, setLive] = useState<EventRow[]>([]);
  const [older, setOlder] = useState<{ path: string; events: EventRow[]; before: number | null } | null>(null);
  useLiveEvents((e) => {
    if (type && e.type !== type) return;
    setLive((l) => [{ id: e.id, runId: e.runId, taskId: e.taskId, type: e.type, data: e.data, createdAt: e.createdAt }, ...l].slice(0, 200));
  });
  const seen = new Set(first.data?.events.map((e) => e.id));
  const olderRows = older?.path === path ? older.events : [];
  const rows = [...live.filter((e) => !seen.has(e.id) && e.id > (first.data?.events[0]?.id ?? 0)), ...(first.data?.events ?? []), ...olderRows];
  const before = older?.path === path ? older.before : (first.data?.nextBefore ?? null);
  return (
    <>
      <PageHeader title="Execution history" description="Every state change in this workspace, newest first. New events appear as they happen. This is the durable audit trail; retention removes it with the run it belongs to." />
      <div className="mb-4">
        <Select label="Event type" hideLabel className="max-w-[16rem]" value={type} onChange={(e) => { setType(e.target.value); setLive([]); }}>
          <option value="">All events</option>
          {STREAM_EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </div>
      <Panel padded={false}>
        {first.error ? (
          <ErrorState error={first.error} onRetry={first.reload} />
        ) : !first.data ? (
          <SkeletonRows rows={10} cols={5} />
        ) : rows.length === 0 ? (
          <EmptyState title="No events">{type ? "None of this type yet." : "Events appear as soon as workflows run."}</EmptyState>
        ) : (
          <>
            <DataTable
              caption="Events"
              rows={rows}
              rowKey={(e) => String(e.id)}
              columns={[
                { key: "id", header: "#", render: (e) => <span className="tabular font-mono text-xs text-faint">{e.id}</span> },
                { key: "at", header: "When", render: (e) => <Since iso={e.createdAt} /> },
                { key: "type", header: "Event", render: (e) => <span className="font-mono text-xs">{e.type}</span> },
                { key: "subject", header: "Task or worker", render: (e) => <span className="font-mono text-xs text-muted">{String(e.data.key ?? e.data.name ?? e.data.workerId ?? "")}</span> },
                { key: "run", header: "Run", render: (e) => (e.runId ? <RunLink id={e.runId} /> : <span className="text-faint">–</span>) },
              ]}
            />
            <div className="flex justify-end border-t border-line px-4 py-3">
              {before ? (
                <Button size="sm" onClick={() => void api<{ events: EventRow[]; nextBefore: number | null }>(`${path}&before=${before}`).then((r) => setOlder({ path, events: [...olderRows, ...r.events], before: r.nextBefore }))}>
                  Load older
                </Button>
              ) : (
                <p className="text-sm text-faint">That is the whole history.</p>
              )}
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
