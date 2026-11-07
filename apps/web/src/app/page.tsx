import Link from "next/link";
import { ArchitectureDiagram, RecoveryTimeline } from "@/components/site/Diagrams";
import { DemoPanel } from "@/components/site/DemoPanel";
import { SiteFooter, SiteHeader } from "@/components/site/SiteHeader";
import { LinkButton } from "@/components/ui/Button";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { CodeTabs } from "@/components/ui/CodeTabs";
import { installSteps, quickstart } from "@/lib/examples";

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 border-t border-line">
      <div className="mx-auto max-w-6xl px-5 py-16 md:py-20">
        <h2 id={`${id}-title`} className="text-2xl font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h2>
        {intro ? <p className="mt-3 max-w-[64ch] text-md text-muted">{intro}</p> : null}
        <div className="mt-8">{children}</div>
      </div>
    </section>
  );
}

const steps = [
  { title: "Define", text: "Describe tasks and their dependencies as a DAG, with retries, timeouts, resources and trigger rules. FlowForge validates it (no cycles, no missing dependencies) and stores an immutable version." },
  { title: "Submit", text: "Start a run with input and an optional idempotency key. Tasks with no dependencies are queued at once; the rest wait for theirs." },
  { title: "Schedule", text: "Workers long-poll for work. The scheduler leases runnable tasks to workers that serve the queue, have the capabilities and free CPU and memory, within run and workspace concurrency limits." },
  { title: "Execute", text: "Your handler runs on the worker. Heartbeats renew the lease; checkpoints let a retried attempt resume. The result is accepted only from the current lease holder." },
  { title: "Recover", text: "If a worker stops heartbeating, its lease expires and the task is retried elsewhere with backoff. Exhausted retries land in a dead-letter queue; a manual retry reopens the run." },
];

const capabilities = [
  { title: "DAG workflows", text: "Fan-out, fan-in and conditional branches (all_succeeded, all_done, any_failed). Versioned, validated definitions." },
  { title: "Leases and fencing", text: "Each attempt holds a lease with a fencing token, so a slow or partitioned worker can never overwrite a newer attempt's result." },
  { title: "Retries and dead letters", text: "Exponential backoff with jitter per task, non-retryable errors, a dead-letter queue and manual retry." },
  { title: "Timeouts and checkpoints", text: "Per-attempt deadlines enforced on both sides. Handlers save checkpoints that the next attempt receives." },
  { title: "Fair scheduling", text: "Priority with aging, per-run and per-workspace concurrency caps, capability and resource matching, fair maintenance across workspaces." },
  { title: "Multi-tenant by construction", text: "Every row is scoped to a workspace, enforced by composite foreign keys and per-workspace quotas and rate limits." },
  { title: "Live and durable history", text: "Every state change is an event in Postgres. The dashboard streams them live and resumes exactly where it left off after a reconnect." },
  { title: "Operable", text: "Prometheus metrics, OpenTelemetry traces (one trace per run), a Grafana dashboard and alert rules (with promtool tests) ship in the repository." },
];

