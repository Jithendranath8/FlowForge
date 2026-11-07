import net from "node:net";

/**
 * A TCP proxy that can simulate a *hung* dependency: while paused, existing connections
 * stay open but no bytes flow in either direction and new connections are accepted but
 * not forwarded. That is what a frozen server or a black-holed network looks like to a
 * client (unlike a refused connection, which clients detect immediately).
 *
 * `latencyMs` adds a one-way delay to every forwarded chunk in both directions
 * (equal-delay timers fire in order, so byte order is preserved).
 */
export class FaultProxy {
  private server: net.Server;
  private readonly pairs = new Set<{ client: net.Socket; upstream: net.Socket | null }>();
  private paused = false;
  latencyMs = 0;
  private pending: (() => void)[] = [];
  port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {
    this.server = net.createServer((client) => this.accept(client));
  }

  static async start(target: string): Promise<FaultProxy> {
    const u = new URL(target);
    const p = new FaultProxy(u.hostname, Number(u.port));
    await new Promise<void>((resolve) => p.server.listen(0, "127.0.0.1", resolve));
    p.port = (p.server.address() as net.AddressInfo).port;
    return p;
  }

  /** Rewrite a postgres:// or redis:// URL to go through this proxy. */
  url(original: string): string {
    const u = new URL(original);
    u.hostname = "127.0.0.1";
    u.port = String(this.port);
    return u.toString();
  }

  private accept(client: net.Socket) {
    const pair = { client, upstream: null as net.Socket | null };
    this.pairs.add(pair);
    client.on("error", () => {});
    client.on("close", () => {
      pair.upstream?.destroy();
      this.pairs.delete(pair);
    });
    const connect = () => {
      if (client.destroyed) return;
      const upstream = net.connect(this.targetPort, this.targetHost);
      pair.upstream = upstream;
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => client.destroy());
      const forward = (to: net.Socket) => (d: Buffer) => {
        if (this.latencyMs <= 0) return void to.write(d);
        setTimeout(() => !to.destroyed && to.write(d), this.latencyMs);
      };
      client.on("data", forward(upstream));
      upstream.on("data", forward(client));
      if (this.paused) {
        client.pause();
        upstream.pause();
      }
    };
    if (this.paused) {
      client.pause();
      this.pending.push(connect);
    } else connect();
  }

  /** Freeze all traffic (existing and new connections). */
  pause() {
    this.paused = true;
    for (const p of this.pairs) {
      p.client.pause();
      p.upstream?.pause();
    }
  }

  resume() {
    this.paused = false;
    for (const p of this.pairs) {
      p.client.resume();
      p.upstream?.resume();
    }
    const pending = this.pending.splice(0);
    for (const connect of pending) connect();
  }

  async close() {
    for (const p of this.pairs) {
      p.client.destroy();
      p.upstream?.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
