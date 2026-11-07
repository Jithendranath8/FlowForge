import { ATTEMPT_STYLE, STATE_STYLE, type AttemptOutcome, type StateStyle, type TaskState } from "@/lib/states";
import { StateGlyph } from "./icons";

function Badge({ s, size }: { s: StateStyle; size: "sm" | "xs" }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 font-medium ${size === "xs" ? "h-5 text-xs" : "h-6 text-sm"}`}
      style={{ color: s.color, borderColor: `color-mix(in srgb, ${s.color} 35%, transparent)`, background: `color-mix(in srgb, ${s.color} 9%, transparent)` }}
    >
      <StateGlyph icon={s.icon} color={s.color} size={size === "xs" ? 10 : 12} />
      {s.label}
    </span>
  );
}

/** A task or run state: glyph + label in the state's colour, never colour alone. */
export function StatusBadge({ state, size = "sm" }: { state: TaskState; size?: "sm" | "xs" }) {
  return <Badge s={STATE_STYLE[state]} size={size} />;
}

/** How one attempt ended, labelled by its actual outcome. */
export function AttemptBadge({ outcome, size = "xs" }: { outcome: AttemptOutcome; size?: "sm" | "xs" }) {
  return <Badge s={ATTEMPT_STYLE[outcome]} size={size} />;
}
