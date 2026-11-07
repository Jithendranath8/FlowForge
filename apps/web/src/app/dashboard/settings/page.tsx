"use client";

import { useState } from "react";
import { Since } from "@/components/app/bits";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/Button";
import { DataTable, Dialog, ErrorState, KeyValue, PageHeader, Panel, SkeletonRows } from "@/components/ui/kit";
import { ApiError, api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useApi } from "@/lib/hooks";

interface Quotas {
  quotas: Record<string, { limit: number; usage?: number }>;
}
interface Member {
  userId: string;
  email: string | null;
  name: string | null;
  role: string;
  since: string;
}
const QUOTA_LABEL: Record<string, string> = {
  max_concurrency: "Tasks running at once",
  max_active_runs: "Runs in progress",
  max_workflows: "Workflows",
  max_versions_per_workflow: "Versions per workflow",
  max_active_workers: "Active workers (not offline)",
};

export default function SettingsPage() {
  const { me, signOut, can } = useSession();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const quotas = useApi<Quotas>("/v1/tenant");
  const members = useApi<{ members: Member[] }>("/v1/members");
  const ws = me.workspace;
  // Owners remove anyone; admins remove members and viewers (the API enforces the same).
  const canRemove = (m: Member) => can("manage") && m.userId !== me.user.id && (ws?.role === "owner" || (m.role !== "owner" && m.role !== "admin"));
  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api(`/v1/members/${encodeURIComponent(removing.userId)}`, { method: "DELETE" });
      setRemoving(null);
      members.reload();
    } catch (err) {
      setRemoveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRemoveBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="Settings" description="This workspace, its limits and who has access." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Workspace">
          <KeyValue
            items={[
              ["Name", ws?.name ?? "–"],
              ["Slug", <span key="s" className="font-mono text-[0.8125rem]">{ws?.slug ?? "–"}</span>],
              ["Your role", ws?.role ?? "–"],
              ["Workspace id", <span key="i" className="font-mono text-xs">{ws?.id ?? "–"}</span>],
            ]}
          />
        </Panel>
        <Panel title="Your session">
          <KeyValue
            items={[
              ["Signed in as", me.user.email ?? me.user.name ?? me.user.id],
              ["Session ends", formatDateTime(me.sessionExpiresAt)],
            ]}
          />
          <p className="mt-3 text-sm text-muted">Sessions extend while you use the dashboard, up to a fixed maximum, then ask you to sign in again.</p>
          <Button
            className="mt-4"
            size="sm"
            onClick={() => {
              setSignOutError(null);
              signOut().catch((err: unknown) => setSignOutError(`Could not sign out: ${(err as Error).message}`));
            }}
          >
            Sign out
          </Button>
          {signOutError ? <p role="alert" className="mt-2 text-sm text-st-failed">{signOutError}</p> : null}
        </Panel>
      </div>
      <Panel className="mt-6" title="Limits" padded={false}>
        {quotas.error ? (
          <ErrorState error={quotas.error} onRetry={quotas.reload} />
        ) : !quotas.data ? (
          <SkeletonRows rows={5} cols={3} />
        ) : (
          <>
            <DataTable
              caption="Workspace limits"
              rows={Object.entries(quotas.data.quotas).map(([k, v]) => ({ k, ...v }))}
              rowKey={(r) => r.k}
              columns={[
                { key: "k", header: "Limit", render: (r) => QUOTA_LABEL[r.k] ?? r.k },
                { key: "u", header: "In use", render: (r) => <span className="tabular">{r.usage ?? "–"}</span> },
                { key: "l", header: "Allowed", render: (r) => <span className="tabular">{r.limit}</span> },
                {
                  key: "bar",
                  header: "Usage",
                  render: (r) =>
                    r.usage === undefined ? <span className="text-faint">per workflow</span> : (
                      <span className="block h-1.5 w-32 overflow-hidden rounded-full bg-raised" role="img" aria-label={`${Math.round((r.usage / Math.max(1, r.limit)) * 100)}% used`}>
                        <span className="block h-full rounded-full" style={{ width: `${Math.min(100, (r.usage / Math.max(1, r.limit)) * 100)}%`, minWidth: r.usage > 0 ? 4 : 0, background: r.usage >= r.limit ? "var(--st-failed)" : "var(--ink)" }} />
                      </span>
                    ),
                },
              ]}
            />
            <p className="border-t border-line px-4 py-3 text-sm text-muted">An operator changes limits with <code className="font-mono text-ink">flowforge-admin set-quota</code>. Requests over a limit get 429 quota_exceeded.</p>
          </>
        )}
      </Panel>
      <Panel className="mt-6" title="Members" padded={false}>
        {members.error ? (
          <ErrorState error={members.error} onRetry={members.reload} />
        ) : !members.data ? (
          <SkeletonRows rows={3} cols={3} />
        ) : (
          <>
            <DataTable
              caption="Members"
              rows={members.data.members}
              rowKey={(m) => m.userId}
              columns={[
                { key: "who", header: "Member", render: (m) => <span>{m.name ?? m.email}{m.name && m.email ? <span className="ml-2 text-muted">{m.email}</span> : null}</span> },
                { key: "role", header: "Role", render: (m) => m.role },
                { key: "since", header: "Member since", render: (m) => <Since iso={m.since} /> },
                {
                  key: "act",
                  header: "",
                  render: (m) =>
                    canRemove(m) ? (
                      <Button size="sm" variant="danger" aria-label={`Remove ${m.name ?? m.email ?? "member"}`} onClick={() => (setRemoveError(null), setRemoving(m))}>
                        Remove
                      </Button>
                    ) : null,
                },
              ]}
            />
            <p className="border-t border-line px-4 py-3 text-sm text-muted">
              An operator adds people with <code className="font-mono text-ink">flowforge-admin add-member</code>; they get access the first time they sign in with that email. Owners and admins remove people here.
            </p>
          </>
        )}
      </Panel>
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? removing?.email ?? "this member"} from ${ws?.name ?? "this workspace"}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Keep them
            </Button>
            <Button variant="danger" loading={removeBusy} onClick={() => void remove()}>
              Remove
            </Button>
          </>
        }
      >
        <p>They lose access at once: their sessions in this workspace end. API keys belong to the workspace, so any key they created keeps working until you revoke it on the API keys page.</p>
        {removeError ? <p role="alert" className="mt-2 text-st-failed">{removeError}</p> : null}
      </Dialog>
    </>
  );
}
