import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(),
}));

vi.mock("@/shared/constants/providers", () => ({
  USAGE_SUPPORTED_PROVIDERS: ["claude", "codex", "gemini-cli", "github", "deepseek", "glm"],
  USAGE_APIKEY_PROVIDERS: ["deepseek", "glm"],
}));

vi.mock("@/shared/constants/config", () => ({
  QUOTA_AUTO_TOGGLE_CONFIG: {
    tickIntervalMs: 300000,
    failureCooldownMs: 900000,
    perConnectionDelayMs: 0,
    providerMinIntervalMs: { claude: 600000 },
  },
}));

const CLAUDE = (used, total) => ({ quotas: { "session (5h)": { used, total } } });

describe("quota availability classification", () => {
  let classifyUsage;
  let classifyQuotaRows;
  let isQuotaRowDepleted;
  let QUOTA_STATUS;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({
      classifyUsage,
      classifyQuotaRows,
      isQuotaRowDepleted,
      QUOTA_STATUS,
    } = await import("../../src/shared/quota/availability.js"));
  });

  it("classifies a depleted Claude window as empty", () => {
    expect(classifyUsage("claude", CLAUDE(100, 100))).toBe(QUOTA_STATUS.EMPTY);
  });

  it("classifies a healthy Claude window as available", () => {
    expect(classifyUsage("claude", CLAUDE(10, 100))).toBe(QUOTA_STATUS.AVAILABLE);
  });

  it("treats a soft-error message as unknown", () => {
    expect(
      classifyUsage("codex", { message: "Codex connected. Usage API temporarily unavailable (500)." }),
    ).toBe(QUOTA_STATUS.UNKNOWN);
  });

  it("treats empty object and null as unknown", () => {
    expect(classifyUsage("claude", {})).toBe(QUOTA_STATUS.UNKNOWN);
    expect(classifyUsage("claude", null)).toBe(QUOTA_STATUS.UNKNOWN);
  });

  it("classifies Codex as empty when any window is depleted", () => {
    expect(
      classifyUsage("codex", {
        quotas: { session: { used: 100, total: 100, remaining: 0 }, weekly: { used: 0, total: 100 } },
      }),
    ).toBe(QUOTA_STATUS.EMPTY);
  });

  it("classifies Codex as available when no window is depleted", () => {
    expect(
      classifyUsage("codex", {
        quotas: { session: { used: 1, total: 100 }, weekly: { used: 0, total: 100 } },
      }),
    ).toBe(QUOTA_STATUS.AVAILABLE);
  });

  it("returns unknown when every row has total 0", () => {
    expect(classifyUsage("claude", { quotas: { "session (5h)": { used: 0, total: 0 } } })).toBe(
      QUOTA_STATUS.UNKNOWN,
    );
    expect(classifyQuotaRows([])).toBe(QUOTA_STATUS.UNKNOWN);
    expect(classifyQuotaRows(null)).toBe(QUOTA_STATUS.UNKNOWN);
  });

  it("never marks an unlimited row depleted", () => {
    expect(isQuotaRowDepleted({ used: 100, total: 100, unlimited: true })).toBe(false);
    expect(isQuotaRowDepleted({ used: 95, total: 100 })).toBe(true);
    expect(isQuotaRowDepleted({ used: 94, total: 100 })).toBe(false);
  });
});

describe("buildQuotaSnapshot", () => {
  let buildQuotaSnapshot;

  beforeEach(async () => {
    vi.resetModules();
    ({ buildQuotaSnapshot } = await import("../../src/shared/quota/availability.js"));
  });

  it("uses the lowest remaining % as the binding constraint", () => {
    const snap = buildQuotaSnapshot("codex", {
      quotas: {
        session: { used: 10, total: 100 },       // 90% left
        weekly: { used: 80, total: 100 },        // 20% left
      },
    });
    expect(snap.status).toBe("available");
    expect(snap.remainingPct).toBe(20);
  });

  it("captures the earliest future reset among depleted windows", () => {
    const soon = new Date(Date.now() + 60000).toISOString();
    const later = new Date(Date.now() + 600000).toISOString();
    const snap = buildQuotaSnapshot("codex", {
      quotas: {
        session: { used: 100, total: 100, resetAt: later },
        weekly: { used: 100, total: 100, resetAt: soon },
      },
    });
    expect(snap.status).toBe("empty");
    expect(snap.remainingPct).toBe(0);
    expect(snap.resetAt).toBe(soon);
  });

  it("returns null for a soft-error envelope (message, no quotas)", () => {
    expect(buildQuotaSnapshot("codex", { message: "Usage API temporarily unavailable (500)." })).toBeNull();
  });

  it("returns null when there are no measurable rows", () => {
    expect(buildQuotaSnapshot("claude", { quotas: { "session (5h)": { used: 0, total: 0 } } })).toBeNull();
    expect(buildQuotaSnapshot("claude", null)).toBeNull();
  });

  it("ignores unlimited windows when computing remainingPct", () => {
    // `zed` forwards the unlimited flag (claude/codex parsers do not).
    const snap = buildQuotaSnapshot("zed", {
      quotas: {
        predictions: { used: 100, total: 100, unlimited: true },
        hosted: { used: 50, total: 100 },
      },
    });
    expect(snap.remainingPct).toBe(50);
  });
});

