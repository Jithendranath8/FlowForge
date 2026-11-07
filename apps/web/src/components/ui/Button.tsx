import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-control)] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const variants: Record<Variant, string> = {
  primary: "bg-ember text-ember-ink hover:bg-ember-hover",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-raised",
  ghost: "text-muted hover:bg-raised hover:text-ink",
  danger: "border border-line-strong bg-surface text-st-failed hover:bg-raised",
};
const sizes: Record<Size, string> = { sm: "h-8 px-2.5 text-sm", md: "h-10 px-4 text-[0.9375rem]" };

export function buttonClass(variant: Variant = "secondary", size: Size = "md", extra = "") {
  return `${base} ${variants[variant]} ${sizes[size]} ${extra}`;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; children: ReactNode }) {
  return (
    <button type="button" className={buttonClass(variant, size, className)} disabled={loading || rest.disabled} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function LinkButton({ href, variant = "secondary", size = "md", className = "", children }: { href: string; variant?: Variant; size?: Size; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}
