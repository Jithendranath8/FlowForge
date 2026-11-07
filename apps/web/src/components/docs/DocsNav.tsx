"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { DocMeta } from "@/lib/docs";

const href = (slug: string) => (slug === "index" ? "/docs" : `/docs/${slug}`);

function Sections({ docs }: { docs: DocMeta[] }) {
  const path = usePathname();
  const sections = [...new Set(docs.map((d) => d.section))];
  return (
    <div className="space-y-6">
      {sections.map((s) => (
        <div key={s}>
          <p className="px-2.5 text-xs font-semibold text-faint">{s}</p>
          <ul className="mt-1.5 space-y-0.5">
            {docs
              .filter((d) => d.section === s)
              .map((d) => {
                const active = path === href(d.slug);
                return (
                  <li key={d.slug}>
                    <Link
                      href={href(d.slug)}
                      aria-current={active ? "page" : undefined}
                      className={`block rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm ${active ? "bg-raised font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}
                    >
                      {d.title}
                    </Link>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Sidebar on wide screens; a disclosure above the page on narrow ones. */
export function DocsNav({ docs }: { docs: DocMeta[] }) {
  const path = usePathname();
  const current = docs.find((d) => href(d.slug) === path);
  return (
    <>
      <details className="mb-6 rounded-[var(--radius-panel)] border border-line bg-surface lg:hidden" key={path}>
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-ink">
          Documentation{current ? <span className="font-normal text-muted">: {current.title}</span> : null}
        </summary>
        <nav aria-label="Documentation" className="border-t border-line px-2 py-3">
          <Sections docs={docs} />
        </nav>
      </details>
      <nav aria-label="Documentation" className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] overflow-y-auto pb-8 lg:block">
        <Sections docs={docs} />
      </nav>
    </>
  );
}
