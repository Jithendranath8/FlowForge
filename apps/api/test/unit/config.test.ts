import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";
import { generateApiKey, looksLikeApiKey, sha256 } from "../../src/auth/tokens.js";

const base = { DATABASE_URL: "postgres://u:p@localhost/db", SESSION_SECRET: "x".repeat(32) };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.API_PORT).toBe(4000);
    expect(c.allowedOrigins).toEqual(["http://localhost:3000"]);
    expect(c.RUN_MAINTENANCE).toBe(true);
  });

  it("lists every problem at once", () => {
    try {
      loadConfig({ SESSION_SECRET: "short", REDIS_URL: "http://nope" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).problems.join("\n");
      expect(msg).toMatch(/DATABASE_URL/);
      expect(msg).toMatch(/SESSION_SECRET: must be at least 32/);
      expect(msg).toMatch(/REDIS_URL/);
    }
  });

  it("requires OAuth id and secret together", () => {
    expect(() => loadConfig({ ...base, GITHUB_CLIENT_ID: "abc" })).toThrow(/GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET/);
  });

  it("requires https APP_URL in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/https/);
  });

  it("rejects leases that one missed heartbeat would expire", () => {
    expect(() => loadConfig({ ...base, LEASE_DURATION_MS: "15000", WORKER_HEARTBEAT_INTERVAL_MS: "10000" })).toThrow(/LEASE_DURATION_MS/);
  });

  it("normalises extra allowed origins", () => {
    expect(loadConfig({ ...base, ALLOWED_ORIGINS: "https://a.example/path, https://b.example" }).allowedOrigins).toEqual([
      "http://localhost:3000",
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("API keys", () => {
  it("generates well-formed keys whose stored hash is the SHA-256 of the key", () => {
    const k = generateApiKey();
    expect(looksLikeApiKey(k.key)).toBe(true);
    expect(k.key.startsWith(k.prefix)).toBe(true);
    expect(k.hash).toBe(sha256(k.key));
    expect(generateApiKey().key).not.toBe(k.key);
  });
});
