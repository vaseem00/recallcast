/**
 * Next.js instrumentation hook: runs once per server instance.
 * Installs the peer-address stamp used by the auth rate limits, starts the background job
 * worker and installs its SIGTERM/SIGINT handlers, in the Node.js runtime only, and never
 * during `next build` (Next may load this file while collecting page data).
 * startWorker() and installShutdownHandlers() are idempotent (globalThis guards) and never
 * throw; the extra try/catch keeps a failed import from taking the server down.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  try {
    // Stamps each request with its TCP peer address for the auth rate limits (see lib/auth/peer.ts).
    const { installPeerStamp } = await import("@/lib/auth/peer");
    installPeerStamp();
  } catch (err) {
    console.error("[auth] could not install the peer-address stamp; rate limits fall back to one shared bucket", err);
  }
  try {
    const { installShutdownHandlers, startWorker } = await import("@/lib/jobs/worker");
    // Re-queues jobs a previous process left 'running', then starts polling.
    startWorker();
    // Graceful shutdown: stop claiming, release running jobs' locks (sync), wait SHUTDOWN_GRACE_MS.
    installShutdownHandlers();
  } catch (err) {
    console.error("[jobs] could not start the worker", err);
  }
}
