/** Error returned by the FlowForge API (or a transport failure, status 0). */
export class FlowForgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "FlowForgeError";
  }

  /** Network errors and 5xx/429 are worth retrying; 4xx are not. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface HttpOptions {
  apiUrl: string;
  apiKey: string;
  /** Per-request timeout (long-polls add their wait on top). */
  timeoutMs?: number;
  userAgent?: string;
}

export class HttpClient {
  private readonly base: string;
  constructor(private readonly opts: HttpOptions) {
    if (!opts.apiUrl) throw new Error("apiUrl is required");
    if (!opts.apiKey) throw new Error("apiKey is required");
    this.base = opts.apiUrl.replace(/\/+$/, "");
  }

  async request<T>(method: string, path: string, body?: unknown, extra: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(extra.timeoutMs ?? this.opts.timeoutMs ?? 30_000);
    const signal = extra.signal ? AbortSignal.any([extra.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          "user-agent": this.opts.userAgent ?? "flowforge-sdk/0.1.0",
        },
        body: body !== undefined ? JSON.stringify(body) : null,
        signal,
      });
    } catch (err) {
      throw new FlowForgeError(0, "network_error", err instanceof Error ? err.message : String(err));
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new FlowForgeError(res.status, "invalid_response", `Non-JSON response (${res.status})`);
      }
    }
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      throw new FlowForgeError(res.status, e?.code ?? "http_error", e?.message ?? `HTTP ${res.status}`, e?.details);
    }
    return json as T;
  }
}
