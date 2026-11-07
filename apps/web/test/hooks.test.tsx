import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApi, useEventStream, usePagedApi, type StreamEvent } from "../src/lib/hooks";
import { nav } from "../src/lib/nav";
import { FakeEventSource, deferred, json, run, stubEventSource, stubFetch } from "./helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useApi", () => {
  it("loads, then keeps the data visible while reloading", async () => {
    const second = deferred<Response>();
    let n = 0;
    stubFetch({ "GET /v1/thing": () => (++n === 1 ? json(200, { v: 1 }) : second.promise) });
    const { result } = renderHook(() => useApi<{ v: number }>("/v1/thing"));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));
    expect(result.current.loading).toBe(false);

    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual({ v: 1 });
    second.resolve(json(200, { v: 2 }));
    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }));
    expect(result.current.loading).toBe(false);
  });

  it("reports the API's error message and code", async () => {
    stubFetch({ "GET /v1/thing": json(404, { error: { code: "not_found", message: "Run not found" } }) });
    const { result } = renderHook(() => useApi("/v1/thing"));
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error).toMatchObject({ status: 404, code: "not_found", message: "Run not found" });
    expect(result.current.loading).toBe(false);
  });

  it("sends an expired session to sign-in, returning to the current page", async () => {
    window.history.replaceState(null, "", "/dashboard/runs?state=failed");
    const assign = vi.spyOn(nav, "assign").mockImplementation(() => undefined);
    stubFetch({ "GET /v1/thing": json(401, { error: { code: "unauthorized", message: "Sign in" } }) });
    renderHook(() => useApi("/v1/thing"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/sign-in?returnTo=%2Fdashboard%2Fruns%3Fstate%3Dfailed"));
  });

  it("does nothing for a null path", () => {
    const calls = stubFetch({});
    const { result } = renderHook(() => useApi(null));
    expect(result.current.loading).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("usePagedApi", () => {
  const page1 = { runs: [run({ id: "r1" })], nextCursor: "c1" };
  const page2 = { runs: [run({ id: "r2" })], nextCursor: null };

  it("appends the next page with the cursor, then stops at the end", async () => {
    const calls = stubFetch({ "GET /v1/runs?limit=1": json(200, page1), "GET /v1/runs?limit=1&cursor=c1": json(200, page2) });
    const { result } = renderHook(() => usePagedApi<{ id: string }>("/v1/runs?limit=1", "runs"));
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(["r1"]));
    expect(result.current.cursor).toBe("c1");
    expect(result.current.extended).toBe(false);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(["r1", "r2"]));
    expect(result.current.cursor).toBeNull();
    expect(result.current.extended).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(["/v1/runs?limit=1", "/v1/runs?limit=1&cursor=c1"]);
  });

  it("starts over when the filter changes, and ignores a page that arrives for the old filter", async () => {
    const late = deferred<Response>();
    stubFetch({
      "GET /v1/runs?limit=1": json(200, page1),
      "GET /v1/runs?limit=1&cursor=c1": () => late.promise,
      "GET /v1/runs?limit=1&state=failed": json(200, { runs: [run({ id: "f1", state: "failed" })], nextCursor: null }),
    });
    const { result, rerender } = renderHook(({ path }) => usePagedApi<{ id: string }>(path, "runs"), { initialProps: { path: "/v1/runs?limit=1" } });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.loadMore());
    expect(result.current.loadingMore).toBe(true);

    rerender({ path: "/v1/runs?limit=1&state=failed" });
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(["f1"]));
    expect(result.current.loadingMore).toBe(false);

    await act(async () => late.resolve(json(200, page2)));
    expect(result.current.rows.map((r) => r.id)).toEqual(["f1"]);
    expect(result.current.extended).toBe(false);
  });

  it("shows a failed page load without losing the rows already shown", async () => {
    stubFetch({ "GET /v1/runs?limit=1": json(200, page1), "GET /v1/runs?limit=1&cursor=c1": json(503, { error: { code: "unavailable", message: "Database unavailable" } }) });
    const { result } = renderHook(() => usePagedApi<{ id: string }>("/v1/runs?limit=1", "runs"));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.moreError?.message).toBe("Database unavailable"));
    expect(result.current.rows.map((r) => r.id)).toEqual(["r1"]);
    expect(result.current.cursor).toBe("c1");
    expect(result.current.loadingMore).toBe(false);
  });
});

describe("useEventStream", () => {
  beforeEach(stubEventSource);

  const event = (over: Partial<StreamEvent> = {}): StreamEvent => ({ id: 7, type: "task.started", runId: "r1", taskId: "t1", data: {}, createdAt: "2026-11-06T10:00:00.000Z", ...over });

  it("connects with credentials, reports live, and delivers parsed events", () => {
    const seen: StreamEvent[] = [];
    const { result } = renderHook(() => useEventStream({ onEvent: (e) => seen.push(e) }));
    const es = FakeEventSource.latest();
    expect(es.url).toBe("/api/v1/stream");
    expect(es.init).toEqual({ withCredentials: true });
    expect(result.current).toBe("connecting");

    act(() => es.open());
    expect(result.current).toBe("live");
    act(() => es.send("task.started", event()));
    act(() => es.send("run.succeeded", event({ id: 8, type: "run.succeeded", taskId: null })));
    act(() => es.send("task.started", "{not json"));
    expect(seen.map((e) => [e.id, e.type])).toEqual([
      [7, "task.started"],
      [8, "run.succeeded"],
    ]);
  });

  it("shows reconnecting while the browser retries, and unavailable once it gives up", () => {
    const { result } = renderHook(() => useEventStream({ onEvent: () => undefined }));
    const es = FakeEventSource.latest();
    act(() => es.open());
    act(() => es.drop());
    expect(result.current).toBe("reconnecting");
    act(() => es.open());
    expect(result.current).toBe("live");
    act(() => es.drop(true));
    expect(result.current).toBe("unavailable");
  });

  it("asks the page to reload on a reset", () => {
    const onReset = vi.fn();
    renderHook(() => useEventStream({ onEvent: () => undefined, onReset }));
    act(() => FakeEventSource.latest().send("reset", { cursor: 99 }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("uses the latest handler without reconnecting", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ onEvent }) => useEventStream({ onEvent }), { initialProps: { onEvent: first } });
    rerender({ onEvent: second });
    act(() => FakeEventSource.latest().send("task.started", event()));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("follows one run, reconnecting (as connecting) when the run changes, and closes on unmount", () => {
    const { result, rerender, unmount } = renderHook(({ runId }) => useEventStream({ runId, onEvent: () => undefined }), { initialProps: { runId: "a b" } });
    const first = FakeEventSource.latest();
    expect(first.url).toBe("/api/v1/stream?runId=a%20b");
    act(() => first.open());
    expect(result.current).toBe("live");

    rerender({ runId: "r2" });
    expect(first.closed).toBe(true);
    expect(FakeEventSource.latest().url).toBe("/api/v1/stream?runId=r2");
    expect(result.current).toBe("connecting");
    unmount();
    expect(FakeEventSource.latest().closed).toBe(true);
  });

  it("is unavailable, with no connection, when disabled", () => {
    const { result } = renderHook(() => useEventStream({ onEvent: () => undefined, enabled: false }));
    expect(result.current).toBe("unavailable");
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
