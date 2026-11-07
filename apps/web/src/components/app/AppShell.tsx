"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LogoMark } from "@/components/site/Logo";
import { Icon } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { useLiveStatus, useSession } from "./session";

const NAV: { href: string; label: string; icon: keyof typeof Icon }[] = [
  { href: "/dashboard", label: "Overview", icon: "gauge" },
  { href: "/dashboard/runs", label: "Runs", icon: "play" },
  { href: "/dashboard/workflows", label: "Workflows", icon: "graph" },
  { href: "/dashboard/tasks", label: "Task executions", icon: "list" },
  { href: "/dashboard/workers", label: "Workers", icon: "server" },
  { href: "/dashboard/scheduling", label: "Scheduling", icon: "layers" },
  { href: "/dashboard/history", label: "Execution history", icon: "clock" },
  { href: "/dashboard/logs", label: "Logs", icon: "list" },
  { href: "/dashboard/monitoring", label: "Monitoring", icon: "gauge" },
];
const NAV_BOTTOM: typeof NAV = [
  { href: "/dashboard/settings", label: "Settings", icon: "cog" },
  { href: "/dashboard/developer", label: "API keys and SDK", icon: "key" },
];

function NavList({ items, onNavigate }: { items: typeof NAV; onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <ul className="space-y-0.5">
      {items.map((n) => {
        const active = n.href === "/dashboard" ? path === "/dashboard" : path.startsWith(n.href);
        const I = Icon[n.icon];
        return (
          <li key={n.href}>
            <Link
              href={n.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex h-8 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-sm ${active ? "bg-raised font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}
            >
              <I size={16} />
              {n.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function LiveIndicator() {
  const status = useLiveStatus();
  const text = { live: "Live", connecting: "Connecting", reconnecting: "Reconnecting", unavailable: "Live updates off" }[status];
  const color = status === "live" ? "var(--st-succeeded)" : status === "unavailable" ? "var(--st-failed)" : "var(--st-retrying)";
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted" title={status === "live" ? "Receiving events as they happen" : "Live event stream not connected; pages still load on demand"}>
      <span className={`size-2 rounded-full ${status === "live" ? "" : "animate-ff-pulse"}`} style={{ background: color }} aria-hidden="true" />
      <span aria-live="polite">{text}</span>
    </span>
  );
}

function WorkspaceSwitcher() {
  const { me, switchWorkspace } = useSession();
  if (me.workspaces.length <= 1) {
    return <span className="truncate text-sm font-medium text-ink">{me.workspace?.name ?? "No workspace"}</span>;
  }
  return (
    <label className="flex min-w-0 items-center">
      <span className="sr-only">Workspace</span>
      <select
        value={me.workspace?.id ?? ""}
        onChange={(e) => void switchWorkspace(e.target.value)}
        className="h-8 max-w-[14rem] truncate rounded-[var(--radius-control)] border border-line-strong bg-surface px-2 text-sm font-medium text-ink"
      >
        {me.workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} ({w.role})
          </option>
        ))}
      </select>
    </label>
  );
}

function UserMenu() {
  const { me, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 items-center gap-2 rounded-[var(--radius-control)] px-2 text-sm text-ink hover:bg-raised"
      >
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-raised text-xs font-semibold" aria-hidden="true">
          {(me.user.name ?? me.user.email ?? "?").slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden max-w-[10rem] truncate sm:inline">{me.user.name ?? me.user.email}</span>
        <Icon.chevronDown size={14} />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-60 rounded-[var(--radius-panel)] border border-line bg-surface p-1 shadow-[var(--shadow-pop)]" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <p className="truncate px-2.5 py-2 text-xs text-muted">{me.user.email}</p>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setSignOutError(null);
              signOut().catch((err: unknown) => setSignOutError(`Could not sign out: ${(err as Error).message}`));
            }}
            className="flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-2.5 text-sm text-ink hover:bg-raised">
            <Icon.logout size={16} />
            Sign out
          </button>
          {signOutError ? <p role="alert" className="px-2.5 py-2 text-xs text-st-failed">{signOutError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  // The drawer belongs to the page it was opened on: navigating closes it.
  const [drawerOn, setDrawerOn] = useState<string | null>(null);
  const drawer = drawerOn === path;
  const setDrawer = (open: boolean) => setDrawerOn(open ? path : null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  // Focus moves into the open drawer, and back to the menu button when it closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (drawer) (drawerRef.current?.querySelector<HTMLElement>("a[aria-current=page]") ?? drawerRef.current?.querySelector<HTMLElement>("a"))?.focus();
    else if (wasOpen.current) menuButton.current?.focus();
    wasOpen.current = drawer;
  }, [drawer]);
  const sidebar = (
    <nav aria-label="Dashboard" className="flex h-full flex-col gap-6 px-3 py-4">
      <Link href="/" className="flex items-center gap-2 px-2 text-[0.9375rem] font-semibold text-ink">
        <LogoMark size={20} />
        FlowForge
      </Link>
      <NavList items={NAV} onNavigate={() => setDrawer(false)} />
      <div className="mt-auto">
        <NavList items={NAV_BOTTOM} onNavigate={() => setDrawer(false)} />
      </div>
    </nav>
  );
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-surface lg:block">{sidebar}</aside>
      {drawer ? (
        <div
          ref={drawerRef}
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          onKeyDown={(e) => {
            if (e.key === "Escape") setDrawer(false);
          }}
        >
          <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-line bg-surface">{sidebar}</aside>
        </div>
      ) : null}
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-canvas/90 px-4 backdrop-blur-sm md:px-6">
          <button ref={menuButton} type="button" aria-label="Open navigation" aria-expanded={drawer} onClick={() => setDrawer(true)} className="inline-flex size-8 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-raised lg:hidden">
            <Icon.menu />
          </button>
          <WorkspaceSwitcher />
          <div className="ml-auto flex items-center gap-3">
            <LiveIndicator />
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>
        <main id="main" className="px-4 py-6 md:px-6 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
