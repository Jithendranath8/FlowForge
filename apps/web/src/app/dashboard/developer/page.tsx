"use client";

import { useState } from "react";
import { Since } from "@/components/app/bits";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/Button";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { DataTable, Dialog, EmptyState, ErrorState, PageHeader, Panel, SkeletonRows, TextInput } from "@/components/ui/kit";
import { ApiError, api } from "@/lib/api";
import { useApi } from "@/lib/hooks";

interface Key {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
}
const SCOPES = [
  { id: "read", text: "Read workflows, runs, tasks and workers" },
  { id: "workflows:write", text: "Register workflow versions" },
  { id: "runs:write", text: "Start, cancel and retry runs and tasks" },
  { id: "worker", text: "Run tasks as a worker (give workers only this)" },
];

function CreateKey({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const reset = () => {
    setOpen(false);
    setName("");
    setScopes(["read"]);
    setDays("");
    setErr(null);
    setSecret(null);
  };
  const create = async () => {
    if (!name.trim()) return setErr("Give the key a name, such as the service that will use it.");
    if (scopes.length === 0) return setErr("Choose at least one scope.");
    const expires = days ? Number(days) : undefined;
    if (expires !== undefined && (!Number.isInteger(expires) || expires < 1 || expires > 3650)) return setErr("Expiry must be a whole number of days from 1 to 3650, or empty.");
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ key: string }>("/v1/keys", { method: "POST", body: { name: name.trim(), scopes, ...(expires ? { expiresInDays: expires } : {}) } });
      setSecret(r.key);
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>Create API key</Button>
      <Dialog
        open={open}
        onClose={reset}
        title={secret ? "Copy your new key now" : "Create an API key"}
        footer={secret ? <Button size="sm" variant="primary" onClick={reset}>Done</Button> : (
          <>
            <Button size="sm" variant="ghost" onClick={reset}>Cancel</Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void create()}>Create key</Button>
          </>
        )}
      >
        {secret ? (
          <div className="space-y-3">
            <p>This is the only time the key is shown; FlowForge stores only a hash of it.</p>
            <CodeBlock code={secret} title="API key" />
          </div>
        ) : (
          <div className="space-y-4">
            <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="billing-service" autoFocus />
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-ink">Scopes</legend>
              <div className="space-y-2">
                {SCOPES.map((s) => (
                  <label key={s.id} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5" checked={scopes.includes(s.id)} onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))} />
                    <span>
                      <span className="font-mono text-ink">{s.id}</span>{" "}
                      <span className="ml-1 text-muted">{s.text}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <TextInput label="Expires after (days, optional)" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} placeholder="Never" />
            {err ? <p role="alert" className="text-st-failed">{err}</p> : null}
          </div>
        )}
      </Dialog>
    </>
  );
}

export default function DeveloperPage() {
  const { can } = useSession();
  const manage = can("manage");
  const keys = useApi<{ keys: Key[] }>(manage ? "/v1/keys" : null);
  const [revoking, setRevoking] = useState<Key | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/v1/keys/${revoking.id}/revoke`, { method: "POST" });
      setRevoking(null);
      keys.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const apiUrl = typeof window === "undefined" ? "http://localhost:4000" : `${window.location.origin}/api`;
  return (
    <>
      <PageHeader title="API keys and SDK" description="Keys let your services and workers call FlowForge. Each key belongs to this workspace and can do only what its scopes allow." actions={manage ? <CreateKey onCreated={keys.reload} /> : null} />
      <Panel title="API keys" padded={false}>
        {!manage ? (
          <EmptyState title="Only owners and admins manage API keys">Ask an owner or admin of this workspace for a key, or for the admin role.</EmptyState>
        ) : keys.error ? (
          <ErrorState error={keys.error} onRetry={keys.reload} />
        ) : !keys.data ? (
          <SkeletonRows rows={3} cols={5} />
        ) : keys.data.keys.length === 0 ? (
          <EmptyState title="No API keys yet">Create one for each service and one for your workers, with only the scopes each needs.</EmptyState>
        ) : (
          <DataTable
            caption="API keys"
            rows={keys.data.keys}
            rowKey={(k) => k.id}
            columns={[
              { key: "name", header: "Name", render: (k) => <span className="font-medium text-ink">{k.name}</span> },
              { key: "prefix", header: "Key", render: (k) => <span className="font-mono text-xs text-muted">{k.prefix}_…</span> },
              { key: "scopes", header: "Scopes", render: (k) => <span className="font-mono text-xs">{k.scopes.join(", ")}</span> },
              { key: "used", header: "Last used", render: (k) => (k.lastUsedAt ? <Since iso={k.lastUsedAt} /> : <span className="text-faint">never</span>) },
              { key: "state", header: "Status", render: (k) => (k.revokedAt ? <span className="text-st-failed">Revoked</span> : k.expiresAt && Date.parse(k.expiresAt) < Date.now() ? <span className="text-st-retrying">Expired</span> : <span>Active{k.expiresAt ? <span className="text-faint"> until {new Date(k.expiresAt).toLocaleDateString()}</span> : null}</span>) },
              { key: "by", header: "Created by", render: (k) => <span className="text-muted">{k.createdBy ?? "operator"}</span> },
              { key: "act", header: "", render: (k) => (k.revokedAt ? null : <Button size="sm" variant="danger" aria-label={`Revoke ${k.name}`} onClick={() => setRevoking(k)}>Revoke</Button>) },
            ]}
          />
        )}
      </Panel>
      <Panel className="mt-6" title="Connect the SDK">
        <div className="grid gap-4 xl:grid-cols-2">
          <CodeBlock title="environment" code={`FLOWFORGE_API_URL=${apiUrl}\nFLOWFORGE_API_KEY=<a key from above>`} />
          <CodeBlock
            title="client.ts"
            code={`import { FlowForgeClient } from "@flowforge/sdk";\n\nconst client = new FlowForgeClient({\n  apiUrl: process.env.FLOWFORGE_API_URL!,\n  apiKey: process.env.FLOWFORGE_API_KEY!,\n});\nconst run = await client.startRun("daily-report", { input: { day: "2026-11-01" } });`}
          />
        </div>
        <p className="mt-3 text-sm text-muted">Workers use a key with only the worker scope. The full API is described in the API reference in the documentation.</p>
      </Panel>
      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "this key"}?`}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setRevoking(null)}>Keep it</Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void revoke()}>Revoke key</Button>
          </>
        }
      >
        <p>Anything using this key gets 401 from its next request. Workers using it stop receiving tasks. This cannot be undone.</p>
        {err ? <p role="alert" className="mt-3 text-st-failed">{err}</p> : null}
      </Dialog>
    </>
  );
}