describe("quota auto-toggle", () => {
  let runQuotaAutoToggleTick;
  let configureQuotaAutoToggle;
  let deps;
  let state;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete global.__quotaAutoToggle;

    ({ runQuotaAutoToggleTick, configureQuotaAutoToggle } = await import(
      "../../src/shared/services/quotaAutoToggle.js"
    ));

    deps = {
      getSettings: vi.fn(),
      getProviderConnections: vi.fn(),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection, refreshed: false })),
      getUsageForProvider: vi.fn(),
    };
    state = { running: false, failureCache: {}, lastScanAt: {} };
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  it("does nothing when the setting is disabled", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: false });

    await runQuotaAutoToggleTick(deps, state);

    expect(deps.getProviderConnections).not.toHaveBeenCalled();
    expect(deps.getUsageForProvider).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("turns an empty active connection off", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: true });
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "oauth", isActive: true },
    ]);
    deps.getUsageForProvider.mockResolvedValue(CLAUDE(100, 100));

    await runQuotaAutoToggleTick(deps, state);

    expect(deps.updateProviderConnection).toHaveBeenCalledWith("c1", { isActive: false });
  });

  it("turns an available inactive connection back on", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: true });
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "oauth", isActive: false },
    ]);
    deps.getUsageForProvider.mockResolvedValue(CLAUDE(10, 100));

    await runQuotaAutoToggleTick(deps, state);

    expect(deps.updateProviderConnection).toHaveBeenCalledWith("c1", { isActive: true });
  });

  it("skips a banned connection whose persisted flag is truthy (1), not literal true", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: true });
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "oauth", isActive: false, banned: 1 },
    ]);
    deps.getUsageForProvider.mockResolvedValue(CLAUDE(10, 100));

    await runQuotaAutoToggleTick(deps, state);

    expect(deps.getUsageForProvider).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("leaves an unknown connection untouched", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: true });
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "codex", authType: "oauth", isActive: true },
    ]);
    deps.getUsageForProvider.mockResolvedValue({ message: "Usage API temporarily unavailable (500)." });

    await runQuotaAutoToggleTick(deps, state);

    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("skips providers without a usage API", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: true });
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "openai-compatible-foo", authType: "apikey", isActive: true },
    ]);

    await runQuotaAutoToggleTick(deps, state);

    expect(deps.getUsageForProvider).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("skips apikey connections for providers without usageApikey", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: true });
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "apikey", isActive: true },
    ]);

    await runQuotaAutoToggleTick(deps, state);

    expect(deps.getUsageForProvider).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("evaluates apikey connections for usageApikey providers", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: true });
    deps.getProviderConnections.mockResolvedValue([
      { id: "k1", provider: "deepseek", authType: "apikey", isActive: true },
    ]);
    deps.getUsageForProvider.mockResolvedValue({ quotas: { user: { used: 100, total: 100 } } });

    await runQuotaAutoToggleTick(deps, state);

    expect(deps.getUsageForProvider).toHaveBeenCalled();
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("k1", { isActive: false });
  });

  it("refreshes credentials for oauth connections before reading usage", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: true });
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "oauth", isActive: true },
    ]);
    deps.getUsageForProvider.mockResolvedValue(CLAUDE(10, 100));

    await runQuotaAutoToggleTick(deps, state);

    expect(deps.refreshAndUpdateCredentials).toHaveBeenCalledTimes(1);
  });

  it("suppresses a second Claude scan inside providerMinIntervalMs", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: true });
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "oauth", isActive: true },
    ]);
    deps.getUsageForProvider.mockResolvedValue(CLAUDE(10, 100));

    await runQuotaAutoToggleTick(deps, state);
    await runQuotaAutoToggleTick(deps, state);

    expect(deps.getUsageForProvider).toHaveBeenCalledTimes(1);
  });

  it("resumes the Claude scan after the interval elapses", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: true });
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "oauth", isActive: true },
    ]);
    deps.getUsageForProvider.mockResolvedValue(CLAUDE(10, 100));

    await runQuotaAutoToggleTick(deps, state);
    state.lastScanAt.claude = Date.now() - 600000 - 1000;
    await runQuotaAutoToggleTick(deps, state);

    expect(deps.getUsageForProvider).toHaveBeenCalledTimes(2);
  });

  it("caches a failure and skips the connection until cooldown expires", async () => {
    deps.getSettings.mockResolvedValue({ quotaAutoToggleEnabled: true });
    deps.getProviderConnections.mockResolvedValue([
      { id: "c1", provider: "claude", authType: "oauth", isActive: true },
    ]);
    deps.getUsageForProvider.mockRejectedValue(new Error("boom"));

    await runQuotaAutoToggleTick(deps, state);
    state.lastScanAt.claude = 0; // isolate the failure cache from providerMinIntervalMs
    await runQuotaAutoToggleTick(deps, state);

    expect(deps.getUsageForProvider).toHaveBeenCalledTimes(1);
    expect(state.failureCache["claude:c1"]).toBeTypeOf("number");
  });

  it("starts the scheduler when the setting is enabled", () => {
    vi.useFakeTimers();

    configureQuotaAutoToggle({ quotaAutoToggleEnabled: true });
    expect(vi.getTimerCount()).toBe(1);

    configureQuotaAutoToggle({ quotaAutoToggleEnabled: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
