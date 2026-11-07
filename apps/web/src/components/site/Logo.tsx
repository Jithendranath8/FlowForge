import Link from "next/link";

/** The FlowForge mark: one task fanning out to two and joining again (a diamond DAG). */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 12h3.5M13.5 6.5L10.5 12l3 5.5" fill="none" stroke="var(--ember)" strokeWidth={1.75} strokeLinecap="round" />
      <path d="M16.5 6.5h1.5M16.5 17.5h1.5" fill="none" stroke="var(--ember)" strokeWidth={1.75} strokeLinecap="round" opacity={0.55} />
      <rect x="2" y="9.5" width="5" height="5" rx="1.4" fill="var(--ember)" />
      <rect x="13.5" y="4" width="5" height="5" rx="1.4" fill="none" stroke="var(--ember)" strokeWidth={1.75} />
      <rect x="13.5" y="15" width="5" height="5" rx="1.4" fill="none" stroke="var(--ember)" strokeWidth={1.75} />
    </svg>
  );
}

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 rounded-[var(--radius-control)] text-[0.9375rem] font-semibold tracking-[-0.01em] text-ink">
      <LogoMark />
      FlowForge
    </Link>
  );
}
