"use client";

import { useState } from "react";
import { Icon } from "./icons";

/** Code with a copy button. `title` names the file or shell the code belongs to. */
export function CodeBlock({ code, title, language = "ts" }: { code: string; title?: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <figure className="overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
      <div className="flex h-9 items-center justify-between border-b border-line bg-raised px-3">
        <figcaption className="font-mono text-xs text-muted">{title ?? language}</figcaption>
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-control)] px-2 text-xs text-muted hover:bg-surface hover:text-ink"
          aria-label={copied ? "Copied" : `Copy ${title ?? "code"}`}
        >
          {copied ? <Icon.check size={14} /> : <Icon.copy size={14} />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-[0.8125rem] leading-6">
        <code className="font-mono">{code}</code>
      </pre>
    </figure>
  );
}