const principles = [
  { title: "Postgres is the source of truth", text: "Every state change happens in one transaction with its history event. Redis carries wake-ups only; losing it slows pickup to about a second, and loses nothing." },
  { title: "At least once, honestly", text: "A task can run more than once (a worker can crash after doing the work). Every attempt gets the same idempotency key so you can make side effects safe to repeat." },
  { title: "Bounded under failure", text: "Database and Redis calls have deadlines; readiness answers within two seconds when a dependency hangs; maintenance keeps running when Redis is down." },
  { title: "Least privilege", text: "API keys are scoped (read, workflows, runs, worker) and stored as hashes. Dashboard sessions use HttpOnly cookies, PKCE sign-in and CSRF protection." },
  { title: "The API never runs your code", text: "Handlers run only in your workers. The API schedules, records and enforces; it executes nothing it receives." },
];

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <section aria-labelledby="hero-title" className="mx-auto grid max-w-6xl items-start gap-10 px-5 pt-12 pb-16 md:pt-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-12">
          <div className="lg:pt-6">
            <h1 id="hero-title" className="text-3xl font-semibold tracking-[-0.025em] text-balance text-ink sm:text-[2.75rem] sm:leading-[1.08]">
              Workflows that finish, even when workers fail.
            </h1>
            <p className="mt-5 max-w-[46ch] text-md text-muted">
              FlowForge runs your multi-step jobs as dependency graphs across many workers. It leases each task to one worker, notices when that worker disappears, and runs the task again elsewhere, without
              ever accepting a stale result.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <LinkButton href="#install" variant="primary">
                Run the quick start
              </LinkButton>
              <LinkButton href="/docs">Read the docs</LinkButton>
            </div>
            <p className="mt-6 max-w-[46ch] text-sm text-faint">TypeScript SDK and workers, an HTTP API, PostgreSQL and optional Redis. Open source.</p>
          </div>
          <DemoPanel />
        </section>

        <Section
          id="what"
          title="What FlowForge does"
          intro="Many jobs are really several steps with an order: extract, then clean and enrich in parallel, then load. Running them by hand-written queues and cron means re-building retries, timeouts, recovery and visibility every time."
        >
          <div className="grid gap-8 md:grid-cols-2">
            <p className="max-w-[60ch] text-md text-muted">
              FlowForge is the part in between. You declare the steps and how they depend on each other; FlowForge decides what can run now, hands it to a worker that can run it, and keeps a durable record of
              every attempt. Workers are your own processes, written with the SDK, running wherever your code needs to run.
            </p>
            <p className="max-w-[60ch] text-md text-muted">
              For engineering managers: work that spans many machines finishes or fails visibly, with the reason on record. For backend engineers: one HTTP API and a small SDK instead of a scheduler, a queue and a
              state store glued together.
            </p>
          </div>
        </Section>

        <Section id="how-it-works" title="How it works" intro="Five stages, from definition to recovery.">
          <ol className="grid gap-x-8 gap-y-8 md:grid-cols-5">
            {steps.map((s, i) => (
              <li key={s.title} className="relative">
                <div className="flex items-center gap-3">
                  <span className="tabular inline-flex size-7 items-center justify-center rounded-full border border-line-strong text-sm font-semibold text-ink">{i + 1}</span>
                  <h3 className="text-md font-semibold text-ink">{s.title}</h3>
                </div>
                <p className="mt-3 text-sm text-muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </Section>

        <Section id="architecture" title="Architecture" intro="Stateless API instances in front of PostgreSQL. Add API instances or workers as load grows; none of them holds state that would be lost if it stopped.">
          <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-surface p-4 md:p-6">
            <div className="min-w-[640px]">
              <ArchitectureDiagram />
            </div>
          </div>
        </Section>

        <Section id="capabilities" title="Engineering capabilities">
          <dl className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
            {capabilities.map((c) => (
              <div key={c.title} className="border-l-2 border-line pl-4">
                <dt className="text-md font-semibold text-ink">{c.title}</dt>
                <dd className="mt-1 text-sm text-muted">{c.text}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section id="reliability" title="Failure recovery" intro="A worker that crashes or loses its network stops heartbeating. FlowForge does not need it to say goodbye.">
          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <figure className="rounded-[var(--radius-panel)] border border-line bg-surface p-4 md:p-6">
              <div className="overflow-x-auto">
                <div className="min-w-[600px]">
                  <RecoveryTimeline />
                </div>
              </div>
              <figcaption className="mt-4 max-w-[70ch] text-sm text-muted">
                The late result is refused with 409 lease_lost, so the task keeps attempt 2&apos;s output. Both attempts carry the same idempotency key, so a side effect attempt 1 already caused can be made safe
                to repeat.
              </figcaption>
            </figure>
            <ul className="space-y-4 text-sm text-muted">
              <li>
                <strong className="font-semibold text-ink">Leases expire.</strong> A lease lasts 30 seconds by default and is renewed by heartbeats. When it lapses, the attempt is recorded as lease expired and the task
                is retried with backoff.
              </li>
              <li>
                <strong className="font-semibold text-ink">Results are fenced.</strong> Every lease carries a fencing token. Completions, failures, checkpoints and heartbeats from an older token are refused.
              </li>
              <li>
                <strong className="font-semibold text-ink">Shutdown is graceful.</strong> On SIGTERM a worker finishes in-flight tasks, then releases anything left so it is retried at once.
              </li>
              <li>
                <strong className="font-semibold text-ink">Tested with real processes.</strong> The test suite kills workers and API processes with SIGKILL, partitions the network and freezes the database, then
                checks that every run finishes and each task&apos;s result is recorded exactly once.
              </li>
            </ul>
          </div>
        </Section>

        <Section id="scheduling" title="Scheduling" intro="Deterministic rules you can inspect. Every lease is recorded with the strategy and score that placed it.">
          <div className="grid gap-8 md:grid-cols-2">
            <ul className="space-y-3 text-sm text-muted">
              <li>
                <strong className="font-semibold text-ink">Hard constraints first:</strong> queue, task type, required capabilities, free CPU and memory, the run&apos;s concurrency limit and the workspace&apos;s.
              </li>
              <li>
                <strong className="font-semibold text-ink">Then priority with aging,</strong> so long-waiting tasks rise and nothing starves.
              </li>
              <li>
                <strong className="font-semibold text-ink">Fair between runs:</strong> among equals, the run with the fewest running tasks goes first.
              </li>
              <li>
                <strong className="font-semibold text-ink">Atomic workspace limits:</strong> concurrent claims cannot overshoot a workspace&apos;s concurrency quota.
              </li>
            </ul>
            <p className="max-w-[60ch] text-sm text-muted">
              Each run of the scheduler stores a decision record: strategy, score and the worker chosen. FlowForge also keeps per-task-type duration statistics, which a predictive advisor can use to adjust
              scores within fixed bounds. The deterministic policy always decides what is allowed; the advisor can only reorder what is.
            </p>
          </div>
        </Section>

        <Section id="workers" title="Workers" intro="A worker is your process. It declares the task types it can run, how many at once and what resources it has, then long-polls the API.">
          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <ul className="space-y-3 text-sm text-muted">
              <li>Handlers receive the task input, the run input, the last checkpoint, an abort signal and an idempotency key.</li>
              <li>Return a value to complete the task; throw to fail it (retried by policy), or throw NonRetryableError to fail it for good.</li>
              <li>The SDK heartbeats, enforces the attempt timeout, retries reports through network errors and re-registers if the API marked the worker offline.</li>
              <li>Workers authenticate with a key that can only execute tasks for its own workspace.</li>
            </ul>
            <CodeBlock code={quickstart.worker} title="examples/quickstart/src/worker.ts" />
          </div>
        </Section>

        <Section id="example" title="A complete example" intro="The quick start, as it is in the repository: a workflow, a worker and a script that runs it.">
          <CodeTabs
            files={[
              { name: "workflow.ts", code: quickstart.workflow },
              { name: "worker.ts", code: quickstart.worker },
              { name: "run.ts", code: quickstart.run },
            ]}
          />
        </Section>

        <Section id="install" title="Install and run your first workflow" intro="About ten minutes on a machine with Node.js 22 and Docker. The repository's quick-start check (npm run check:quickstart) runs every command below, in order, on a fresh copy.">
          <ol className="space-y-8">
            {installSteps.map((s, i) => (
              <li key={s.title} className="grid gap-3 md:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] md:gap-8">
                <div className="flex gap-3">
                  <span className="tabular mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-line-strong text-sm font-semibold text-ink">{i + 1}</span>
                  <div>
                    <h3 className="text-md font-semibold text-ink">{s.title}</h3>
                    <p className="mt-1 text-sm text-muted">{s.detail}</p>
                  </div>
                </div>
                <CodeBlock code={s.code} title="shell" />
              </li>
            ))}
          </ol>
        </Section>

        <Section id="docs" title="Documentation">
          <ul className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["/docs/concepts", "Concepts", "Workflows, runs, tasks, attempts, leases."],
              ["/docs/workflows", "Workflow definitions", "Tasks, dependencies, retries, timeouts, resources."],
              ["/docs/workers", "Workers", "Handlers, checkpoints, idempotency, shutdown."],
              ["/docs/reliability", "Failure recovery", "What happens when a worker, the API or Redis fails."],
              ["/docs/api", "API reference", "Every endpoint, request and response."],
              ["/docs/operations", "Operations", "Metrics, tracing, alerts, retention, deployment checks."],
            ].map(([href, title, text]) => (
              <li key={href}>
                <Link href={href!} className="block rounded-[var(--radius-control)] py-2 hover:text-ink">
                  <span className="text-md font-medium text-ink underline decoration-line-strong underline-offset-4">{title}</span>
                  <span className="mt-1 block text-sm text-muted">{text}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>

        <Section id="principles" title="Security and reliability principles">
          <dl className="grid gap-x-10 gap-y-6 md:grid-cols-2">
            {principles.map((p) => (
              <div key={p.title}>
                <dt className="text-md font-semibold text-ink">{p.title}</dt>
                <dd className="mt-1 max-w-[60ch] text-sm text-muted">{p.text}</dd>
              </div>
            ))}
          </dl>
        </Section>
      </main>
      <SiteFooter />
    </>
  );
}
