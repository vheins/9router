import { beforeEach, describe, expect, it, vi } from "vitest";

// Provider-connection selection via the shared routing engine (auth.js).
const mocks = vi.hoisted(() => {
  const state = { connections: [], settings: {}, snapshots: new Map() };
  return {
    state,
    getProviderConnections: vi.fn(async (query = {}) =>
      state.connections
        .filter((c) => c.provider === query.provider && c.isActive !== false)
        .map((c) => ({ ...c }))
    ),
    updateProviderConnection: vi.fn(async (id, patch) => {
      const c = state.connections.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
      return c ? { ...c } : null;
    }),
    getQuotaSnapshots: vi.fn(async (ids = []) => {
      const out = new Map();
      for (const id of ids) if (state.snapshots.has(id)) out.set(id, state.snapshots.get(id));
      return out;
    }),
  };
});

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: vi.fn(async () => mocks.state.settings),
  getProxyPools: vi.fn(async () => []),
  validateApiKey: vi.fn(async () => true),
  getQuotaSnapshots: mocks.getQuotaSnapshots,
}));
vi.mock("@/lib/usageDb.js", () => ({
  getConnectionActiveCount: vi.fn(() => 0),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(() => null),
}));
vi.mock("open-sse/services/accountFallback.js", () => ({
  formatRetryAfter: () => "",
  checkFallbackError: () => ({ shouldFallback: false, cooldownMs: 0, newBackoffLevel: 0 }),
  isModelLockActive: () => false,
  buildModelLockUpdate: () => ({}),
  getEarliestModelLockUntil: () => null,
}));
vi.mock("open-sse/config/errorConfig.js", () => ({ MAX_RATE_LIMIT_COOLDOWN_MS: 30 * 60 * 1000 }));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({ getAntigravityQuotaCache: () => new Map() }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

let getProviderCredentials;
let routingStateStore;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.state.connections = [];
  mocks.state.settings = {};
  mocks.state.snapshots = new Map();
  vi.resetModules();
  ({ getProviderCredentials } = await import("@/sse/services/auth.js"));
  ({ routingStateStore } = await import("open-sse/services/routingStateStore.js"));
  routingStateStore._resetAll();
});

function seed(conns) {
  for (const c of conns) mocks.state.connections.push({ provider: "prov", isActive: true, ...c });
}

