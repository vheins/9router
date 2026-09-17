// Pure quota-availability classification — single source of truth for the
// "empty" definition shared by the Quota Tracker UI and the background
// auto-toggle scheduler. Server-safe: no DOM, no "use client".
import {
  parseQuotaData,
  getRemainingPercentage,
  DEPLETED_QUOTA_THRESHOLD as UI_DEPLETED_QUOTA_THRESHOLD,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

// A connection is "empty" when ANY measurable quota window's remaining
// percentage is at or below this threshold. Matches the dashboard progress bar.
export const DEPLETED_QUOTA_THRESHOLD = UI_DEPLETED_QUOTA_THRESHOLD;

export const QUOTA_STATUS = {
  EMPTY: "empty",
  AVAILABLE: "available",
  UNKNOWN: "unknown",
};

// A single normalized quota row is depleted when it has a real total and its
// remaining percentage (computed exactly like the dashboard bar) has fallen
// to/under the threshold. `unlimited` rows are never depleted.
export function isQuotaRowDepleted(quota) {
  if (!quota || quota.unlimited === true) return false;
  const total = Number(quota.total);
  if (!Number.isFinite(total) || total <= 0) return false;
  return getRemainingPercentage(quota) <= DEPLETED_QUOTA_THRESHOLD;
}

// Classify a set of normalized quota rows.
export function classifyQuotaRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return QUOTA_STATUS.UNKNOWN;
  const measurable = rows.filter((q) => q && Number(q.total) > 0);
  if (measurable.length === 0) return QUOTA_STATUS.UNKNOWN;
  return measurable.some(isQuotaRowDepleted)
    ? QUOTA_STATUS.EMPTY
    : QUOTA_STATUS.AVAILABLE;
}

// Classify a raw usage payload for a provider.
export function classifyUsage(provider, usage) {
  if (!usage || typeof usage !== "object") return QUOTA_STATUS.UNKNOWN;
  // Soft errors / "not implemented" envelopes carry a message but no quotas.
  if (usage.message && !usage.quotas) return QUOTA_STATUS.UNKNOWN;
  let rows;
  try {
    rows = parseQuotaData(provider, usage);
  } catch {
    return QUOTA_STATUS.UNKNOWN;
  }
  return classifyQuotaRows(rows);
}
