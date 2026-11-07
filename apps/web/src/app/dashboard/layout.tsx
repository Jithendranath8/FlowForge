"use client";

import { AppShell } from "@/components/app/AppShell";
import { SessionProvider } from "@/components/app/session";

function ShellSkeleton() {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]" aria-busy="true" aria-label="Loading the dashboard">
      <aside className="hidden border-r border-line bg-surface lg:block" />
      <div className="p-6">
        <div className="h-6 w-48 animate-pulse rounded bg-raised" />
        <div className="mt-6 h-40 animate-pulse rounded-[var(--radius-panel)] bg-raised" />
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider fallback={<ShellSkeleton />}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
