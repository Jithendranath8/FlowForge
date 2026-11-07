import type { ReactNode } from "react";
import { DocsNav } from "@/components/docs/DocsNav";
import { SiteFooter, SiteHeader } from "@/components/site/SiteHeader";
import { allDocs } from "@/lib/docs";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <div className="mx-auto max-w-6xl px-5 py-8 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10 lg:py-12">
        <DocsNav docs={allDocs()} />
        <main id="main" className="min-w-0">
          {children}
        </main>
      </div>
      <SiteFooter />
    </>
  );
}
