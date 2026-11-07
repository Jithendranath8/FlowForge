import Link from "next/link";
import { LinkButton } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Logo } from "./Logo";

const nav = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#install", label: "Quick start" },
  { href: "/docs", label: "Docs" },
  { href: "https://github.com/Jithendranath8/FlowForge", label: "GitHub", external: true },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-sm supports-[backdrop-filter]:bg-canvas/70">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
        <Logo />
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm text-muted hover:bg-raised hover:text-ink"
              {...(n.external ? { target: "_blank", rel: "noreferrer" } : {})}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <span className="hidden sm:inline-flex">
            <LinkButton href="/sign-in" variant="ghost" size="sm">
              Sign in
            </LinkButton>
          </span>
          <LinkButton href="/#install" variant="primary" size="sm">
            Run the quick start
          </LinkButton>
        </div>
      </div>
      <nav aria-label="Main (mobile)" className="flex gap-1 overflow-x-auto border-t border-line px-3 py-1.5 md:hidden">
        {nav.map((n) => (
          <Link key={n.href} href={n.href} className="shrink-0 rounded-[var(--radius-control)] px-2.5 py-1 text-sm text-muted hover:bg-raised hover:text-ink" {...(n.external ? { target: "_blank", rel: "noreferrer" } : {})}>
            {n.label}
          </Link>
        ))}
        <Link href="/sign-in" className="shrink-0 rounded-[var(--radius-control)] px-2.5 py-1 text-sm text-muted hover:bg-raised hover:text-ink">
          Sign in
        </Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  const cols = [
    { title: "Product", links: [{ href: "/#how-it-works", label: "How it works" }, { href: "/#architecture", label: "Architecture" }, { href: "/#reliability", label: "Failure recovery" }, { href: "/dashboard", label: "Dashboard" }] },
    { title: "Documentation", links: [{ href: "/docs", label: "Introduction" }, { href: "/docs/quick-start", label: "Quick start" }, { href: "/docs/workflows", label: "Workflow definitions" }, { href: "/docs/api", label: "API reference" }] },
    { title: "Project", links: [{ href: "https://github.com/Jithendranath8/FlowForge", label: "Source code" }, { href: "/docs/security", label: "Security model" }, { href: "/docs/operations", label: "Operations" }] },
  ];
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-xs text-sm text-muted">Distributed workflow orchestration with Postgres as the source of truth.</p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <h2 className="text-sm font-semibold text-ink">{c.title}</h2>
            <ul className="mt-3 space-y-2">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-muted hover:text-ink">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </footer>
  );
}
