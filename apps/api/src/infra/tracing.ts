import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, ParentBasedSampler, SimpleSpanProcessor, TraceIdRatioBasedSampler, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { redactDbError } from "@flowforge/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

/*
 * Distributed tracing (ADR-017), with OpenTelemetry.
 *
 * Instrumentation uses only @opentelemetry/api, which is a no-op until initTracing()
 * registers an SDK, so with TRACING_ENABLED=false nothing is recorded or exported.
 *
 * A workflow run is one trace. submitRun stores the W3C trace context that was active
 * when the run was created; every lease carries it to the worker, and the SDK sends it
 * back (as the `traceparent` header) on that task's complete/fail/checkpoint calls, so
 * those requests join the run's trace. Maintenance work on a run (reaping an expired
 * lease, promoting a retry, resuming a stalled run) also starts its spans in the run's
 * trace. One trace therefore shows a run from submission to its last task, across every
 * worker and API instance.
 */

const VERSION = "0.1.0";
export const tracer = trace.getTracer("flowforge-api", VERSION);

export interface TracingOptions {
  serviceName: string;
  /** OTLP/HTTP base URL; spans go to `${endpoint}/v1/traces`. */
  endpoint: string;
  /** Fraction of new root traces sampled; sampled or unsampled parents are always followed. */
  sampleRatio: number;
  /** For tests: export synchronously to this exporter instead of OTLP. */
  exporter?: SpanExporter;
}

export interface TracingHandle {
  /** Flush buffered spans and stop exporting. */
  shutdown(): Promise<void>;
}

/** Register the OpenTelemetry SDK globally: tracer provider, async context, W3C propagation. */
export function initTracing(opts: TracingOptions): TracingHandle {
  const processor = opts.exporter
    ? new SimpleSpanProcessor(opts.exporter)
    : new BatchSpanProcessor(new OTLPTraceExporter({ url: `${opts.endpoint.replace(/\/+$/, "")}/v1/traces` }));
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": opts.serviceName, "service.version": VERSION }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(opts.sampleRatio) }),
    spanProcessors: [processor],
  });
  provider.register();
  return { shutdown: () => provider.shutdown() };
}

export interface SpanOptions {
  kind?: SpanKind;
  /** Parent context; defaults to the active one. */
  parent?: Context;
  links?: Link[];
}

/**
 * Run `fn` inside a new active span. Expected client errors (4xx AppErrors such as
 * lease_lost) are recorded as an attribute, not as span errors; anything else marks the
 * span failed.
 */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>, opts: SpanOptions = {}): Promise<T> {
  const parent = opts.parent ?? context.active();
  return tracer.startActiveSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes, links: opts.links ?? [] }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      const code = (err as { code?: unknown }).code;
      if (typeof status === "number" && status < 500) {
        span.setAttribute("flowforge.error.code", String(code));
      } else {
        // Never the raw error: a failed query's message carries its parameters (tenant data).
        const safe = redactDbError(err);
        span.recordException(safe instanceof Error ? safe : String(safe));
        span.setStatus({ code: SpanStatusCode.ERROR, message: safe instanceof Error ? safe.message : String(safe) });
      }
      throw err;
    } finally {
      span.end();
    }
  });
}

/** The active span's W3C traceparent, or null when tracing is off. */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ?? null;
}

/** A context whose parent is the given traceparent (e.g. a run's stored context). */
export function contextFromTraceparent(traceparent: string | null | undefined): Context | undefined {
  if (!traceparent) return undefined;
  const ctx = propagation.extract(ROOT_CONTEXT, { traceparent });
  return trace.getSpanContext(ctx) ? ctx : undefined;
}

/** A span link to the given traceparent, if it is valid. */
export function linkTo(traceparent: string | null | undefined): Link[] {
  const ctx = contextFromTraceparent(traceparent);
  const sc = ctx && trace.getSpanContext(ctx);
  return sc ? [{ context: sc }] : [];
}

/**
 * Describe the run (and task) the active span works on. If the span is not already in
 * the run's trace (a client that did not send the run's traceparent), link to it.
 */
export function annotateRun(run: { id: string; traceContext: string | null }, task?: { key: string; attempts: number }): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute("flowforge.run_id", run.id);
  if (task) span.setAttributes({ "flowforge.task.key": task.key, "flowforge.task.attempt": task.attempts });
  const [link] = linkTo(run.traceContext);
  if (link && link.context.traceId !== span.spanContext().traceId) span.addLink(link);
}

/** Trace and span ids of the active span, for log correlation (empty when none). */
export function logCorrelation(): Record<string, string> {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && trace.isSpanContextValid(sc) ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
}

/**
 * Server spans for every request, named by route template. Incoming `traceparent`
 * headers are honoured (that is how worker calls join their run's trace); rate limits
 * bound how many traces a client can force to be sampled. Must be registered before any
 * other onRequest hook so later hooks and handlers run inside the span.
 */
export function registerHttpTracing(app: FastifyInstance): void {
  const spans = new WeakMap<FastifyRequest, Span>();
  app.addHook("onRequest", (req, _reply, done) => {
    const parent = propagation.extract(context.active(), req.headers);
    const route = req.routeOptions.url ?? "unmatched";
    const span = tracer.startSpan(
      `${req.method} ${route}`,
      { kind: SpanKind.SERVER, attributes: { "http.request.method": req.method, "http.route": route, "url.path": req.url.split("?")[0] } },
      parent,
    );
    spans.set(req, span);
    // Fastify runs the remaining hooks and the handler from within done(), so they (and
    // every async continuation they create) see this span as active.
    context.with(trace.setSpan(parent, span), done);
  });
  const end = (req: FastifyRequest, status: number | null) => {
    const span = spans.get(req);
    if (!span) return;
    spans.delete(req);
    if (status === null) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "client aborted the request" });
    } else {
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  };
  app.addHook("onResponse", (req, reply, done) => {
    end(req, reply.statusCode);
    done();
  });
  app.addHook("onRequestAbort", (req, done) => {
    end(req, null);
    done();
  });
}
