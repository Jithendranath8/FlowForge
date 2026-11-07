import type { SVGProps } from "react";

/* A small, consistent icon set (1.75px strokes on a 20px grid). */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const Icon = {
  check: (p: IconProps) => <Svg {...p}><path d="M4.5 10.5l3.5 3.5 7.5-8" /></Svg>,
  cross: (p: IconProps) => <Svg {...p}><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" /></Svg>,
  retry: (p: IconProps) => <Svg {...p}><path d="M15.5 9.5a5.5 5.5 0 1 1-1.8-4.1" /><path d="M14 2.75v3h-3" /></Svg>,
  copy: (p: IconProps) => <Svg {...p}><rect x="7" y="7" width="9.5" height="9.5" rx="1.75" /><path d="M13 7V5.25A1.75 1.75 0 0 0 11.25 3.5h-5.5A1.75 1.75 0 0 0 4 5.25v5.5A1.75 1.75 0 0 0 5.75 12.5H7" /></Svg>,
  sun: (p: IconProps) => <Svg {...p}><circle cx="10" cy="10" r="3.25" /><path d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1.06 1.06M14.24 14.24l1.06 1.06M4.7 15.3l1.06-1.06M14.24 5.76l1.06-1.06" /></Svg>,
  moon: (p: IconProps) => <Svg {...p}><path d="M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2z" /></Svg>,
  external: (p: IconProps) => <Svg {...p}><path d="M11.5 3.5h5v5M16.5 3.5L9 11M14 11.5v3.75a1.25 1.25 0 0 1-1.25 1.25h-8a1.25 1.25 0 0 1-1.25-1.25v-8A1.25 1.25 0 0 1 4.75 6H8.5" /></Svg>,
  menu: (p: IconProps) => <Svg {...p}><path d="M3.5 6h13M3.5 10h13M3.5 14h13" /></Svg>,
  play: (p: IconProps) => <Svg {...p}><path d="M6.5 4.5v11l9-5.5z" /></Svg>,
  pause: (p: IconProps) => <Svg {...p}><path d="M7 4.5v11M13 4.5v11" /></Svg>,
  reset: (p: IconProps) => <Svg {...p}><path d="M4.5 9.5a5.5 5.5 0 1 1 1.8 4.1" /><path d="M6 17.25v-3h3" /></Svg>,
  bolt: (p: IconProps) => <Svg {...p}><path d="M11 2.5L4.5 11h5l-1 6.5 6.5-8.5h-5z" /></Svg>,
  server: (p: IconProps) => <Svg {...p}><rect x="3.5" y="3.5" width="13" height="5.5" rx="1.25" /><rect x="3.5" y="11" width="13" height="5.5" rx="1.25" /><path d="M6.5 6.25h.01M6.5 13.75h.01" /></Svg>,
  graph: (p: IconProps) => <Svg {...p}><rect x="2.5" y="8" width="4" height="4" rx="1" /><rect x="13.5" y="3.5" width="4" height="4" rx="1" /><rect x="13.5" y="12.5" width="4" height="4" rx="1" /><path d="M6.5 10h3l4-4.5M9.5 10l4 4.5" /></Svg>,
  list: (p: IconProps) => <Svg {...p}><path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9M3.75 5.5h.01M3.75 10h.01M3.75 14.5h.01" /></Svg>,
  clock: (p: IconProps) => <Svg {...p}><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 2" /></Svg>,
  gauge: (p: IconProps) => <Svg {...p}><path d="M3.5 13.5a6.5 6.5 0 1 1 13 0" /><path d="M10 13.5l3-4.5" /></Svg>,
  cog: (p: IconProps) => <Svg {...p}><circle cx="10" cy="10" r="2.5" /><path d="M10 2.75v1.75M10 15.5v1.75M2.75 10h1.75M15.5 10h1.75M4.9 4.9l1.24 1.24M13.86 13.86l1.24 1.24M4.9 15.1l1.24-1.24M13.86 6.14l1.24-1.24" /></Svg>,
  key: (p: IconProps) => <Svg {...p}><circle cx="7" cy="13" r="3.5" /><path d="M9.5 10.5l7-7M14 6l2 2M12 8l1.5 1.5" /></Svg>,
  search: (p: IconProps) => <Svg {...p}><circle cx="9" cy="9" r="5.5" /><path d="M13 13l3.5 3.5" /></Svg>,
  layers: (p: IconProps) => <Svg {...p}><path d="M10 3l7 4-7 4-7-4z" /><path d="M3 11l7 4 7-4" /></Svg>,
  shield: (p: IconProps) => <Svg {...p}><path d="M10 2.75l6 2.5v4.5c0 3.75-2.6 6.4-6 7.5-3.4-1.1-6-3.75-6-7.5v-4.5z" /></Svg>,
  logout: (p: IconProps) => <Svg {...p}><path d="M8 16.5H5.25A1.75 1.75 0 0 1 3.5 14.75v-9.5A1.75 1.75 0 0 1 5.25 3.5H8M13 13.5l3.5-3.5L13 6.5M16.5 10H8" /></Svg>,
  chevronDown: (p: IconProps) => <Svg {...p}><path d="M5.5 8l4.5 4.5L14.5 8" /></Svg>,
  arrowLeft: (p: IconProps) => <Svg {...p}><path d="M15.5 10h-11M9 4.5L3.5 10 9 15.5" /></Svg>,
  stop: (p: IconProps) => <Svg {...p}><rect x="5" y="5" width="10" height="10" rx="1.5" /></Svg>,
};

/** State glyph drawn in the state's colour (state is never conveyed by colour alone). */
export function StateGlyph({ icon, color, size = 12 }: { icon: string; color: string; size?: number }) {
  const s = size;
  switch (icon) {
    case "check":
      return <Icon.check size={s} style={{ color }} strokeWidth={2.25} />;
    case "cross":
      return <Icon.cross size={s} style={{ color }} strokeWidth={2.25} />;
    case "retry":
      return <Icon.retry size={s} style={{ color }} strokeWidth={2.25} />;
    case "dash":
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 6h6" stroke={color} strokeWidth={2} strokeLinecap="round" />
        </svg>
      );
    case "ring":
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="3.5" fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="2 1.6" />
        </svg>
      );
    case "pulse":
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="5" fill={color} opacity={0.25} className="animate-ff-pulse" />
          <circle cx="6" cy="6" r="3" fill={color} />
        </svg>
      );
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="3" fill={color} />
        </svg>
      );
  }
}
