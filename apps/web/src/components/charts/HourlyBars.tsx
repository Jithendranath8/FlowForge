"use client";

import { useState } from "react";
import { niceScale } from "@/lib/scale";

export interface Series {
  key: string;
  label: string;
  color: string;
}

/**
 * Stacked bars per hour. One y-axis, a legend for every series, a tooltip on hover or
 * focus, and a table view for exact numbers.
 */
export function HourlyBars({ buckets, series, title }: { buckets: { start: string; values: Record<string, number> }[]; series: Series[]; title: string }) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const totals = buckets.map((b) => series.reduce((a, s) => a + (b.values[s.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const scale = niceScale(max);
  const niceMax = scale.max;
  const W = 640;
  const H = 180;
  const left = 34;
  const bottom = 22;
  const bw = (W - left) / buckets.length;
  const top = 10; // room for the top axis label
  const y = (v: number) => top + (H - bottom - top) * (1 - v / niceMax);
  const hour = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <figure>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-sm font-semibold text-ink">{title}</figcaption>
        <div className="flex items-center gap-3">
          <ul className="flex flex-wrap gap-3" aria-label="Legend">
            {series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5 text-xs text-muted">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
                {s.label}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setAsTable((t) => !t)} className="text-xs text-muted underline underline-offset-2 hover:text-ink">
            {asTable ? "Show chart" : "Show table"}
          </button>
        </div>
      </div>
      {asTable ? (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="text-left text-muted">
                <th scope="col" className="py-1 pr-4 font-medium">Hour</th>
                {series.map((s) => (
                  <th key={s.key} scope="col" className="py-1 pr-4 text-right font-medium">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.start} className="border-t border-line">
                  <td className="tabular py-1 pr-4">{hour(b.start)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="tabular py-1 pr-4 text-right">{b.values[s.key] ?? 0}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}. Use "Show table" for the numbers.`}>
            {scale.ticks.map((v) => (
              <g key={v}>
                <line x1={left} x2={W} y1={y(v)} y2={y(v)} stroke="var(--line)" />
                <text x={left - 6} y={y(v) + 4} fontSize={10} textAnchor="end" fill="var(--faint)" className="tabular">
                  {Number.isInteger(v) ? v : v.toFixed(1)}
                </text>
              </g>
            ))}
            {buckets.map((b, i) => {
              let acc = 0;
              const x = left + i * bw + Math.max(1, bw * 0.15);
              const w = Math.max(2, bw * 0.7);
              return (
                <g
                  key={b.start}
                  tabIndex={0}
                  role="button"
                  aria-label={`${hour(b.start)}: ${series.map((s) => `${s.label} ${b.values[s.key] ?? 0}`).join(", ")}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className="outline-none"
                >
                  <rect x={left + i * bw} y={top} width={bw} height={H - bottom - top} fill={active === i ? "var(--raised)" : "transparent"} />
                  {series.map((s) => {
                    const v = b.values[s.key] ?? 0;
                    if (!v) return null;
                    const top = y(acc + v);
                    const h = y(acc) - top;
                    acc += v;
                    return <rect key={s.key} x={x} y={top} width={w} height={Math.max(1, h - 1)} rx={2} fill={s.color} />;
                  })}
                  {i % Math.ceil(buckets.length / 8) === 0 ? (
                    <text x={x + w / 2} y={H - 6} fontSize={10} textAnchor="middle" fill="var(--faint)">
                      {hour(b.start)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {active !== null ? (
            <div
              className="pointer-events-none absolute top-0 z-10 min-w-36 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2 text-xs shadow-[var(--shadow-pop)]"
              style={{ left: `${Math.min(70, ((left + active * bw) / W) * 100)}%` }}
            >
              <p className="font-medium text-ink">{hour(buckets[active]!.start)}</p>
              {series.map((s) => (
                <p key={s.key} className="tabular flex justify-between gap-4 text-muted">
                  <span>{s.label}</span>
                  <span className="text-ink">{buckets[active]!.values[s.key] ?? 0}</span>
                </p>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </figure>
  );
}
