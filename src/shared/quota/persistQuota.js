// FORK-ONLY: persist a quota snapshot for a connection.
//
// Thin wrapper around buildQuotaSnapshot() + saveQuotaSnapshot() so every quota
// fetch (dashboard usage route, auto-toggle scheduler, auto-ping scheduler)
// writes a durable snapshot the routing engine can consult on a cold boot.
// Fail-open: never throws into the caller.
//
// Both dependencies are imported lazily so importing this module does NOT pull
// the provider-models / dashboard-utils graph into lightweight callers (e.g.
// the auto-ping scheduler, whose tests mock only a subset of that graph).

/**
 * Persist a quota snapshot derived from a raw usage payload.
 * @param {string} connectionId
 * @param {string} provider
 * @param {object} usage - raw usage payload from getUsageForProvider
 * @returns {Promise<object|null>} the saved snapshot, or null when not measurable
 */
export async function persistQuotaSnapshot(connectionId, provider, usage) {
  if (!connectionId) return null;
  try {
    const { buildQuotaSnapshot } = await import("./availability.js");
    const snapshot = buildQuotaSnapshot(provider, usage);
    if (!snapshot) return null;
    const { saveQuotaSnapshot } = await import("@/lib/db/repos/quotaTrackerRepo.js");
    return await saveQuotaSnapshot(connectionId, snapshot);
  } catch {
    return null; // fail-open: quota persistence must never break the request path
  }
}
