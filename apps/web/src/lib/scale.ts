/**
 * A y-axis for counts: the smallest "nice" step (1, 2, 2.5 or 5 × 10ⁿ) that covers
 * `max` in at most `maxIntervals` steps, so the tallest bar uses most of the height
 * instead of half of it. Counts never get fractional steps.
 */
export function niceScale(max: number, maxIntervals = 4): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const raw = max / maxIntervals;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw && Number.isInteger(s)) ?? Math.max(1, Math.ceil(raw));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { max: top, ticks };
}
