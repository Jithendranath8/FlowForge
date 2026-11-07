import Link from "next/link";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDuration, formatRelative, shortId } from "@/lib/format";
import { useNow } from "@/lib/now";
import type { RunState, TaskState } from "@/lib/states";

export const RunState_ = ({ state }: { state: RunState }) => <StatusBadge state={state as TaskState} />;

export function RunLink({ id }: { id: string }) {
  return (
    <Link href={`/dashboard/runs/${id}`} className="font-mono text-[0.8125rem] text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
      {shortId(id)}
    </Link>
  );
}

export function Since({ iso }: { iso: string | null | undefined }) {
  const now = useNow();
  return (
    <time dateTime={iso ?? undefined} title={iso ? new Date(iso).toLocaleString() : undefined} className="tabular text-muted">
      {formatRelative(iso, now)}
    </time>
  );
}

export function RunDuration({ createdAt, finishedAt }: { createdAt: string; finishedAt: string | null }) {
  const now = useNow();
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  return <span className="tabular text-muted">{formatDuration(end - new Date(createdAt).getTime())}{finishedAt ? "" : " so far"}</span>;
}

/** Big-number stat for the overview (one number with a plain label). */
export function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <p className="text-sm text-muted">{label}</p>
      <p className="tabular mt-1 text-2xl font-semibold text-ink">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-faint">{hint}</p> : null}
    </div>
  );
}
