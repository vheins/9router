// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  statsEmitter, trackPendingRequest, getActiveRequests, getConnectionActiveCount,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs, recordRequestError,
  CONNECTION_METRICS_WINDOW_MS, refreshConnectionMetrics24h, getConnectionMetrics24hCached,
  saveRequestDetail, getRequestDetails, getRequestDetailById,
} from "@/lib/db/index.js";
