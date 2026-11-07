import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDuration, formatRelative } from "../src/lib/format";
import { STREAM_EVENT_TYPES } from "../src/lib/hooks";
import { safeReturnTo } from "../src/lib/return-to";
import { niceScale } from "../src/lib/scale";
import { ATTEMPT_OUTCOMES } from "../src/lib/states";

/** Source files of other packages, from the repository root (Vitest's root). */
const repoFile = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("live stream event names", () => {
  it("match the engine's EventType union, so no event type is silently dropped", () => {
    const src = repoFile("apps/api/src/engine/history.ts");
    const union = /export type EventType =([^;]+);/.exec(src)?.[1];
    expect(union).toBeDefined();
    const engine = [...union!.matchAll(/"([a-z]+\.[a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(engine.length).toBeGreaterThan(10);
    expect([...STREAM_EVENT_TYPES].sort()).toEqual(engine);
  });
});

describe("attempt outcomes", () => {
  it("cover the outcomes the database allows", () => {
    const schema = repoFile("packages/db/src/schema.ts");
    const enumDef = /attemptOutcome\w*\s*=\s*pgEnum\(\s*"[^"]+",\s*\[([^\]]+)\]/.exec(schema)?.[1];
    expect(enumDef).toBeDefined();
    const db = [...enumDef!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect([...ATTEMPT_OUTCOMES].sort()).toEqual(db.sort());
  });
});

describe("safeReturnTo (where sign-in sends the visitor back to)", () => {
  it("keeps paths on this site, query included", () => {
    expect(safeReturnTo("/dashboard/runs?state=failed")).toBe("/dashboard/runs?state=failed");
    expect(safeReturnTo(["/dashboard/workers", "/x"])).toBe("/dashboard/workers");
  });

  it.each([
    ["absolute URL", "https://evil.example/"],
    ["scheme-relative", "//evil.example"],
    ["backslash", "/\\evil.example"],
    ["tab inside //", "/\t/evil.example"],
    ["newline inside //", "/\n/evil.example"],
    ["DEL", "/\x7f"],
    ["relative path", "dashboard"],
    ["empty", ""],
    ["too long", `/${"a".repeat(600)}`],
    ["missing", undefined],
  ])("rejects %s", (_name, value) => {
    expect(safeReturnTo(value)).toBe("/dashboard");
  });

  it("guards a real browser behaviour: URL parsing drops tabs, turning /<tab>/host into //host", () => {
    expect(new URL("/\t/evil.example", "https://app.example").host).toBe("evil.example");
  });
});

describe("format", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");
  it("relative times count from the given clock", () => {
    expect(formatRelative("2026-11-06T11:59:58.000Z", now)).toBe("just now");
    expect(formatRelative("2026-11-06T11:59:30.000Z", now)).toBe("30 s ago");
    expect(formatRelative("2026-11-06T11:55:00.000Z", now)).toBe("5 min ago");
    expect(formatRelative("2026-11-06T09:00:00.000Z", now)).toBe("3 h ago");
    expect(formatRelative("2026-11-06T12:00:30.000Z", now)).toBe("in 30 s");
    expect(formatRelative(null, now)).toBe("–");
  });
  it("durations pick a readable unit", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(4_200)).toBe("4.2 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatDuration(3_780_000)).toBe("1 h 3 min");
    expect(formatDuration(null)).toBe("–");
  });
});

describe("niceScale (chart y-axis)", () => {
  it.each([
    [265, 300, [0, 100, 200, 300]],
    [1040, 1500, [0, 500, 1000, 1500]],
    [3, 3, [0, 1, 2, 3]],
    [9, 10, [0, 5, 10]],
    [40, 40, [0, 10, 20, 30, 40]],
    [0, 1, [0, 1]],
  ])("max %d → axis to %d", (max, top, ticks) => {
    expect(niceScale(max)).toEqual({ max: top, ticks });
  });

  it("never wastes more than half the height, and never uses fractional counts", () => {
    for (let m = 1; m <= 5000; m += 7) {
      const s = niceScale(m);
      expect(s.max).toBeGreaterThanOrEqual(m);
      expect(m / s.max).toBeGreaterThan(0.5);
      expect(s.ticks.length).toBeLessThanOrEqual(6);
      expect(s.ticks.every(Number.isInteger)).toBe(true);
    }
  });
});
