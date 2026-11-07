"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { ApiError, api } from "./api";
import { nav } from "./nav";

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

const toApiError = (err: unknown) => (err instanceof ApiError ? err : new ApiError(0, "unknown", String(err)));

/** A 401 means the session ended: go to sign-in, then come back to this page. */
const toSignIn = () => nav.assign(nav.signInHere());

/**
 * GET an API path (null: skip). Keeps the last data while reloading. A 401 sends the
 * browser to sign-in, keeping the current page as the place to return to.
 */
export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}): ApiState<T> {
  const [nonce, setNonce] = useState(0);
  // The request each result answers: loading is "the current request has no answer yet".
  const [result, setResult] = useState<{ request: string; data?: T; error?: ApiError }>();
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const request = path ? `${path}#${nonce}` : null;

  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    const answered = `${path}#${nonce}`;
    api<T>(path, { signal: ctrl.signal })
      .then((data) => setResult({ request: answered, data }))
      .catch((err: unknown) => {
        if ((err as Error).name === "AbortError") return;
        if (err instanceof ApiError && err.status === 401) return toSignIn();
        setResult((r) => ({ request: answered, data: r?.data, error: toApiError(err) }));
      });
    return () => ctrl.abort();
  }, [path, nonce]);

  useEffect(() => {
    if (!opts.refreshMs || !path) return;
    const t = setInterval(reload, opts.refreshMs);
    return () => clearInterval(t);
  }, [opts.refreshMs, path, reload]);

  return { data: result?.data, error: result?.error, loading: request !== null && result?.request !== request, reload };
}

export interface PagedApiState<Row> extends ApiState<Record<string, unknown>> {
  rows: Row[];
  /** Cursor of the next page, or null when every row is shown. */
  cursor: string | null;
  loadMore: () => void;
  loadingMore: boolean;
  moreError: ApiError | undefined;
  /** More pages than the first are shown (live reloads would lose them, so pages skip those). */
  extended: boolean;
}

/**
 * A cursor-paginated list endpoint: `{ [field]: Row[], nextCursor }`. Pages loaded with
 * "Load more" belong to the path they were loaded for; changing a filter starts over.
 */
export function usePagedApi<Row>(path: string, field: string): PagedApiState<Row> {
  const first = useApi<Record<string, unknown> & { nextCursor?: string | null }>(path);
  const [extra, setExtra] = useState<{ path: string; rows: Row[]; cursor: string | null; error?: ApiError; loading: boolean } | null>(null);
  const more = extra?.path === path ? extra : null;
  const rows = [...((first.data?.[field] as Row[] | undefined) ?? []), ...(more?.rows ?? [])];
  const cursor = more ? more.cursor : (first.data?.nextCursor ?? null);

  const loadMore = () => {
    if (!cursor || more?.loading) return;
    const from = path;
    const prior = more?.rows ?? [];
    setExtra({ path: from, rows: prior, cursor, loading: true });
    api<Record<string, unknown> & { nextCursor: string | null }>(`${from}${from.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`)
      .then((r) => setExtra((m) => (m?.path === from ? { path: from, rows: [...m.rows, ...((r[field] as Row[] | undefined) ?? [])], cursor: r.nextCursor, loading: false } : m)))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) return toSignIn();
        setExtra((m) => (m?.path === from ? { ...m, loading: false, error: toApiError(err) } : m));
      });
  };

  return { ...first, rows, cursor, loadMore, loadingMore: Boolean(more?.loading), moreError: more?.error, extended: Boolean(more && more.rows.length > 0) };
}

export type StreamStatus = "connecting" | "live" | "reconnecting" | "unavailable";

export interface StreamEvent {
  id: number;
  type: string;
  runId: string | null;
  taskId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

/**
 * The event types the stream sends (`event:` names). They must match the engine's
 * EventType union (apps/api/src/engine/history.ts); a test compares the two.
 */
export const STREAM_EVENT_TYPES = [
  "run.created", "run.succeeded", "run.failed", "run.cancelled", "run.reopened",
  "task.queued", "task.started", "task.succeeded", "task.retry_scheduled", "task.failed",
  "task.skipped", "task.cancelled", "task.reopened", "task.checkpointed",
  "worker.registered", "worker.offline", "worker.deregistered",
] as const;

/**
 * Live execution events (GET /v1/stream via the proxy). EventSource reconnects by
 * itself and resumes after the last event id it saw; `onReset` fires when the server
 * says the client fell too far behind and should reload its view.
 */
export function useEventStream(opts: { runId?: string; onEvent: (e: StreamEvent) => void; onReset?: () => void; enabled?: boolean }): StreamStatus {
  const enabled = opts.enabled ?? true;
  const stream = enabled ? (opts.runId ?? "*") : null;
  // Status of the stream it was reported for; a new stream starts out "connecting".
  const [reported, setReported] = useState<{ stream: string; status: StreamStatus }>();
  const onEvent = useEffectEvent((e: StreamEvent) => opts.onEvent(e));
  const onReset = useEffectEvent(() => opts.onReset?.());

  useEffect(() => {
    if (stream === null) return;
    const es = new EventSource(`/api/v1/stream${stream === "*" ? "" : `?runId=${encodeURIComponent(stream)}`}`, { withCredentials: true });
    es.onopen = () => setReported({ stream, status: "live" });
    es.onerror = () => setReported({ stream, status: es.readyState === EventSource.CLOSED ? "unavailable" : "reconnecting" });
    const onAny = (ev: MessageEvent) => {
      let parsed: StreamEvent;
      try {
        parsed = JSON.parse(ev.data as string) as StreamEvent;
      } catch {
        return; // ignore a malformed message
      }
      onEvent(parsed);
    };
    for (const t of STREAM_EVENT_TYPES) es.addEventListener(t, onAny as EventListener);
    es.addEventListener("reset", () => onReset());
    return () => es.close();
  }, [stream]);

  if (stream === null) return "unavailable";
  return reported?.stream === stream ? reported.status : "connecting";
}
