import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunPage from "../src/app/dashboard/runs/[id]/page";
import RunsPage from "../src/app/dashboard/runs/page";
import SettingsPage from "../src/app/dashboard/settings/page";
import { SignInOptions } from "../src/app/sign-in/SignInOptions";
import { AppShell } from "../src/components/app/AppShell";
import { SessionProvider, useSession } from "../src/components/app/session";
import { DagView, type DagNodeView } from "../src/components/dag/DagView";
import { AttemptBadge, StatusBadge } from "../src/components/ui/StatusBadge";
import { ThemeToggle } from "../src/components/ui/ThemeToggle";
import { setSessionCsrf } from "../src/lib/api";
import { nav } from "../src/lib/nav";
import { FakeEventSource, json, run, stubEventSource, stubFetch, stubMatchMedia } from "./helpers";

// jsdom has <dialog> without showModal()/close(); enough of them for the Dialog component.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

const pathname = vi.hoisted(() => ({ value: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  pathname.value = "/dashboard";
  stubMatchMedia();
  stubEventSource();
});
afterEach(() => {
  cleanup();
  setSessionCsrf(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

const me = (role: "owner" | "viewer" = "owner") => ({
  user: { id: "u1", email: "ada@example.com", name: "Ada", avatarUrl: null },
  workspace: { id: "t1", slug: "acme", name: "Acme", role },
  workspaces: [{ id: "t1", slug: "acme", name: "Acme", role }],
  csrfToken: "csrf-1",
  sessionExpiresAt: "2026-12-06T00:00:00.000Z",
});

describe("DagView", () => {
  const nodes: DagNodeView[] = [
    { id: "extract", label: "extract", state: "succeeded", dependsOn: [] },
    { id: "clean", label: "clean", state: "running", dependsOn: ["extract"] },
    { id: "enrich", label: "enrich", state: "failed", detail: "attempt 3", dependsOn: ["extract"] },
    { id: "load", label: "load", state: "pending", dependsOn: ["clean", "enrich"] },
  ];
  const task = (name: RegExp) => screen.getByRole("button", { name });

  it("names each task with its state, so state never depends on colour", () => {
    render(<DagView nodes={nodes} label="Run tasks" />);
    expect(screen.getByRole("group", { name: "Run tasks" })).toBeTruthy();
    expect(task(/^enrich/).getAttribute("aria-label")).toBe("enrich: Failed, attempt 3");
    expect(task(/^load/).getAttribute("aria-label")).toBe("load: Waiting");
  });

  it("draws a definition (no run) without inventing a state", () => {
    render(<DagView nodes={nodes.map(({ state: _state, ...n }) => ({ ...n, detail: "e2e.step" }))} label="Workflow tasks" />);
    expect(task(/^extract/).getAttribute("aria-label")).toBe("extract, e2e.step");
    expect(screen.queryByText(/Waiting|Queued/)).toBeNull();
  });

  it("is one tab stop; arrow keys follow the graph and Enter selects", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<DagView nodes={nodes} label="Run tasks" onSelect={onSelect} selectedId="clean" />);
    const tabStops = screen.getAllByRole("button").filter((b) => b.getAttribute("tabindex") === "0");
    expect(tabStops.map((b) => b.getAttribute("aria-label"))).toEqual(["extract: Succeeded"]);

    await user.tab();
    expect(document.activeElement).toBe(task(/^extract/));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(task(/^clean/));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(task(/^enrich/));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(task(/^load/));
    // Back left: clean and enrich are equally near; ties go to the upper task.
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(task(/^clean/));
    await user.keyboard("{ArrowDown}");

    // The focused task is now the graph's only tab stop.
    expect(screen.getAllByRole("button").filter((b) => b.getAttribute("tabindex") === "0")).toEqual([task(/^enrich/)]);
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("enrich");
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(task(/^clean/).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("badges", () => {
  it("label attempts by how they ended, not by the task state they lead to", () => {
    render(
      <>
        <AttemptBadge outcome="lease_expired" />
        <AttemptBadge outcome="timed_out" />
        <AttemptBadge outcome="failed" />
        <StatusBadge state="retry_scheduled" />
      </>,
    );
    expect(screen.getByText("Lease expired")).toBeTruthy();
    expect(screen.getByText("Timed out")).toBeTruthy();
    expect(screen.getAllByText("Failed")).toHaveLength(1);
    expect(screen.getAllByText("Retrying")).toHaveLength(1);
  });
});

describe("ThemeToggle", () => {
  it("switches theme, remembers it, and follows changes made elsewhere", async () => {
    const user = userEvent.setup();
    document.documentElement.dataset.theme = "light";
    render(<ThemeToggle />);
    await user.click(screen.getByRole("button", { name: "Use dark theme" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("ff-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Use light theme" })).toBeTruthy();

    document.documentElement.dataset.theme = "light";
    await screen.findByRole("button", { name: "Use dark theme" });
  });

  it("follows the system setting while no theme is chosen", async () => {
    const media = stubMatchMedia({ "(prefers-color-scheme: dark)": false });
    render(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Use dark theme" })).toBeTruthy();
    act(() => media.set("(prefers-color-scheme: dark)", true));
    expect(screen.getByRole("button", { name: "Use light theme" })).toBeTruthy();
  });
});

describe("sign-in options", () => {
  it("links configured providers to the API, carrying where to return", async () => {
    stubFetch({
      "GET /auth/me": json(401, { error: { code: "unauthorized", message: "Sign in" } }),
      "GET /auth/providers": json(200, { providers: [{ id: "google", configured: true }, { id: "github", configured: false }] }),
    });
    render(<SignInOptions returnTo="/dashboard/runs?state=failed" />);
    expect(screen.getByLabelText("Loading sign-in options")).toBeTruthy();
    const google = await screen.findByRole("link", { name: /Continue with Google/ });
    expect(google.getAttribute("href")).toBe("/api/auth/google/start?returnTo=%2Fdashboard%2Fruns%3Fstate%3Dfailed");
    expect(screen.getByText("GitHub is not configured").closest("[aria-disabled]")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /GitHub/ })).toBeNull();
    expect(screen.queryByText(/No sign-in provider is configured/)).toBeNull();
  });

  it("explains when no provider is configured", async () => {
    stubFetch({
      "GET /auth/me": json(401, {}),
      "GET /auth/providers": json(200, { providers: [{ id: "google", configured: false }, { id: "github", configured: false }] }),
    });
    render(<SignInOptions returnTo="/dashboard" />);
    await screen.findByText(/No sign-in provider is configured/);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("says sign-in is unavailable when the API does not answer", async () => {
    stubFetch({ "GET /auth/me": () => Promise.reject(new TypeError("fetch failed")), "GET /auth/providers": () => Promise.reject(new TypeError("fetch failed")) });
    render(<SignInOptions returnTo="/dashboard" />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Sign-in is unavailable: the FlowForge API did not answer/);
  });

  it("sends a visitor who is already signed in straight on", async () => {
    const replace = vi.spyOn(nav, "replace").mockImplementation(() => undefined);
    stubFetch({ "GET /auth/me": json(200, me()), "GET /auth/providers": json(200, { providers: [] }) });
    render(<SignInOptions returnTo="/dashboard/workers" />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard/workers"));
  });
});

function WhoAmI() {
  const { me, can } = useSession();
  return (
    <p>
      {me.user.email} manage={String(can("manage"))} write={String(can("write"))}
    </p>
  );
}

describe("SessionProvider", () => {
  it("shows the fallback, then the page with the signed-in user and their role", async () => {
    stubFetch({ "GET /auth/me": json(200, me("viewer")) });
    render(
      <SessionProvider fallback={<p>Loading session</p>}>
        <WhoAmI />
      </SessionProvider>,
    );
    expect(screen.getByText("Loading session")).toBeTruthy();
    expect((await screen.findByText(/ada@example.com/)).textContent).toBe("ada@example.com manage=false write=false");
  });

  it("sends a visitor without a session to sign-in, returning here", async () => {
    window.history.replaceState(null, "", "/dashboard/runs/abc");
    const replace = vi.spyOn(nav, "replace").mockImplementation(() => undefined);
    stubFetch({ "GET /auth/me": json(401, { error: { code: "unauthorized", message: "Sign in" } }) });
    render(
      <SessionProvider fallback={<p>Loading session</p>}>
        <WhoAmI />
      </SessionProvider>,
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in?returnTo=%2Fdashboard%2Fruns%2Fabc"));
    expect(screen.queryByText(/ada@example.com/)).toBeNull();
  });

  it("says so when the API is unreachable instead of looping to sign-in", async () => {
    const replace = vi.spyOn(nav, "replace").mockImplementation(() => undefined);
    stubFetch({ "GET /auth/me": json(502, { error: { code: "bad_gateway", message: "API down" } }) });
    render(
      <SessionProvider fallback={<p>Loading session</p>}>
        <WhoAmI />
      </SessionProvider>,
    );
    await screen.findByRole("heading", { name: "The dashboard cannot reach FlowForge" });
    expect(replace).not.toHaveBeenCalled();
  });
});

function renderShell() {
  return render(
    <SessionProvider fallback={<p>Loading session</p>}>
      <AppShell>
        <p>Page body</p>
      </AppShell>
    </SessionProvider>,
  );
}

describe("AppShell", () => {
  it("marks the current page, and shows whether live updates are connected", async () => {
    pathname.value = "/dashboard/runs/abc";
    stubFetch({ "GET /auth/me": json(200, me()) });
    renderShell();
    await screen.findByText("Page body");
    const nav_ = screen.getByRole("navigation", { name: "Dashboard" });
    expect(within(nav_).getByRole("link", { name: "Runs" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav_).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByText("Connecting")).toBeTruthy();
    act(() => FakeEventSource.latest().open());
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("signs out through the API (with the CSRF token) before leaving", async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(nav, "assign").mockImplementation(() => undefined);
    document.cookie = "ff_csrf=csrf-1; path=/";
    const calls = stubFetch({ "GET /auth/me": json(200, me()), "POST /auth/logout": json(204) });
    renderShell();
    await user.click(await screen.findByRole("button", { name: /Ada/ }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    const logout = calls.find((c) => c.path === "/auth/logout")!;
    expect((logout.init.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf-1");
  });

  it("sends the CSRF token from /auth/me, even when the cookie holds an old one", async () => {
    const user = userEvent.setup();
    vi.spyOn(nav, "assign").mockImplementation(() => undefined);
    document.cookie = "ff_csrf=stale-from-before-a-secret-rotation; path=/";
    const calls = stubFetch({ "GET /auth/me": json(200, { ...me(), csrfToken: "current" }), "POST /auth/logout": json(204) });
    renderShell();
    await user.click(await screen.findByRole("button", { name: /Ada/ }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/auth/logout")).toBe(true));
    expect((calls.find((c) => c.path === "/auth/logout")!.init.headers as Record<string, string>)["x-csrf-token"]).toBe("current");
  });

  it("stays and says so when signing out fails", async () => {
    const user = userEvent.setup();
    const assign = vi.spyOn(nav, "assign").mockImplementation(() => undefined);
    stubFetch({ "GET /auth/me": json(200, me()), "POST /auth/logout": json(403, { error: { code: "csrf_failed", message: "Missing or invalid CSRF token" } }) });
    renderShell();
    await user.click(await screen.findByRole("button", { name: /Ada/ }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not sign out: Missing or invalid CSRF token");
    expect(assign).not.toHaveBeenCalled();
  });

  it("opens the navigation drawer with focus inside; Escape closes it and returns focus", async () => {
    const user = userEvent.setup();
    stubFetch({ "GET /auth/me": json(200, me()) });
    renderShell();
    const open = await screen.findByRole("button", { name: "Open navigation" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    await user.click(open);
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toBe("Overview");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("closes the drawer when the page changes", async () => {
    const user = userEvent.setup();
    stubFetch({ "GET /auth/me": json(200, me()) });
    const view = renderShell();
    await user.click(await screen.findByRole("button", { name: "Open navigation" }));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeTruthy();
    pathname.value = "/dashboard/workers";
    view.rerender(
      <SessionProvider fallback={<p>Loading session</p>}>
        <AppShell>
          <p>Page body</p>
        </AppShell>
      </SessionProvider>,
    );
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });
});

describe("runs page", () => {
  // The page reads searchParams with use(), so it suspends once: render inside an awaited act.
  const renderRuns = async (search: Record<string, string> = {}) => {
    const searchParams = Promise.resolve(search);
    await act(async () => {
      render(
        <Suspense fallback={<p>Loading page</p>}>
          <RunsPage searchParams={searchParams} />
        </Suspense>,
      );
    });
  };

  it("filters, searches and pages through runs", async () => {
    const user = userEvent.setup();
    const calls = stubFetch({
      "GET /v1/workflows": json(200, { workflows: [{ id: "w1", name: "etl" }, { id: "w2", name: "billing" }] }),
      "GET /v1/runs?limit=25&order=desc&workflow=etl": json(200, { runs: [run({ id: "00000000-0000-4000-8000-0000000000a1" })], nextCursor: "c1" }),
      "GET /v1/runs?limit=25&order=desc&workflow=etl&cursor=c1": json(200, { runs: [run({ id: "00000000-0000-4000-8000-0000000000a2" })], nextCursor: null }),
      "GET /v1/runs?limit=25&order=desc&state=failed&workflow=etl": json(200, { runs: [], nextCursor: null }),
      "GET /v1/runs?limit=25&order=desc&state=failed&workflow=etl&q=nightly-": json(200, { runs: [run({ id: "00000000-0000-4000-8000-0000000000f1", state: "failed", idempotencyKey: "nightly-7" })], nextCursor: null }),
    });
    // Arriving from a workflow's page preselects it.
    await renderRuns({ workflow: "etl" });
    await screen.findByText("1 shown");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("2 shown");
    expect(screen.getByText("That is every run.")).toBeTruthy();

    // A filter starts over from the first page.
    await user.click(screen.getByRole("radio", { name: "Failed" }));
    await screen.findByText("No runs match these filters");

    await user.type(screen.getByRole("textbox", { name: "Search by run id or idempotency key" }), " nightly- ");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("nightly-7");
    expect(calls.filter((c) => c.path.startsWith("/v1/runs")).map((c) => c.path)).toEqual([
      "/v1/runs?limit=25&order=desc&workflow=etl",
      "/v1/runs?limit=25&order=desc&workflow=etl&cursor=c1",
      "/v1/runs?limit=25&order=desc&state=failed&workflow=etl",
      "/v1/runs?limit=25&order=desc&state=failed&workflow=etl&q=nightly-",
    ]);
  });
});

describe("run page", () => {
  it("keeps a crafted run id inside the run's own API path", async () => {
    const crafted = "../workflows/etl/runs?x=";
    const enc = encodeURIComponent(crafted);
    const calls = stubFetch({
      "GET /auth/me": json(200, me()),
      [`GET /v1/runs/${enc}`]: json(400, { error: { code: "invalid_request", message: "Invalid run id" } }),
      [`GET /v1/runs/${enc}/events?limit=500`]: json(400, { error: { code: "invalid_request", message: "Invalid run id" } }),
    });
    const params = Promise.resolve({ id: crafted });
    await act(async () => {
      render(
        <SessionProvider fallback={<p>Loading session</p>}>
          <Suspense fallback={<p>Loading page</p>}>
            <RunPage params={params} />
          </Suspense>
        </SessionProvider>,
      );
    });
    await waitFor(() => expect(calls.filter((c) => c.path.startsWith("/v1/")).length).toBeGreaterThanOrEqual(2));
    expect(calls.filter((c) => c.path.startsWith("/v1/")).every((c) => c.path.startsWith(`/v1/runs/${enc}`))).toBe(true);
  });
});

describe("settings: removing a member", () => {
  const members = [
    { userId: "u1", email: "ada@example.com", name: "Ada", role: "owner", since: "2026-11-01T00:00:00.000Z" },
    { userId: "u2", email: "bob@example.com", name: "Bob", role: "member", since: "2026-11-02T00:00:00.000Z" },
    { userId: "u3", email: "cy@example.com", name: "Cy", role: "admin", since: "2026-11-03T00:00:00.000Z" },
  ];
  const renderSettings = (role: "owner" | "admin", extra: Record<string, Response | (() => Promise<Response>)> = {}) => {
    const session = { ...me(), workspace: { ...me().workspace, role }, workspaces: [{ ...me().workspace, role }] };
    if (role === "admin") session.user = { ...session.user, id: "u3", name: "Cy" };
    const calls = stubFetch({
      "GET /auth/me": json(200, session),
      "GET /v1/tenant": json(200, { quotas: {} }),
      "GET /v1/members": json(200, { members }),
      ...extra,
    });
    render(
      <SessionProvider fallback={<p>Loading session</p>}>
        <SettingsPage />
      </SessionProvider>,
    );
    return calls;
  };

  it("owners remove others after confirming; the list reloads", async () => {
    const user = userEvent.setup();
    const calls = renderSettings("owner", { "DELETE /v1/members/u2": json(204) });
    await user.click(await screen.findByRole("button", { name: "Remove Bob" }));
    expect(screen.queryByRole("button", { name: "Remove Ada" })).toBeNull(); // not yourself
    const dialog = screen.getByRole("dialog", { name: "Remove Bob from Acme?" });
    expect(dialog.textContent).toMatch(/API keys belong to the workspace/);
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/members/u2")).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.path === "/v1/members").length).toBe(2));
  });

  it("admins cannot remove owners or other admins, and a refusal is shown in the dialog", async () => {
    const user = userEvent.setup();
    renderSettings("admin", { "DELETE /v1/members/u2": json(409, { error: { code: "conflict", message: "Try again" } }) });
    await screen.findByRole("button", { name: "Remove Bob" });
    expect(screen.queryByRole("button", { name: "Remove Ada" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Cy" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove Bob" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Try again");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
