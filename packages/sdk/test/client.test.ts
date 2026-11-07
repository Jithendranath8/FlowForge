import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FlowForgeClient, FlowForgeError, defineWorkflow } from "../src/index.js";
import { HttpClient } from "../src/http.js";
import { FakeApi } from "./fake-api.js";

let api: FakeApi;
beforeEach(async () => {
  api = await FakeApi.start();
});
afterEach(async () => {
  await api.close();
});

const KEY = `ffk_AAAAAAAA_${"A".repeat(43)}`;

describe("HttpClient", () => {
  it("sends the bearer key and JSON, and parses JSON replies", async () => {
    api.on("POST", /^\/echo$/, (r) => ({ body: { got: r.body } }));
    const http = new HttpClient({ apiUrl: `${api.url}///`, apiKey: KEY });
    expect(await http.request("POST", "/echo", { a: 1 })).toEqual({ got: { a: 1 } });
    const [req] = api.calls("POST", /^\/echo$/);
    expect(req!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req!.headers["content-type"]).toBe("application/json");
  });

  it("maps the API error envelope onto FlowForgeError", async () => {
    api.on("GET", /^\/bad$/, () => ({ status: 422, body: { error: { code: "invalid_workflow", message: "nope", details: { issues: [1] } } } }));
    const err = await new HttpClient({ apiUrl: api.url, apiKey: KEY }).request("GET", "/bad").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowForgeError);
    expect(err).toMatchObject({ status: 422, code: "invalid_workflow", message: "nope", details: { issues: [1] }, transient: false });
  });

  it("classifies 429, 5xx and network failures as transient, other 4xx as permanent", async () => {
    const http = new HttpClient({ apiUrl: api.url, apiKey: KEY });
    for (const [status, transient] of [[429, true], [500, true], [503, true], [400, false], [401, false], [409, false]] as const) {
      api.on("GET", /^\/s$/, () => ({ status, body: { error: { code: `c${status}`, message: "m" } } }));
      const err = (await http.request("GET", "/s").catch((e: unknown) => e)) as FlowForgeError;
      expect([err.status, err.transient]).toEqual([status, transient]);
    }
    const down = new HttpClient({ apiUrl: "http://127.0.0.1:1", apiKey: KEY });
    const net = (await down.request("GET", "/x").catch((e: unknown) => e)) as FlowForgeError;
    expect(net).toMatchObject({ status: 0, code: "network_error", transient: true });
  });

  it("enforces its request timeout against a hung server", async () => {
    api.on("GET", /^\/hang$/, () => ({ hang: true }));
    const t0 = performance.now();
    const err = (await new HttpClient({ apiUrl: api.url, apiKey: KEY, timeoutMs: 150 }).request("GET", "/hang").catch((e: unknown) => e)) as FlowForgeError;
    expect(err).toMatchObject({ status: 0, code: "network_error", transient: true });
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it("handles 204 and rejects non-JSON bodies", async () => {
    api.on("POST", /^\/empty$/, () => ({ status: 204 }));
    api.on("GET", /^\/html$/, () => ({ status: 502, raw: "<html>bad gateway</html>" }));
    const http = new HttpClient({ apiUrl: api.url, apiKey: KEY });
    expect(await http.request("POST", "/empty", {})).toBeUndefined();
    expect(await http.request("GET", "/html").catch((e: unknown) => e)).toMatchObject({ status: 502, code: "invalid_response" });
  });

  it("requires apiUrl and apiKey", () => {
    expect(() => new HttpClient({ apiUrl: "", apiKey: KEY })).toThrow(/apiUrl/);
    expect(() => new HttpClient({ apiUrl: api.url, apiKey: "" })).toThrow(/apiKey/);
  });
});

describe("defineWorkflow", () => {
  it("returns a valid definition unchanged", () => {
    const def = { name: "ok", tasks: [{ key: "a", type: "t" }] };
    expect(defineWorkflow(def)).toBe(def);
  });
  it("throws listing every issue for an invalid DAG", () => {
    expect(() =>
      defineWorkflow({ name: "bad", tasks: [{ key: "a", type: "t", dependsOn: ["b"] }, { key: "b", type: "t", dependsOn: ["a"] }] }),
    ).toThrow(/Invalid workflow "bad":\n {2}- Dependency cycle: /);
  });
});

describe("FlowForgeClient", () => {
  const client = () => new FlowForgeClient({ apiUrl: api.url, apiKey: KEY });
  const run = (state: string) => ({ id: "r1", state, input: {}, createdAt: "x", finishedAt: null });

  it("registers workflows and starts runs with an encoded path", async () => {
    api.on("PUT", /^\/v1\/workflows$/, () => ({ status: 201, body: { workflowId: "w", versionId: "v", version: 3, created: true } }));
    api.on("POST", /\/runs$/, () => ({ status: 201, body: { run: run("running") } }));
    expect((await client().registerWorkflow({ name: "x", tasks: [{ key: "a", type: "t" }] })).version).toBe(3);
    expect(await client().startRun("a b/c", { input: { day: 1 }, idempotencyKey: "k" })).toMatchObject({ id: "r1" });
    const [req] = api.calls("POST", /\/runs$/);
    expect(req!.path).toBe("/v1/workflows/a%20b%2Fc/runs");
    expect(req!.body).toEqual({ input: { day: 1 }, idempotencyKey: "k" });
  });

  it("builds list queries and calls cancel/retry", async () => {
    api.on("GET", /^\/v1\/runs/, () => ({ body: { runs: [], nextCursor: null } }));
    api.on("POST", /\/cancel$/, () => ({ body: { run: run("cancelled") } }));
    api.on("POST", /\/retry$/, () => ({ body: { task: { id: "t1", state: "queued" } } }));
    await client().listRuns({ state: "failed", limit: 5 });
    await client().listRuns();
    expect(api.calls("GET", /^\/v1\/runs/).map((r) => r.path)).toEqual(["/v1/runs?state=failed&limit=5", "/v1/runs"]);
    expect((await client().cancelRun("r1")).state).toBe("cancelled");
    expect((await client().retryTask("t1")).state).toBe("queued");
  });

  it("waitForRun polls until the run is terminal", async () => {
    let n = 0;
    api.on("GET", /^\/v1\/runs\/r1$/, () => ({ body: { run: run(++n < 3 ? "running" : "succeeded"), tasks: [] } }));
    expect((await client().waitForRun("r1", { intervalMs: 10 })).run.state).toBe("succeeded");
    expect(n).toBe(3);
  });

  it("waitForRun gives up after its timeout", async () => {
    api.on("GET", /^\/v1\/runs\/r1$/, () => ({ body: { run: run("running"), tasks: [] } }));
    await expect(client().waitForRun("r1", { timeoutMs: 80, intervalMs: 20 })).rejects.toThrow(/still running/);
  });
});
