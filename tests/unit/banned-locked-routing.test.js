import { beforeEach, describe, expect, it, vi } from "vitest";

// FIX-014: getProviderCredentials must not mask a short 429/model lock behind an
// indefinite ban. accountFallback is intentionally NOT mocked here so the real
// isModelLockActive / getEarliestModelLockUntil logic is exercised.
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
    getQuotaSnapshots: vi.fn(async () => new Map()),
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
  getConnectionMetrics24hCached: vi.fn(() => ({})),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(() => null),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({ getAntigravityQuotaCache: () => new Map() }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

let getProviderCredentials;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.state.connections = [];
  mocks.state.settings = {};
  mocks.state.snapshots = new Map();
  vi.resetModules();
  ({ getProviderCredentials } = await import("@/sse/services/auth.js"));
});

function seed(conns) {
  for (const c of conns) mocks.state.connections.push({ provider: "prov", isActive: true, ...c });
}

const MANUAL_BAN = { banned: true, bannedAt: "2026-01-01T00:00:00.000Z", banReason: "Manually banned", banRetryAt: null };

describe("FIX-014: ban vs short lock reporting", () => {
  it("reports manual unban only when every remaining account is banned", async () => {
    seed([
      { id: "b1", priority: 1, ...MANUAL_BAN },
      { id: "b2", priority: 2, ...MANUAL_BAN },
    ]);

    const creds = await getProviderCredentials("prov", null, "auto");

    expect(creds).toMatchObject({
      allRateLimited: true,
      banned: true,
      retryAfter: null,
      retryAfterHuman: "manual unban required",
    });
  });

  it("does NOT report manual unban when a banned account coexists with a short model lock", async () => {
    const lockUntil = new Date(Date.now() + 15_000).toISOString();
    seed([
      { id: "b1", priority: 1, ...MANUAL_BAN },
      { id: "l1", priority: 2, modelLock_auto: lockUntil },
    ]);

    const creds = await getProviderCredentials("prov", null, "auto");

    expect(creds.allRateLimited).toBe(true);
    expect(creds.banned).toBeUndefined();
    expect(creds.retryAfter).toBe(lockUntil);
    expect(creds.retryAfterHuman).not.toBe("manual unban required");
    expect(creds.retryAfterHuman).toMatch(/reset after/);
  });

  it("uses the earliest recovery when a timed ban is later than a short lock", async () => {
    const lockUntil = new Date(Date.now() + 15_000).toISOString();
    const banRetryAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    seed([
      { id: "b1", priority: 1, banned: true, bannedAt: "2026-01-01T00:00:00.000Z", banReason: "suspended", banRetryAt },
      { id: "l1", priority: 2, modelLock_auto: lockUntil },
    ]);

    const creds = await getProviderCredentials("prov", null, "auto");

    expect(creds.banned).toBeUndefined();
    expect(creds.retryAfter).toBe(lockUntil);
  });

  it("still returns the authoritative banned result when all non-excluded accounts are banned", async () => {
    const banRetryAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    seed([
      { id: "b1", priority: 1, banned: true, bannedAt: "2026-01-01T00:00:00.000Z", banReason: "suspended", banRetryAt },
      { id: "b2", priority: 2, ...MANUAL_BAN },
    ]);

    // b1 already tried; the remaining b2 is the only non-excluded account.
    const creds = await getProviderCredentials("prov", new Set(["b1"]), "auto");

    expect(creds).toMatchObject({ banned: true, retryAfter: null, retryAfterHuman: "manual unban required" });
  });

  it("reports the timed ban expiry when every remaining account is banned with a known retry", async () => {
    const banRetryAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    seed([
      { id: "b1", priority: 1, banned: true, bannedAt: "2026-01-01T00:00:00.000Z", banReason: "suspended", banRetryAt },
    ]);

    const creds = await getProviderCredentials("prov", null, "auto");

    expect(creds).toMatchObject({ banned: true, retryAfter: banRetryAt });
  });
});
