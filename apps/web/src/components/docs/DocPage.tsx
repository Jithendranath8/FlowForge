import Link from "next/link";
import { allDocs, docHref, type Doc } from "@/lib/docs";

/** One documentation page: title, rendered Markdown, the page's headings, and previous/next. */
export function DocPage({ doc }: { doc: Doc }) {
  const docs = allDocs();
  const i = docs.findIndex((d) => d.slug === doc.slug);
  const prev = i > 0 ? docs[i - 1] : undefined;
  const next = i >= 0 && i < docs.length - 1 ? docs[i + 1] : undefined;
  return (
    <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_12rem] xl:gap-10">
      <article className="min-w-0 max-w-[72ch]">
        <p className="text-sm text-faint">{doc.section}</p>
        <h1 className="mt-1 text-[1.75rem] font-semibold tracking-[-0.02em] text-ink sm:text-[2rem]">{doc.title}</h1>
        {doc.description ? <p className="mt-2 text-[1.0625rem] text-muted">{doc.description}</p> : null}
        <div className="doc mt-8" dangerouslySetInnerHTML={{ __html: doc.html }} />
        <nav aria-label="Previous and next page" className="mt-14 grid gap-3 border-t border-line pt-6 sm:grid-cols-2">
          {prev ? (
            <Link href={docHref(prev.slug)} className="rounded-[var(--radius-panel)] border border-line px-4 py-3 hover:bg-raised">
              <span className="block text-xs text-faint">Previous</span>
              <span className="text-sm font-medium text-ink">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={docHref(next.slug)} className="rounded-[var(--radius-panel)] border border-line px-4 py-3 text-right hover:bg-raised">
              <span className="block text-xs text-faint">Next</span>
              <span className="text-sm font-medium text-ink">{next.title}</span>
            </Link>
          ) : null}
        </nav>
      </article>
      {doc.toc.length > 1 ? (
        <aside className="hidden xl:block">
          <nav aria-label="On this page" className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto text-sm">
            <p className="text-xs font-semibold text-faint">On this page</p>
            <ul className="mt-2 space-y-1.5 border-l border-line">
              {doc.toc.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`} className={`-ml-px block border-l border-transparent text-muted hover:border-line-strong hover:text-ink ${h.depth === 3 ? "pl-6" : "pl-3"}`}>
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      ) : null}
    </div>
  );
}
