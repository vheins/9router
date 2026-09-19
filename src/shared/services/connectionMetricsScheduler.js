// Background refresher for the per-connection 24h rolling metrics consumed by
// the `auto` routing strategy. In-process, fail-open.
//
// The routing hot path reads the cache synchronously (getConnectionMetrics24hCached)
// — this scheduler is the only writer, so no request ever pays for the aggregate
// query. Mirrors quotaAutoToggle.js (global singleton + interval + failure cache).
import { refreshConnectionMetrics24h } from "@/lib/db/index.js";
import { CONNECTION_METRICS_CONFIG } from "@/shared/constants/config";

const C = CONNECTION_METRICS_CONFIG;

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__connectionMetricsScheduler ??= {
  interval: null,
  initialTimer: null,
  running: false,
  failureCount: 0,
  lastRefreshAt: 0,
});

async function refreshTick() {
  if (g.running) return;
  g.running = true;
  try {
    await refreshConnectionMetrics24h({ force: true });
    g.failureCount = 0;
    g.lastRefreshAt = Date.now();
  } catch (e) {
    g.failureCount += 1;
    console.warn("[ConnectionMetrics] refresh failed:", e?.message || e);
  } finally {
    g.running = false;
  }
}

export function startConnectionMetricsScheduler() {
  if (g.interval || g.initialTimer) return;
  console.log("[ConnectionMetrics] scheduler started");
  g.initialTimer = setTimeout(() => {
    g.initialTimer = null;
    refreshTick().catch(() => {});
  }, C.initialDelayMs);
  g.initialTimer?.unref?.();
  g.interval = setInterval(() => {
    refreshTick().catch(() => {});
  }, C.refreshIntervalMs);
  g.interval?.unref?.();
}

export function stopConnectionMetricsScheduler() {
  if (g.initialTimer) { clearTimeout(g.initialTimer); g.initialTimer = null; }
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[ConnectionMetrics] scheduler stopped");
}

// Exposed for tests and diagnostics.
export function getConnectionMetricsSchedulerState() {
  return { running: g.running, failureCount: g.failureCount, lastRefreshAt: g.lastRefreshAt };
}
