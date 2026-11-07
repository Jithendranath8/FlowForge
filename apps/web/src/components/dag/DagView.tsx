"use client";

import { useMemo, useRef, type KeyboardEvent } from "react";
import { DEFAULT_LAYOUT, layoutDag, type LayoutOptions } from "@/lib/dag-layout";
import { STATE_STYLE, type TaskState } from "@/lib/states";

export interface DagNodeView {
  id: string;
  label: string;
  /** Second line, e.g. "attempt 2" or the task type. */
  detail?: string;
  /** A run's task state; omitted for a definition, which has no state. */
  state?: TaskState;
  dependsOn: readonly string[];
}

/**
 * A workflow graph. Tasks are buttons (Tab reaches the graph; arrow keys move along it:
 * left/right follow dependencies, up/down move within a layer; Enter/Space selects).
 * State is shown by the glyph and label as well as colour.
 */
export function DagView({
  nodes,
  selectedId,
  onSelect,
  layout = DEFAULT_LAYOUT,
  label,
}: {
  nodes: readonly DagNodeView[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  layout?: LayoutOptions;
  /** Accessible name of the graph. */
  label: string;
}) {
  const placed = useMemo(() => layoutDag(nodes.map((n) => ({ id: n.id, dependsOn: n.dependsOn })), layout), [nodes, layout]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const refs = useRef(new Map<string, SVGGElement>());
  const pad = 2;

  const move = (from: string, key: string) => {
    const at = placed.nodes.find((n) => n.id === from);
    if (!at) return;
    let target: string | undefined;
    if (key === "ArrowUp" || key === "ArrowDown") {
      const same = placed.nodes.filter((n) => n.layer === at.layer).sort((a, b) => a.row - b.row);
      target = same[at.row + (key === "ArrowDown" ? 1 : -1)]?.id;
    } else {
      const layer = at.layer + (key === "ArrowRight" ? 1 : -1);
      const candidates = placed.nodes.filter((n) => n.layer === layer);
      const linked = candidates.filter((n) => placed.edges.some((e) => (e.from === from && e.to === n.id) || (e.to === from && e.from === n.id)));
      const pool = linked.length ? linked : candidates;
      target = pool.sort((a, b) => Math.abs(a.y - at.y) - Math.abs(b.y - at.y))[0]?.id;
    }
    if (target) refs.current.get(target)?.focus();
  };

  const onKey = (id: string) => (e: KeyboardEvent<SVGGElement>) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      move(id, e.key);
    } else if ((e.key === "Enter" || e.key === " ") && onSelect) {
      e.preventDefault();
      onSelect(id);
    }
  };

  return (
    <svg
      role="group"
      aria-label={label}
      viewBox={`${-pad} ${-pad} ${placed.width + pad * 2} ${placed.height + pad * 2}`}
      className="h-auto w-full max-w-full overflow-visible"
      style={{ maxHeight: placed.height + 40 }}
    >
      <g aria-hidden="true">
        {placed.edges.map((e) => {
          const target = byId.get(e.to)!.state;
          const source = byId.get(e.from)!.state;
          const active = target === "running" || (source === "succeeded" && target === "queued");
          return (
            <path
              key={`${e.from}-${e.to}`}
              d={e.path}
              fill="none"
              stroke={active ? "var(--st-running)" : "var(--line-strong)"}
              strokeWidth={active ? 1.75 : 1.25}
              strokeDasharray={active ? "4 4" : undefined}
              className={active ? "animate-ff-flow" : undefined}
            />
          );
        })}
      </g>
      {placed.nodes.map((p) => {
        const n = byId.get(p.id)!;
        const s = n.state ? STATE_STYLE[n.state] : null;
        const selected = selectedId === n.id;
        const textX = s ? 32 : 16;
        return (
          <g
            key={n.id}
            ref={(el) => {
              if (el) refs.current.set(n.id, el);
              else refs.current.delete(n.id);
            }}
            transform={`translate(${p.x} ${p.y})`}
            role="button"
            tabIndex={p.layer === 0 && p.row === 0 ? 0 : -1}
            aria-label={`${n.label}${s ? `: ${s.label}` : ""}${n.detail ? `, ${n.detail}` : ""}`}
            aria-pressed={onSelect ? selected : undefined}
            onClick={onSelect ? () => onSelect(n.id) : undefined}
            onKeyDown={onKey(n.id)}
            onFocus={(e) => {
              // Roving tab stop: the focused task becomes the graph's tab stop.
              for (const el of refs.current.values()) el.setAttribute("tabindex", "-1");
              e.currentTarget.setAttribute("tabindex", "0");
            }}
            className="cursor-pointer outline-none [&:focus-visible>rect:first-child]:stroke-[var(--focus)] [&:focus-visible>rect:first-child]:stroke-2"
          >
            <rect
              width={layout.nodeWidth}
              height={layout.nodeHeight}
              rx={8}
              fill="var(--surface)"
              stroke={selected ? "var(--ink)" : "var(--line-strong)"}
              strokeWidth={selected ? 1.75 : 1}
            />
            {s ? (
              <>
                <rect x={0} y={0} width={4} height={layout.nodeHeight} rx={2} fill={s.color} />
                <g transform={`translate(14 ${layout.nodeHeight / 2 - 6})`}>
                  <StateMark icon={s.icon} color={s.color} />
                </g>
              </>
            ) : null}
            <text x={textX} y={n.detail ? layout.nodeHeight / 2 - 3 : layout.nodeHeight / 2 + 4} fontSize={13} fontWeight={500} fill="var(--ink)" fontFamily="var(--font-sans)">
              {n.label}
            </text>
            {n.detail ? (
              <text x={textX} y={layout.nodeHeight / 2 + 12} fontSize={11} fill="var(--muted)" fontFamily="var(--font-sans)">
                {n.detail}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** The state glyph drawn inside SVG (12×12). */
function StateMark({ icon, color }: { icon: string; color: string }) {
  switch (icon) {
    case "check":
      return <path d="M2 6.5l2.6 2.6L10 3.5" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />;
    case "cross":
      return <path d="M3 3l6 6M9 3l-6 6" stroke={color} strokeWidth={2} strokeLinecap="round" />;
    case "retry":
      return (
        <g fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 6a4 4 0 1 1-1.3-2.95" />
          <path d="M9.2 1v2.3H6.9" />
        </g>
      );
    case "dash":
      return <path d="M3 6h6" stroke={color} strokeWidth={2} strokeLinecap="round" />;
    case "ring":
      return <circle cx={6} cy={6} r={3.5} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="2 1.6" />;
    case "pulse":
      return (
        <g>
          <circle cx={6} cy={6} r={5.5} fill={color} opacity={0.22} className="animate-ff-pulse" />
          <circle cx={6} cy={6} r={3.25} fill={color} />
        </g>
      );
    default:
      return <circle cx={6} cy={6} r={3.25} fill={color} />;
  }
}
