import type { IncomingMessage } from "node:http";

export type Trust = (addr: string, i: number) => boolean;
export function parseWebTrust(value?: string): Trust;
export function rewriteForwarding(req: Pick<IncomingMessage, "headers" | "socket"> & { rawHeaders?: string[] }, trust: Trust): string | undefined;
