import { describe, expect, it } from "vitest";
import { parseWebTrust, rewriteForwarding } from "../forwarding.mjs";

/** A request as the web server receives it: socket peer plus whatever headers arrived. */
function request(socket: string, headers: Record<string, string>) {
  const rawHeaders = Object.entries(headers).flatMap(([k, v]) => [k, v]);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { socket: { remoteAddress: socket }, headers: lower as Record<string, string | string[] | undefined>, rawHeaders } as unknown as Parameters<typeof rewriteForwarding>[0] & {
    headers: Record<string, string | undefined>;
    rawHeaders: string[];
  };
}

const forged = { "X-Forwarded-For": "6.6.6.6, 7.7.7.7", "X-Real-IP": "8.8.8.8", Forwarded: "for=9.9.9.9", Accept: "*/*" };

describe("rewriteForwarding", () => {
  it("with no trusted proxy (the default), the socket is the client and forged headers are dropped", () => {
    const req = request("198.51.100.7", forged);
    expect(rewriteForwarding(req, parseWebTrust())).toBe("198.51.100.7");
    expect(req.headers["x-forwarded-for"]).toBe("198.51.100.7");
    expect(req.headers["x-real-ip"]).toBeUndefined();
    expect(req.headers.forwarded).toBeUndefined();
    expect(req.rawHeaders).toEqual(["Accept", "*/*", "X-Forwarded-For", "198.51.100.7"]);
  });

  it("a request with no forwarding headers still tells the API who the client is", () => {
    const req = request("203.0.113.9", { Accept: "*/*" });
    rewriteForwarding(req, parseWebTrust("false"));
    expect(req.headers["x-forwarded-for"]).toBe("203.0.113.9");
  });

  it("behind one load balancer, takes the address it appended and drops what the client wrote", () => {
    const req = request("10.0.0.5", { "X-Forwarded-For": "6.6.6.6, 198.51.100.7" });
    expect(rewriteForwarding(req, parseWebTrust("1"))).toBe("198.51.100.7");
    expect(req.headers["x-forwarded-for"]).toBe("198.51.100.7");
  });

  it("trusts listed proxy addresses only: a direct connection cannot forge its address", () => {
    const trust = parseWebTrust("10.0.0.0/8");
    const viaBalancer = request("10.0.0.5", { "X-Forwarded-For": "6.6.6.6, 198.51.100.7" });
    expect(rewriteForwarding(viaBalancer, trust)).toBe("198.51.100.7");
    const direct = request("203.0.113.9", { "X-Forwarded-For": "198.51.100.7" });
    expect(rewriteForwarding(direct, trust)).toBe("203.0.113.9");
  });

  it("refuses to trust every hop", () => {
    expect(() => parseWebTrust("true")).toThrow(/choose its address/);
  });
});