describe("provider-connection routing strategies (shared engine)", () => {
  it("defaults to fill-first (first by priority) when no strategy set", async () => {
    seed([
      { id: "c1", priority: 1, name: "one" },
      { id: "c2", priority: 2, name: "two" },
    ]);
    const creds = await getProviderCredentials("prov");
    expect(creds.connectionId).toBe("c1");
  });

  it("least-used picks the connection with the fewest requests", async () => {
    seed([
      { id: "c1", priority: 1, usageCount: 10 },
      { id: "c2", priority: 2, usageCount: 2 },
    ]);
    mocks.state.settings = { providerStrategies: { prov: { fallbackStrategy: "least-used" } } };
    const creds = await getProviderCredentials("prov");
    expect(creds.connectionId).toBe("c2");
  });

  it("priority strategy orders by priority number", async () => {
    seed([
      { id: "c1", priority: 5 },
      { id: "c2", priority: 1 },
    ]);
    mocks.state.settings = { providerStrategies: { prov: { fallbackStrategy: "priority" } } };
    const creds = await getProviderCredentials("prov");
    expect(creds.connectionId).toBe("c2");
  });

  it("lkgp sticks to the most recently successful connection", async () => {
    const now = Date.now();
    seed([
      { id: "c1", priority: 1, lastSuccessAt: new Date(now - 60000).toISOString() },
      { id: "c2", priority: 2, lastSuccessAt: new Date(now - 1000).toISOString() },
    ]);
    mocks.state.settings = { providerStrategies: { prov: { fallbackStrategy: "lkgp" } } };
    const creds = await getProviderCredentials("prov");
    expect(creds.connectionId).toBe("c2");
  });

  it("lkgp uses store-backed lastSuccessAt (live stats), not raw connection fields", async () => {
    const now = Date.now();
    // Raw DB fields say c1 succeeded most recently...
    seed([
      { id: "c1", priority: 1, lastSuccessAt: new Date(now - 1000).toISOString() },
      { id: "c2", priority: 2, lastSuccessAt: new Date(now - 60000).toISOString() },
    ]);
    // ...but the live store recorded a fresher success for c2.
    routingStateStore.recordOutcome("c2", { ok: true, latencyMs: 10 });
    routingStateStore.recordOutcome("c1", { ok: true, latencyMs: 10 });
    // Make c2's store success strictly newer than c1's.
    await new Promise((r) => setTimeout(r, 5));
    routingStateStore.recordOutcome("c2", { ok: true, latencyMs: 10 });

    mocks.state.settings = { providerStrategies: { prov: { fallbackStrategy: "lkgp" } } };
    const creds = await getProviderCredentials("prov");
    expect(creds.connectionId).toBe("c2");
  });

  it("still honors a pinned preferredConnectionId over any strategy", async () => {
    seed([
      { id: "c1", priority: 1, usageCount: 0 },
      { id: "c2", priority: 2, usageCount: 99 },
    ]);
    mocks.state.settings = { providerStrategies: { prov: { fallbackStrategy: "least-used" } } };
    const creds = await getProviderCredentials("prov", null, null, { preferredConnectionId: "c2" });
    expect(creds.connectionId).toBe("c2");
  });

  it("round-robin still persists lastUsedAt/consecutiveUseCount to the DB", async () => {
    seed([
      { id: "c1", priority: 1 },
      { id: "c2", priority: 2 },
    ]);
    mocks.state.settings = { providerStrategies: { prov: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 } } };
    const first = await getProviderCredentials("prov");
    const second = await getProviderCredentials("prov");
    expect(first.connectionId).not.toBe(second.connectionId);
    expect(mocks.updateProviderConnection).toHaveBeenCalled();
  });

  it("quota-aware fallback demotes an account whose persisted snapshot is depleted", async () => {
    seed([
      { id: "c1", priority: 1, name: "depleted" },
      { id: "c2", priority: 2, name: "healthy" },
    ]);
    // c1 (higher priority) is depleted per the persisted Quota Tracker snapshot.
    mocks.state.snapshots.set("c1", {
      provider: "prov", status: "empty", remainingPct: 0,
      resetAt: new Date(Date.now() + 600000).toISOString(),
    });
    mocks.state.settings = { quotaAwareRouting: true };
    const creds = await getProviderCredentials("prov");
    expect(creds.connectionId).toBe("c2");
  });

  it("quota-aware off keeps priority order even when a snapshot is depleted", async () => {
    seed([
      { id: "c1", priority: 1 },
      { id: "c2", priority: 2 },
    ]);
    mocks.state.snapshots.set("c1", {
      provider: "prov", status: "empty", remainingPct: 0,
      resetAt: new Date(Date.now() + 600000).toISOString(),
    });
    mocks.state.settings = { quotaAwareRouting: false };
    const creds = await getProviderCredentials("prov");
    expect(creds.connectionId).toBe("c1");
  });

  it("per-provider quotaAware:false overrides the global default", async () => {
    seed([
      { id: "c1", priority: 1 },
      { id: "c2", priority: 2 },
    ]);
    mocks.state.snapshots.set("c1", {
      provider: "prov", status: "empty", remainingPct: 0,
      resetAt: new Date(Date.now() + 600000).toISOString(),
    });
    mocks.state.settings = { quotaAwareRouting: true, providerStrategies: { prov: { quotaAware: false } } };
    const creds = await getProviderCredentials("prov");
    expect(creds.connectionId).toBe("c1");
  });

  it("a snapshot with a past resetAt is treated as refilled (no demotion)", async () => {
    seed([
      { id: "c1", priority: 1 },
      { id: "c2", priority: 2 },
    ]);
    mocks.state.snapshots.set("c1", {
      provider: "prov", status: "empty", remainingPct: 0,
      resetAt: new Date(Date.now() - 60000).toISOString(),
    });
    mocks.state.settings = { quotaAwareRouting: true };
    const creds = await getProviderCredentials("prov");
    expect(creds.connectionId).toBe("c1");
  });
});
