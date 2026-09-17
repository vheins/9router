// Background quota auto-toggle scheduler: turns provider connections OFF when
// their quota is empty and back ON when quota is available again.
// In-process, opt-out (default ON), fail-open. Mirrors quotaAutoPing.js.
import "open-sse/index.js";

import { getSettings, getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";
import { classifyUsage, QUOTA_STATUS } from "@/shared/quota/availability.js";
import { QUOTA_AUTO_TOGGLE_CONFIG } from "@/shared/constants/config";

const C = QUOTA_AUTO_TOGGLE_CONFIG;

// Survive Next.js hot reload and keep one scheduler per server process.
const g = (global.__quotaAutoToggle ??= {
  interval: null,
  running: false,
  failureCache: {},
  lastScanAt: {},
});

function cacheKey(conn) {
  return `${conn.provider}:${conn.id}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Eligible = provider exposes a usage/quota API AND the auth type can call it.
// OAuth always qualifies; apikey only for providers flagged usageApikey.
function isEligible(conn) {
  if (!conn || !conn.provider) return false;
  if (!USAGE_SUPPORTED_PROVIDERS.includes(conn.provider)) return false;
  const authType = String(conn.authType || "").toLowerCase();
  if (authType === "oauth") return true;
  const isApikey = authType === "apikey" || authType === "api_key";
  return isApikey && USAGE_APIKEY_PROVIDERS.includes(conn.provider);
}

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

function shouldSkipAfterFailure(state, key, nowMs = Date.now()) {
  const failedAt = state.failureCache[key];
  return failedAt && nowMs - failedAt < C.failureCooldownMs;
}

async function evaluateConnection(conn, deps, state) {
  const key = cacheKey(conn);
  if (shouldSkipAfterFailure(state, key)) return;

  const proxyCfg = await deps.resolveConnectionProxyConfig(conn.providerSpecificData);
  const proxyOptions = buildProxyOptions(proxyCfg);

  let connection = conn;
  if (String(conn.authType || "").toLowerCase() === "oauth") {
    const r = await deps.refreshAndUpdateCredentials(connection, false, proxyOptions);
    connection = r.connection;
  }

  const usage = await deps.getUsageForProvider(connection, proxyOptions, { force: false });
  const status = classifyUsage(conn.provider, usage);
  if (status === QUOTA_STATUS.UNKNOWN) return;

  const currentActive = conn.isActive !== false;
  const desiredActive = status === QUOTA_STATUS.AVAILABLE;
  if (currentActive === desiredActive) return;

  await deps.updateProviderConnection(conn.id, { isActive: desiredActive });
  delete state.failureCache[key];
  console.log(
    `[QuotaAutoToggle] ${conn.provider}:${conn.id}: ${status} → isActive=${desiredActive}`,
  );
}

function groupByProvider(connections) {
  const map = new Map();
  for (const conn of connections) {
    if (!map.has(conn.provider)) map.set(conn.provider, []);
    map.get(conn.provider).push(conn);
  }
  return map;
}

export async function runQuotaAutoToggleTick(deps = createDefaultDeps(), state = g) {
  if (state.running) return;
  state.running = true;
  try {
    const settings = await deps.getSettings();
    if (settings?.quotaAutoToggleEnabled !== true) return;

    const connections = await deps.getProviderConnections({});
    const targets = connections.filter(isEligible);
    const byProvider = groupByProvider(targets);

    for (const [provider, conns] of byProvider) {
      const minInterval = C.providerMinIntervalMs?.[provider] || 0;
      const now = Date.now();
      if (minInterval && state.lastScanAt[provider] && now - state.lastScanAt[provider] < minInterval) {
        continue;
      }
      state.lastScanAt[provider] = now;

      for (const conn of conns) {
        try {
          await evaluateConnection(conn, deps, state);
        } catch (e) {
          state.failureCache[cacheKey(conn)] = Date.now();
          console.warn(`[QuotaAutoToggle] ${conn.provider}:${conn.id}: ${e.message}`);
        }
        if (C.perConnectionDelayMs) await sleep(C.perConnectionDelayMs);
      }
    }
  } catch (e) {
    console.warn("[QuotaAutoToggle] tick error:", e.message);
  } finally {
    state.running = false;
  }
}

export function startQuotaAutoToggle() {
  if (g.interval) return;
  console.log("[QuotaAutoToggle] scheduler started");
  runQuotaAutoToggleTick().catch(() => {});
  g.interval = setInterval(() => {
    runQuotaAutoToggleTick().catch(() => {});
  }, C.tickIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopQuotaAutoToggle() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
  console.log("[QuotaAutoToggle] scheduler stopped");
}

export function configureQuotaAutoToggle(settings) {
  if (settings?.quotaAutoToggleEnabled === true) startQuotaAutoToggle();
  else stopQuotaAutoToggle();
}

function createDefaultDeps() {
  return {
    getSettings,
    getProviderConnections,
    updateProviderConnection,
    resolveConnectionProxyConfig,
    refreshAndUpdateCredentials,
    getUsageForProvider,
  };
}
