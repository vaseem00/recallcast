import "server-only";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";

/**
 * The TCP peer address for App Router route handlers.
 *
 * A route handler only gets a Web `Request`, never the socket, and Next fills X-Forwarded-For
 * with the socket address only when the client did not send one (`??=`), so XFF alone is
 * attacker-controlled on a direct deployment. installPeerStamp() (called from
 * src/instrumentation.ts) wraps http(s).Server#emit so that every incoming request gets a
 * PEER_HEADER set from `req.socket.remoteAddress` before Next sees it, overwriting any copy the
 * client sent. The value carries a per-process random secret, so a client-sent header can never
 * be mistaken for a stamped one (for example in a process where the stamp was not installed).
 */

export const PEER_HEADER = "x-recallcast-peer";

const SECRET_KEY = "__recallcastPeerSecret" as const;
const INSTALLED_KEY = "__recallcastPeerInstalled" as const;
type G = typeof globalThis & { [SECRET_KEY]?: string; [INSTALLED_KEY]?: boolean };

function secret(): string {
  const g = globalThis as G;
  if (!g[SECRET_KEY]) g[SECRET_KEY] = crypto.randomBytes(16).toString("hex");
  return g[SECRET_KEY];
}

/** The stamped header value for `addr` (also used by tests to simulate a socket address). */
export function peerHeaderValue(addr: string): string {
  return `${secret()} ${addr}`;
}

/** Overwrites PEER_HEADER with the socket's address (removing any client-sent value). */
export function stampPeer(req: Pick<IncomingMessage, "headers" | "socket">): void {
  const addr = req.socket?.remoteAddress;
  if (addr) req.headers[PEER_HEADER] = peerHeaderValue(addr);
  else delete req.headers[PEER_HEADER];
}

/** The socket address stamped on this request, or null when there is no valid stamp. */
export function readPeer(headers: Headers): string | null {
  const v = headers.get(PEER_HEADER);
  if (!v) return null;
  const prefix = `${secret()} `;
  if (!v.startsWith(prefix)) return null;
  const addr = v.slice(prefix.length).trim();
  return addr || null;
}

const STAMPED_EVENTS = new Set<string | symbol>(["request", "checkContinue", "checkExpectation"]);

/** Installs the stamp on every http/https server in this process. Idempotent; returns true on first install. */
export function installPeerStamp(): boolean {
  const g = globalThis as G;
  if (g[INSTALLED_KEY]) return false;
  for (const Server of [http.Server, https.Server]) {
    const proto = Server.prototype as unknown as { emit: (event: string | symbol, ...args: unknown[]) => boolean };
    const original = proto.emit;
    proto.emit = function emitWithPeer(this: unknown, event: string | symbol, ...args: unknown[]): boolean {
      if (STAMPED_EVENTS.has(event) && args[0] && typeof args[0] === "object") {
        try {
          stampPeer(args[0] as IncomingMessage);
        } catch {
          // Never break request handling; an unstamped request is rate-limited as "unknown".
        }
      }
      return original.call(this, event, ...args);
    };
  }
  g[INSTALLED_KEY] = true;
  return true;
}
