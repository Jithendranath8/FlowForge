"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { CodeBlock } from "./CodeBlock";

/** Files shown as tabs (arrow keys switch tabs, as in a WAI-ARIA tablist). */
export function CodeTabs({ files }: { files: { name: string; code: string }[] }) {
  const [active, setActive] = useState(0);
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (active + (e.key === "ArrowRight" ? 1 : files.length - 1)) % files.length;
    setActive(next);
    tabs.current[next]?.focus();
  };
  return (
    <div>
      <div role="tablist" aria-label="Example files" className="mb-2 flex gap-1" onKeyDown={onKey}>
        {files.map((f, i) => (
          <button
            key={f.name}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            role="tab"
            id={`${id}-tab-${i}`}
            aria-selected={i === active}
            aria-controls={`${id}-panel-${i}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            className={`h-8 rounded-[var(--radius-control)] px-3 font-mono text-[0.8125rem] ${i === active ? "bg-raised text-ink" : "text-muted hover:text-ink"}`}
          >
            {f.name}
          </button>
        ))}
      </div>
      {files.map((f, i) => (
        <div key={f.name} role="tabpanel" id={`${id}-panel-${i}`} aria-labelledby={`${id}-tab-${i}`} hidden={i !== active}>
          <CodeBlock code={f.code} title={`examples/quickstart/src/${f.name}`} />
        </div>
      ))}
    </div>
  );
}
