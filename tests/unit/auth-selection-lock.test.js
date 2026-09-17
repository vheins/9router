import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocked dependencies ─────────────────────────────────────────────
// State uses PLAIN OBJECTS for per-provider counters (not Maps) so that the
// Map.prototype spy below only ever observes the auth module's private
// selectionMutexes Map, never the harness bookkeeping.
const mocks = vi.hoisted(() => {
  const state = {
    connections: [],
    settings: {},
    inflight: 0,
    maxGlobal: 0,
    inflightByProvider: {},
    maxByProvider: {},
    gate: null,
  };

  const getProviderConnections = vi.fn(async (query = {}) => {
    const pid = query.provider ?? "__all__";
    state.inflight += 1;
    state.maxGlobal = Math.max(state.maxGlobal, state.inflight);
    state.inflightByProvider[pid] = (state.inflightByProvider[pid] || 0) + 1;
    state.maxByProvider[pid] = Math.max(state.maxByProvider[pid] || 0, state.inflightByProvider[pid]);
    try {
      if (state.gate) await state.gate(pid);
      return state.connections
        .filter((c) => c.provider === pid && c.isActive !== false)
        .map((c) => ({ ...c }));
    } finally {
      state.inflight -= 1;
      state.inflightByProvider[pid] -= 1;
    }
  });

  const updateProviderConnection = vi.fn(async (id, patch) => {
    const c = state.connections.find((x) => x.id === id);
    if (c) Object.assign(c, patch);
    return c ? { ...c } : null;
  });

  return {
    state,
    getProviderConnections,
    updateProviderConnection,
    getSettings: vi.fn(async () => state.settings),
    getProxyPools: vi.fn(async () => []),
    validateApiKey: vi.fn(async () => true),
    resolveConnectionProxyConfig: vi.fn(async () => ({})),
    pickProxyPoolId: vi.fn(() => null),
  };
});

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));
vi.mock("open-sse/services/accountFallback.js", () => ({
  formatRetryAfter: () => "",
  checkFallbackError: () => ({ shouldFallback: false, cooldownMs: 0, newBackoffLevel: 0 }),
  isModelLockActive: () => false,
  buildModelLockUpdate: () => ({}),
  getEarliestModelLockUntil: () => null,
}));
vi.mock("open-sse/config/errorConfig.js", () => ({
  MAX_RATE_LIMIT_COOLDOWN_MS: 30 * 60 * 1000,
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: () => new Map(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

// ── Observe the module-private selectionMutexes Map ─────────────────
// The Map is not exported, so we track live keys via Map.prototype.set/delete,
// filtered to the provider ids this suite uses. Vitest never uses these keys,
// and the mock state above deliberately avoids Map for the same keys.
const PROVIDERS = ["alpha", "beta", "solo", "rr", "boom"];
const liveMutexKeys = new Set();
const origSet = Map.prototype.set;
const origDelete = Map.prototype.delete;

vi.spyOn(Map.prototype, "set").mockImplementation(function (key, value) {
  if (PROVIDERS.includes(key)) liveMutexKeys.add(key);
  return origSet.call(this, key, value);
});
vi.spyOn(Map.prototype, "delete").mockImplementation(function (key) {
  if (PROVIDERS.includes(key)) liveMutexKeys.delete(key);
  return origDelete.call(this, key);
});

let getProviderCredentials;

beforeEach(async () => {
  vi.clearAllMocks();
  liveMutexKeys.clear();
  mocks.state.connections = [];
  mocks.state.settings = {};
  mocks.state.inflight = 0;
  mocks.state.maxGlobal = 0;
  mocks.state.inflightByProvider = {};
  mocks.state.maxByProvider = {};
  mocks.state.gate = null;
  vi.resetModules();
  ({ getProviderCredentials } = await import("@/sse/services/auth.js"));
});

// round-robin + stickyLimit=1 => consecutive calls rotate to a different account.
function settingsFor(providers) {
  const providerStrategies = {};
  for (const p of providers) providerStrategies[p] = { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 };
  return { providerStrategies };
}

function seed(providerId, conns) {
  for (const c of conns) mocks.state.connections.push({ provider: providerId, isActive: true, ...c });
}

describe("per-provider account-selection mutex", () => {
  // (a) Different providers must be able to select accounts concurrently.
  it("(a) lets two different providers enter the critical section concurrently", async () => {
    seed("alpha", [{ id: "a1", priority: 1, name: "a1" }]);
    seed("beta", [{ id: "b1", priority: 1, name: "b1" }]);
    mocks.state.settings = settingsFor(["alpha", "beta"]);

    let openGate;
    const gate = new Promise((resolve) => { openGate = resolve; });
    mocks.state.gate = () => gate;

    const p1 = getProviderCredentials("alpha");
    const p2 = getProviderCredentials("beta");

    // Both must be inside getProviderConnections simultaneously => overlap.
    await vi.waitFor(() => expect(mocks.state.inflight).toBe(2));
    expect(mocks.state.maxGlobal).toBeGreaterThanOrEqual(2);

    openGate();
    await Promise.all([p1, p2]);
  });

  // (b) Same provider must serialize: in-flight never exceeds 1.
  it("(b) serializes concurrent calls for the same provider", async () => {
    seed("solo", [{ id: "s1", priority: 1, name: "s1" }]);
    mocks.state.settings = settingsFor(["solo"]);
    mocks.state.gate = () => new Promise((r) => setTimeout(r, 5));

    await Promise.all([
      getProviderCredentials("solo"),
      getProviderCredentials("solo"),
      getProviderCredentials("solo"),
      getProviderCredentials("solo"),
    ]);

    expect(mocks.state.maxByProvider.solo).toBe(1);
  });

  // (c) Round-robin RMW must not lose updates under concurrent same-provider calls.
  //     stickyLimit=1, 2 connections, 2 concurrent calls => different accounts.
  it("(c) preserves round-robin without lost updates for concurrent same-provider calls", async () => {
    seed("rr", [
      { id: "c1", priority: 1, name: "c1" },
      { id: "c2", priority: 2, name: "c2" },
    ]);
    mocks.state.settings = settingsFor(["rr"]);
    mocks.state.gate = null;

    const [r1, r2] = await Promise.all([
      getProviderCredentials("rr"),
      getProviderCredentials("rr"),
    ]);

    const picked = [r1.connectionId, r2.connectionId];
    expect(new Set(picked).size).toBe(2);            // different connections
    expect(picked.sort()).toEqual(["c1", "c2"]);     // exactly c1 and c2, no lost update
  });

  // (d) After all calls settle the mutex Map must be empty (no unbounded growth),
  //     including on the error path.
  it("(d) releases the lock and cleans up the mutex map after all calls settle", async () => {
    seed("solo", [{ id: "s1", priority: 1, name: "s1" }]);
    mocks.state.settings = settingsFor(["solo"]);

    await Promise.all([getProviderCredentials("solo"), getProviderCredentials("solo")]);
    expect(liveMutexKeys.size).toBe(0);
  });

  it("(d) cleans up the mutex map even when the selection body throws", async () => {
    seed("boom", [{ id: "x1", priority: 1, name: "x1" }]);
    mocks.state.settings = settingsFor(["boom"]);
    mocks.state.gate = () => { throw new Error("boom"); };

    await expect(getProviderCredentials("boom")).rejects.toThrow("boom");
    expect(liveMutexKeys.size).toBe(0);
  });
});
