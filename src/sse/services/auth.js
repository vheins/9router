import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools, getQuotaSnapshots } from "@/lib/localDb";
import { getConnectionActiveCount } from "@/lib/usageDb.js";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { orderTargets, quotaAwareOrder, isSelectionStrategy } from "open-sse/services/routingStrategies.js";
import { routingStateStore } from "open-sse/services/routingStateStore.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";

// Per-provider mutexes to prevent race conditions during account selection.
// The critical section below only read-modify-writes per-provider, per-connection
// state (consecutiveUseCount / lastUsedAt) and per-provider proxy-pool rotation
// state, so serializing by resolved provider id preserves correctness while
// removing the cross-provider contention a single global mutex imposed.
const selectionMutexes = new Map(); // providerId -> Promise

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Parse the suspend-until time out of a 403 error message.
 *
 * Providers like Kiro/AWS return "temporarily suspended ... until <time>" (or a
 * bare "until <ISO time>"). When a concrete expiry is present the account must
 * stay off until that moment — retrying every 2 minutes just burns the fallback
 * chain. Returns epoch ms, or null when no usable future time is present (the
 * caller then falls back to the generic rule / permanent auto-off).
 *
 * Recognized shapes:
 * - "suspended until 2026-09-20T10:00:00Z"
 * - "suspended until 2026-09-20 10:00:00 UTC"
 * - "suspended until 2026/09/20 10:00:00"
 * - "until 2026-09-20T10:00:00Z"
 * - "suspended until 1789000000" (unix seconds/ms)
 */
