"use client";

import { createContext, useCallback, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { ApiError, api, setSessionCsrf } from "@/lib/api";
import { useEventStream, type StreamEvent, type StreamStatus } from "@/lib/hooks";
import { nav } from "@/lib/nav";

export type Role = "owner" | "admin" | "member" | "viewer";
export interface Workspace {
  id: string;
  slug: string;
  name: string;
  role: Role;
}
export interface Me {
  user: { id: string; email: string | null; name: string | null; avatarUrl: string | null };
  workspace: Workspace | null;
  workspaces: Workspace[];
  csrfToken: string;
  sessionExpiresAt: string;
}

interface SessionValue {
  me: Me;
  switchWorkspace: (id: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (action: "write" | "manage") => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

/** Loads the signed-in user; without a valid session, goes to sign-in and back. */
export function SessionProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Me>("/auth/me")
      .then((m) => {
        setSessionCsrf(m.csrfToken);
        setMe(m);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          nav.replace(nav.signInHere());
          return;
        }
        setError(err instanceof ApiError ? err.message : String(err));
      });
  }, []);
  useEffect(load, [load]);

  if (error) {
    return (
      <main className="mx-auto max-w-lg px-5 py-24">
        <h1 className="text-xl font-semibold text-ink">The dashboard cannot reach FlowForge</h1>
        <p className="mt-2 text-sm text-muted">{error}</p>
        <button type="button" className="mt-4 h-9 rounded-[var(--radius-control)] border border-line-strong px-3 text-sm" onClick={() => location.reload()}>
          Try again
        </button>
      </main>
    );
  }
  if (!me) return <>{fallback}</>;

  const value: SessionValue = {
    me,
    switchWorkspace: async (id) => {
      await api("/auth/workspace", { method: "POST", body: { tenantId: id } });
      nav.assign("/dashboard");
    },
    // Leaves only once the API has ended the session; a failure is the caller's to show.
    signOut: async () => {
      await api("/auth/logout", { method: "POST" });
      nav.assign("/");
    },
    can: (action) => {
      const role = me.workspace?.role;
      return action === "manage" ? role === "owner" || role === "admin" : role !== undefined && role !== "viewer";
    },
  };
  return (
    <SessionContext.Provider value={value}>
      <LiveProvider>{children}</LiveProvider>
    </SessionContext.Provider>
  );
}

type Listener = (e: StreamEvent) => void;
interface LiveValue {
  status: StreamStatus;
  subscribe: (l: Listener, onReset?: () => void) => () => void;
}
const LiveContext = createContext<LiveValue | null>(null);

/** One live event stream per tab, shared by every page. */
function LiveProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<{ l: Listener; r?: () => void }>());
  const status = useEventStream({
    onEvent: (e) => listeners.current.forEach((x) => x.l(e)),
    onReset: () => listeners.current.forEach((x) => x.r?.()),
  });
  const subscribe = useCallback((l: Listener, r?: () => void) => {
    const entry = { l, r };
    listeners.current.add(entry);
    return () => {
      listeners.current.delete(entry);
    };
  }, []);
  return <LiveContext.Provider value={{ status, subscribe }}>{children}</LiveContext.Provider>;
}

export function useLiveStatus(): StreamStatus {
  return useContext(LiveContext)?.status ?? "unavailable";
}

/**
 * Re-run `reload` when matching live events arrive (coalesced), and after a stream reset.
 * Pages call this so their view follows the system without polling.
 */
export function useLiveReload(reload: () => void, match: (e: StreamEvent) => boolean, debounceMs = 400) {
  const live = useContext(LiveContext);
  const onReload = useEffectEvent(() => reload());
  const matches = useEffectEvent((e: StreamEvent) => match(e));
  useEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => onReload(), debounceMs);
    };
    const off = live.subscribe((e) => {
      if (matches(e)) kick();
    }, kick);
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [live, debounceMs]);
}

/** Every live event (e.g. the history page prepends them). */
export function useLiveEvents(onEvent: Listener) {
  const live = useContext(LiveContext);
  const handle = useEffectEvent((e: StreamEvent) => onEvent(e));
  useEffect(() => live?.subscribe((e) => handle(e)), [live]);
}
