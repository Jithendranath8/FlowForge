import { describe, expect, it } from "vitest";
import { FixedWindowLimiter, clientKey, parseTrustProxy } from "../../src/http/limits.js";

describe("FixedWindowLimiter", () => {
  it("allows up to the limit per window, then refuses until the window resets", () => {
    let t = 0;
    const l = new FixedWindowLimiter({ limit: 3, windowMs: 1_000, now: () => t });
    expect([1, 2, 3].map(() => l.hit("a").allowed)).toEqual([true, true, true]);
    const over = l.hit("a");
    expect(over).toMatchObject({ allowed: false, remaining: 0, limit: 3, resetMs: 1_000 });
    expect(l.hit("b").allowed).toBe(true); // keys are independent
    t = 999;
    expect(l.hit("a").allowed).toBe(false);
    t = 1_000;
    expect(l.hit("a")).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("peek reports without counting", () => {
    let t = 0;
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 100, now: () => t });
    expect(l.peek("a").allowed).toBe(true);
    expect(l.peek("a").allowed).toBe(true);
    l.hit("a");
    expect(l.peek("a").allowed).toBe(true); // exactly at the limit
    l.hit("a");
    expect(l.peek("a")).toMatchObject({ allowed: false, resetMs: 100 });
    t = 100;
    expect(l.peek("a").allowed).toBe(true);
  });

  it("bounds memory under key churn", () => {
    const t = 0;
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 100, now: () => t });
    for (let i = 0; i < 10_000; i++) l.hit(`ip:${i}`);
    expect(l.size).toBeLessThanOrEqual(100);
  });

  it("under churn, evicts clients still within their limit before any blocked one", () => {
    let t = 0;
    const l = new FixedWindowLimiter({ limit: 2, windowMs: 60_000, maxKeys: 100, now: () => t });
    for (let i = 0; i < 3; i++) l.hit("ip:attacker");
    expect(l.peek("ip:attacker").remaining).toBe(0);
    // Flood with fresh keys, far beyond the cap, inside the same window.
    for (let i = 0; i < 5_000; i++) {
      t += 1;
      l.hit(`ip:spray-${i}`);
    }
    expect(l.size).toBeLessThanOrEqual(100);
    expect(l.peek("ip:attacker")).toMatchObject({ allowed: false, remaining: 0 });
  });

  it("drops blocked windows too when nothing else is left, so memory stays bounded", () => {
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10, now: () => 0 });
    for (let i = 0; i < 50; i++) {
      l.hit(`k${i}`);
      l.hit(`k${i}`);
    }
    expect(l.size).toBeLessThanOrEqual(10);
  });

  it("rejects nonsensical configuration", () => {
    expect(() => new FixedWindowLimiter({ limit: 0, windowMs: 1 })).toThrow(RangeError);
    expect(() => new FixedWindowLimiter({ limit: 1, windowMs: 0 })).toThrow(RangeError);
  });
});

describe("parseTrustProxy", () => {
  it("defaults to not trusting forwarded headers", () => {
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
  });
  it("supports true, hop counts and address lists", () => {
    expect(parseTrustProxy("true")).toBe(true);
    const hops = parseTrustProxy("2") as (a: string, i: number) => boolean;
    expect([0, 1, 2].map((i) => hops("x", i))).toEqual([true, true, false]);
    expect(parseTrustProxy("10.0.0.0/8, 127.0.0.1")).toEqual(["10.0.0.0/8", "127.0.0.1"]);
  });
});

describe("clientKey", () => {
  it("keys IPv4 clients by address and IPv4-mapped IPv6 as IPv4", () => {
    expect(clientKey("198.51.100.7")).toBe("ip:198.51.100.7");
    expect(clientKey("::ffff:198.51.100.7")).toBe("ip:198.51.100.7");
    expect(clientKey("::FFFF:198.51.100.7")).toBe("ip:198.51.100.7");
  });

  it("keys IPv6 clients by their /64, so one host cannot rotate through its addresses", () => {
    const k = clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(k).toBe("ip6:2001:db8:1:2::/64");
    expect(clientKey("2001:db8:1:2::1")).toBe(k);
    expect(clientKey("2001:0db8:0001:0002:0:0:0:ffff")).toBe(k);
    expect(clientKey("2001:db8:1:3::1")).not.toBe(k);
    expect(clientKey("2001:db8::1")).toBe("ip6:2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("ip6:0:0:0:0::/64");
    expect(clientKey("fe80::1%en0")).toBe("ip6:fe80:0:0:0::/64");
  });

  it("passes through anything that is not an IP address", () => {
    expect(clientKey("unknown")).toBe("ip:unknown");
    expect(clientKey("")).toBe("ip:");
  });
});
