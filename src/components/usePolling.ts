"use client";

import { useEffect, useRef } from "react";

/**
 * Calls `tick` every `intervalMs` while `active` is true and the tab is visible. Ticks never
 * overlap (the next one is scheduled after the previous settles), a hidden tab pauses, and
 * coming back to the tab ticks at once. The AbortSignal fires on unmount or deactivation.
 */
export function usePolling(active: boolean, intervalMs: number, tick: (signal: AbortSignal) => Promise<void>) {
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  });

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;

    const schedule = () => {
      if (controller.signal.aborted) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, intervalMs);
    };

    async function run() {
      if (controller.signal.aborted || running) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return; // resumes on visibilitychange
      running = true;
      try {
        await tickRef.current(controller.signal);
      } catch {
        // tick handles its own errors; never break the loop
      } finally {
        running = false;
        schedule();
      }
    }

    const onVisible = () => {
      if (document.visibilityState === "visible" && !running) {
        if (timer) clearTimeout(timer);
        void run();
      }
    };

    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, intervalMs]);
}
