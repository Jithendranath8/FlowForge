/** Formatting for the dashboard. All times come from the API in UTC and show in local time. */

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const s = ms / 1_000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** `now` comes from useNow() in components, so render stays pure and the text keeps counting. */
export function formatRelative(iso: string | null | undefined, now: number): string {
  if (!iso) return "–";
  const diff = Math.round((now - new Date(iso).getTime()) / 1000);
  const abs = Math.abs(diff);
  const unit = abs < 60 ? [abs, "s"] : abs < 3600 ? [Math.round(abs / 60), "min"] : abs < 86_400 ? [Math.round(abs / 3600), "h"] : [Math.round(abs / 86_400), "d"];
  if (abs < 5) return "just now";
  return diff >= 0 ? `${unit[0]} ${unit[1]} ago` : `in ${unit[0]} ${unit[1]}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const shortId = (id: string) => id.slice(0, 8);