export function parseSuspendUntil(errorText) {
  if (!errorText || typeof errorText !== "string") return null;
  const text = errorText.toLowerCase();
  const now = Date.now();
  // Allow a small past-skew window so a clock-skewed "just now" still parses.
  const minMs = now - 60 * 1000;
  const maxMs = now + 365 * 24 * 60 * 60 * 1000;

  // Capture the datetime plus an optional timezone marker. Provider suspension
  // messages are emitted in UTC, so a naive datetime is interpreted as UTC.
  const patterns = [
    /(?:until|after|at)\s+(\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(z|utc|gmt)?/i,
    /(?:until|after|at)\s+(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s*(z|utc|gmt)?/i,
    /(?:until|after|at)\s+(\d{10,13})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) continue;
    const raw = match[1];

    // Unix timestamp (seconds or milliseconds).
    if (/^\d{10,13}$/.test(raw)) {
      const n = Number(raw);
      const ms = raw.length === 10 ? n * 1000 : n;
      if (ms > minMs && ms < maxMs) return ms;
      continue;
    }

    // ISO / slash datetime → normalize to "YYYY-MM-DDTHH:mm:ssZ" (UTC).
    // The source text is lowercased, so restore the uppercase "T" separator.
    const iso = raw.replace(/\//g, "-").replace(/\s+/, "T").replace(/t/, "T").replace(/z$/i, "");
    const parsed = new Date(`${iso}Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > minMs && parsed.getTime() < maxMs) {
      return parsed.getTime();
    }
  }
  return null;
}

/**
 * Detect whether a 403 means the account is suspended (not a request-scoped or
 * transient permission error). Used to decide between a bounded suspend window
 * and an indefinite auto-off.
 */
export function isSuspension403(status, errorText) {
  if (Number(status) !== 403) return false;
  const t = String(errorText || "").toLowerCase();
  return t.includes("suspend") || t.includes("locked") || t.includes("unusual user activity") || t.includes("security precaution");
}

// Build routing-engine targets from available connections. Missing fields stay
// undefined so the engine degrades gracefully (keeps the caller's order).
// `quotaSnapshots` is an optional Map<connectionId, persistedSnapshot> from the
// FORK-ONLY quotaTracker table — its values fill in quotaRemainingPct/resetAtMs
// for any connection the in-memory Antigravity cache doesn't cover.
function connectionsToTargets(connections, { isAntigravity, model, antigravityQuotaCache, quotaSnapshots }) {
  return connections.map((c) => {
    let quotaRemainingPct;
    let resetAtMs;
    let quotaUnlimited = false;
    if (isAntigravity && model && antigravityQuotaCache) {
      const quota = antigravityQuotaCache.get(c.id)?.[model];
      if (quota) {
        quotaRemainingPct = quota.remainingPercentage;
        resetAtMs = quota.resetAt ? new Date(quota.resetAt).getTime() : undefined;
      }
    }
    // Persisted snapshot (fallback source of truth when the in-memory cache is cold).
    const snap = quotaSnapshots?.get(c.id);
    if (snap) {
      if (quotaRemainingPct === undefined && Number.isFinite(snap.remainingPct)) {
        quotaRemainingPct = snap.remainingPct;
      }
      if (resetAtMs === undefined && snap.resetAt) {
        const t = new Date(snap.resetAt).getTime();
        if (Number.isFinite(t)) resetAtMs = t;
      }
      if (snap.status === "available" && snap.remainingPct == null) quotaUnlimited = true;
    }
    // Live outcome stats (usageCount / latency / success) feed `least-used` and
    // `auto`. Prefer the live store, but fall back to the connection's own
    // persisted fields so ordering is unchanged when stats are absent.
    const st = routingStateStore.getStats(c.id);
    return {
      key: c.id,
      priority: c.priority,
      weight: c.weight,
      usageCount: st?.usageCount ?? c.usageCount,
      consecutiveUseCount: c.consecutiveUseCount,
      activeRequests: getConnectionActiveCount(c.id),
      consecutiveErrors: c.backoffLevel,
      testStatus: c.testStatus,
      lastUsedAt: c.lastUsedAt,
      lastSuccessAt: st?.lastSuccessAt ?? c.lastSuccessAt,
      latencyMs: st?.latencyEwmaMs,
      successRate: st && st.usageCount > 0 ? st.successCount / st.usageCount : undefined,
      quotaRemainingPct,
      resetAtMs,
      quotaUnlimited,
    };
  });
}

// Most-recently-successful target — powers the `lkgp` strategy at provider level.
// Operates on ENRICHED routing targets (not raw connections) so the store-backed
// `lastSuccessAt` is visible; raw connections only carry the DB-persisted value.
function pickLastGoodKey(targets) {
  let best = null;
  let bestTs = -Infinity;
  for (const t of targets) {
    const ts = t.lastSuccessAt ? new Date(t.lastSuccessAt).getTime() : null;
    if (Number.isFinite(ts) && ts > bestTs) {
      bestTs = ts;
      best = t.key;
    }
  }
  return best;
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;

  // Resolve alias to provider ID (e.g., "kc" -> "kilocode") BEFORE acquiring the
  // lock so the mutex can be keyed per provider. resolveProviderId is pure.
  const providerId = resolveProviderId(provider);

  // Acquire the per-provider mutex (race-free: get/set are synchronous with no
  // await between them). The no-auth path below intentionally stays inside the
  // lock: pickProxyPoolId keeps module-level per-provider round-robin state
  // (connectionProxy.rotateState), so it must not run concurrently for one provider.
  const currentMutex = selectionMutexes.get(providerId) ?? Promise.resolve();
  let resolveMutex;
  const myLock = new Promise(resolve => { resolveMutex = resolve; });
  selectionMutexes.set(providerId, myLock);

  try {
    await currentMutex;

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const quota = antigravityQuotaCache.get(c.id)?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[model]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    // Quota-aware routing: demote exhausted accounts so fallback tries a funded
    // account first. Enabled globally (settings.quotaAwareRouting) and overridable
    // per provider (providerStrategies[pid].quotaAware). Persisted snapshots from
    // the quotaTracker table are the source of truth; Antigravity's in-memory cache
    // takes precedence when warm.
    const quotaAware = providerOverride.quotaAware ?? settings.quotaAwareRouting ?? false;
    let quotaSnapshots = null;
    if (quotaAware) {
      try {
        quotaSnapshots = await getQuotaSnapshots(availableConnections.map((c) => c.id));
      } catch (e) {
        log.debug("AUTH", `${provider} | quota snapshot read failed (continuing): ${e?.message ?? e}`);
      }
    }

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }

    if (connection) {
      // skip strategy (pinned)
    } else if (strategy === "round-robin") {
      // Legacy sticky round-robin: persisted to DB via lastUsedAt/consecutiveUseCount.
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Quota-aware: build the candidate order from the engine (which demotes
      // depleted accounts) so an exhausted account is only used when no funded
      // account remains in the rotation.
      let candidates = availableConnections;
      if (quotaAware) {
        const targets = connectionsToTargets(availableConnections, { isAntigravity, model, antigravityQuotaCache, quotaSnapshots });
        const ordered = quotaAwareOrder(targets);
        const byId = new Map(availableConnections.map((c) => [c.id, c]));
        candidates = ordered.map((t) => byId.get(t.key)).filter(Boolean);
      }

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...candidates].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...candidates].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else if (isSelectionStrategy(strategy)) {
      // Shared routing engine (fallback/fill-first/priority/weighted/p2c/least-used/
      // random/cost-optimized/headroom/reset-*/lkgp/auto). availableConnections is
      // already priority-sorted, so the engine's default path preserves fill-first.
      // Quota-aware sinks exhausted accounts for the order-preserving strategies.
      const targets = connectionsToTargets(availableConnections, { isAntigravity, model, antigravityQuotaCache, quotaSnapshots });
      const ordered = orderTargets(targets, strategy, {
        rotationIndex: 0,
        lastGoodKey: pickLastGoodKey(targets),
        lastHeadKey: routingStateStore.getLastHead(providerId),
        quotaAware,
      });
      const chosenId = ordered[0]?.key;
      connection = availableConnections.find((c) => c.id === chosenId) || availableConnections[0];
      routingStateStore.setLastHead(providerId, connection.id);
      if (strategy !== "fallback" && strategy !== "fill-first") {
        log.info("AUTH", `${provider} | ${strategy}${quotaAware ? " (quota-aware)" : ""} → ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    } else {
      // Unknown strategy → fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    resolveMutex();
    // Clean up only if no newer waiter has chained onto our lock; otherwise the
    // entry now points to their promise and must be left intact. Prevents
    // unbounded Map growth without dropping a newer waiter's chain.
    if (selectionMutexes.get(providerId) === myLock) selectionMutexes.delete(providerId);
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  let suspendUntilMs = null;
  let isSuspended = false;
  let permanentOff = false;

  // 403 suspension handling — an explicit "until <time>" pins the account off
  // until that moment; a suspension with no usable time is treated as an
  // indefinite auto-off (long cooldown) instead of a 2-minute retry loop that
  // would keep hammering a clearly-dead credential.
  if (isSuspension403(status, errorText)) {
    suspendUntilMs = parseSuspendUntil(errorText);
    if (suspendUntilMs && suspendUntilMs > Date.now()) {
      isSuspended = true;
      const cooldownFromSuspend = suspendUntilMs - Date.now();
      const maxCooldown = 30 * 24 * 60 * 60 * 1000; // 30 days
      const minCooldown = 60 * 60 * 1000;           // 1 hour
      cooldownMs = Math.max(minCooldown, Math.min(cooldownFromSuspend, maxCooldown));
      shouldFallback = true;
      newBackoffLevel = 0;
      log.warn("AUTH", `Account suspended until ${new Date(suspendUntilMs).toISOString()}, auto-off for ${Math.round(cooldownMs / 1000 / 60)}m`);
    } else {
      // Suspended but no parseable expiry → auto-off for a long, bounded window
      // (24h). Long enough to stop the retry storm; still self-heals daily so a
      // transient suspension cannot silently kill the credential forever.
      isSuspended = true;
      permanentOff = true;
      cooldownMs = 24 * 60 * 60 * 1000;
      shouldFallback = true;
      newBackoffLevel = 0;
      log.warn("AUTH", `Account suspended with no expiry, auto-off for 24h [${status}]`);
    }
  }

  if (!isSuspended) {
    // GitHub premium-request exhaustion is account-wide until the next UTC month.
    const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

    if (githubResetAtMs) {
      shouldFallback = true;
      cooldownMs = githubResetAtMs - Date.now();
      newBackoffLevel = 0;
    } else if (resetsAtMs && resetsAtMs > Date.now()) {
      shouldFallback = true;
      // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
      cooldownMs = resolveProviderId(provider) === "antigravity"
        ? resetsAtMs - Date.now()
        : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
      newBackoffLevel = 0;
    } else {
      ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
    }
    if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };
  }

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  // Suspensions lock the WHOLE account (model=null → modelLock___all) because a
  // suspended credential is unusable for every model, not just the one that hit
  // it. Other errors keep the per-model lock.
  const lockModel = isSuspended ? null : (githubMonthlyResetMs(status, errorText, provider) ? null : model);
  const lockUpdate = buildModelLockUpdate(lockModel, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel,
    // Persist suspend info for routing accuracy (null clears it on normal errors).
    suspendedUntil: isSuspended ? new Date(Date.now() + cooldownMs).toISOString() : null,
    suspendIndefinite: permanentOff ? true : null
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs, suspendedUntil: isSuspended ? Date.now() + cooldownMs : null };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
