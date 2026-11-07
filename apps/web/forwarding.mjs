// Who is the client? The web server is the only component that holds the browser's TCP
// connection, so it must tell the API. Next.js's /api rewrite forwards the client's own
// X-Forwarded-For, X-Real-IP and Forwarded headers untouched and adds nothing, which let
// a client choose the address the API rate-limits by (or, without TRUST_PROXY, made every
// browser share the web server's address). server.mjs calls rewriteForwarding() on every
// request before Next sees it.
import proxyaddr from "@fastify/proxy-addr";

/**
 * WEB_TRUST_PROXY: which proxies in front of the web server may report the client's
 * address. "false" (default): none, so the socket address is the client. A number: that
 * many hops (a load balancer is 1). Otherwise comma-separated addresses, CIDRs or the
 * names loopback, linklocal, uniquelocal. "true" (trust anything) is refused.
 */
export function parseWebTrust(value = "false") {
  const v = String(value).trim();
  if (v === "" || v === "false") return () => false;
  if (v === "true") throw new Error('WEB_TRUST_PROXY=true would let any client choose its address; use a hop count or the proxy addresses');
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_addr, i) => i < hops;
  }
  const list = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return () => false;
  return proxyaddr.compile(list);
}

const STRIP = ["x-forwarded-for", "x-real-ip", "forwarded"];

/**
 * Replace the request's forwarding headers with one X-Forwarded-For entry: the client
 * address as far as the trusted proxies go. Returns that address.
 * `req` is a Node IncomingMessage (headers object and socket.remoteAddress).
 */
export function rewriteForwarding(req, trust) {
  const client = proxyaddr(req, trust);
  for (const h of STRIP) delete req.headers[h];
  // rawHeaders feed some proxies; keep them in step with headers.
  if (Array.isArray(req.rawHeaders)) {
    const kept = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!STRIP.includes(String(req.rawHeaders[i]).toLowerCase())) kept.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    req.rawHeaders.length = 0;
    req.rawHeaders.push(...kept);
  }
  if (client) {
    req.headers["x-forwarded-for"] = client;
    if (Array.isArray(req.rawHeaders)) req.rawHeaders.push("X-Forwarded-For", client);
  }
  return client;
}
