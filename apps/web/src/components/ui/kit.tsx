"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ApiError } from "@/lib/api";
import { Button } from "./Button";

/* Shared dashboard building blocks: every one has loading, empty, error and focus states. */

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-[72ch] text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Panel({ title, actions, children, className = "", padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={`rounded-[var(--radius-panel)] border border-line bg-surface ${className}`}>
      {title || actions ? (
        <div className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
          {title ? <h2 className="text-sm font-semibold text-ink">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-10">
      <p className="text-md font-medium text-ink">{title}</p>
      {children ? <div className="max-w-[60ch] text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 px-4 py-8">
      <p className="text-md font-medium text-ink">{error.status === 403 ? "You do not have access to this" : "This could not be loaded"}</p>
      <p className="max-w-[60ch] text-sm text-muted">
        {error.message}
        {error.code ? <span className="ml-1 font-mono text-xs text-faint">({error.code})</span> : null}
      </p>
      {onRetry && error.status !== 403 ? (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-line" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 px-4 py-3">
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="h-4 flex-1 animate-pulse rounded bg-raised" style={{ maxWidth: c === 0 ? "10rem" : undefined }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** One choice from a few: a group of toggle buttons (arrow keys move between them). */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[var(--radius-control)] border border-line bg-raised p-0.5">
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const next = options[(i + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length]!;
            onChange(next.value);
            (e.currentTarget.parentElement?.querySelectorAll("button")[options.indexOf(next)] as HTMLButtonElement | undefined)?.focus();
          }}
          className={`h-7 rounded-[5px] px-2.5 text-sm ${value === o.value ? "bg-surface font-medium text-ink shadow-sm" : "text-muted hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TextInput({ label, hideLabel, className = "", ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hideLabel?: boolean }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className={hideLabel ? "sr-only" : "text-sm font-medium text-ink"}>{label}</span>
      <input
        {...rest}
        className="h-9 rounded-[var(--radius-control)] border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50"
      />
    </label>
  );
}

export function Select({ label, hideLabel, children, className = "", ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; hideLabel?: boolean }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className={hideLabel ? "sr-only" : "text-sm font-medium text-ink"}>{label}</span>
      <select {...rest} className="h-9 rounded-[var(--radius-control)] border border-line-strong bg-surface px-2.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-focus">
        {children}
      </select>
    </label>
  );
}

/** A modal dialog on the native <dialog> (focus trap, Escape and backdrop for free). */
export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Unique per dialog: a page can hold several (create and revoke), each named by its own title.
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[var(--radius-panel)] border border-line bg-surface p-0 text-ink shadow-[var(--shadow-pop)] backdrop:bg-black/40"
      aria-labelledby={titleId}
    >
      <div className="border-b border-line px-5 py-3.5">
        <h2 id={titleId} className="text-md font-semibold">
          {title}
        </h2>
      </div>
      <div className="px-5 py-4 text-sm text-muted">{children}</div>
      {footer ? <div className="flex justify-end gap-2 border-t border-line bg-raised px-5 py-3">{footer}</div> : null}
    </dialog>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function JsonView({ value, label }: { value: unknown; label: string }) {
  return (
    <pre aria-label={label} className="max-h-72 overflow-auto rounded-[var(--radius-control)] border border-line bg-raised p-3 font-mono text-xs leading-5 text-ink">
      {value === undefined ? "–" : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Value to sort by; columns without one are not sortable. */
  sort?: (row: T) => string | number;
  className?: string;
}

/** A table whose sortable headers are buttons (sort state announced via aria-sort). */
/** `minWidth`: below it the table scrolls sideways instead of squeezing columns (default 640px). */
export function DataTable<T>({ rows, columns, rowKey, caption, initialSort, minWidth = 640 }: { rows: T[]; columns: Column<T>[]; rowKey: (r: T) => string; caption: string; initialSort?: { key: string; dir: "asc" | "desc" }; minWidth?: number }) {
  const [sort, setSort] = useState(initialSort ?? null);
  const col = columns.find((c) => c.key === sort?.key);
  const sorted = col?.sort
    ? [...rows].sort((a, b) => {
        const x = col.sort!(a);
        const y = col.sort!(b);
        const d = x < y ? -1 : x > y ? 1 : 0;
        return sort!.dir === "asc" ? d : -d;
      })
    : rows;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-left">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th key={c.key} scope="col" aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined} className={`h-9 px-4 font-medium whitespace-nowrap text-muted ${c.className ?? ""}`}>
                  {c.sort ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded hover:text-ink"
                      onClick={() => setSort(active && sort!.dir === "desc" ? { key: c.key, dir: "asc" } : { key: c.key, dir: "desc" })}
                    >
                      {c.header}
                      <span aria-hidden="true" className="text-xs">
                        {active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {sorted.map((r) => (
            <tr key={rowKey(r)} className="hover:bg-raised/60">
              {columns.map((c) => (
                <td key={c.key} className={`px-4 py-2.5 align-middle whitespace-nowrap ${c.className ?? ""}`}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
