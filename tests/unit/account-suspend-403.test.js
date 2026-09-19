import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable, parseSuspendUntil, isSuspension403 } = await import(
  "../../src/sse/services/auth.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([
    { id: "kiro-a", provider: "kiro", name: "kiro-a", backoffLevel: 2 },
  ]);
});

describe("parseSuspendUntil", () => {
  it("parses an ISO suspend time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      const ms = parseSuspendUntil(
        "Your User ID is temporarily suspended. Restore access after 2026-09-20T10:00:00Z",
      );
      expect(ms).toBe(new Date("2026-09-20T10:00:00Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses a space-separated UTC suspend time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      const ms = parseSuspendUntil("suspended until 2026-09-20 10:00:00 UTC");
      expect(ms).toBe(new Date("2026-09-20T10:00:00Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses a unix-seconds suspend time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      const future = Math.floor(new Date("2026-09-20T10:00:00Z").getTime() / 1000);
      const ms = parseSuspendUntil(`suspended until ${future}`);
      expect(ms).toBe(future * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when no usable future time is present", () => {
    const ms = parseSuspendUntil("Your User ID is temporarily suspended.");
    expect(ms).toBeNull();
  });
});

describe("isSuspension403", () => {
  it("detects suspension wording on 403", () => {
    expect(isSuspension403(403, "Your User ID is temporarily suspended.")).toBe(true);
    expect(isSuspension403(403, "account locked for unusual user activity")).toBe(true);
  });

  it("ignores non-403 and unrelated 403 messages", () => {
    expect(isSuspension403(401, "temporarily suspended")).toBe(false);
    expect(isSuspension403(403, "permission denied")).toBe(false);
  });
});

describe("403 suspension auto-off", () => {
  it("locks the whole account until the parsed suspend time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      const result = await markAccountUnavailable(
        "kiro-a",
        403,
        "Your User ID is temporarily suspended. Restore access after 2026-09-20T10:00:00Z",
        "kiro",
        "auto",
      );

      // Account-wide lock (modelLock___all), not per-model.
      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "kiro-a",
        expect.objectContaining({
          modelLock___all: "2026-09-20T10:00:00.000Z",
          testStatus: "unavailable",
          errorCode: 403,
          suspendedUntil: "2026-09-20T10:00:00.000Z",
        }),
      );
      expect(dbMocks.updateProviderConnection.mock.calls[0][1])
        .not.toHaveProperty("modelLock_auto");
      // 24h suspend window, not the default 2-minute cooldown.
      expect(result.cooldownMs).toBe(24 * 60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-offs for 24h when suspended without a parseable expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      const result = await markAccountUnavailable(
        "kiro-a",
        403,
        "Your User ID is temporarily suspended. We detected unusual user activity.",
        "kiro",
        "auto",
      );

      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "kiro-a",
        expect.objectContaining({
          modelLock___all: "2026-09-20T10:00:00.000Z",
          suspendIndefinite: true,
        }),
      );
      expect(result.cooldownMs).toBe(24 * 60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a non-suspension 403 model-scoped with the short cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      await markAccountUnavailable(
        "kiro-a",
        403,
        "permission denied",
        "kiro",
        "auto",
      );

      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "kiro-a",
        expect.objectContaining({
          modelLock_auto: "2026-09-19T10:02:00.000Z",
        }),
      );
      expect(dbMocks.updateProviderConnection.mock.calls[0][1])
        .not.toHaveProperty("modelLock___all");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("known-reset 429 handling", () => {
  it("holds the model off until a message-declared reset (Google 165h)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      const result = await markAccountUnavailable(
        "kiro-a",
        429,
        "Individual quota reached. Resets in 165h26m22s.",
        "antigravity",
        "gemini-3.8-flash-high",
      );

      const expectedReset = Date.now() + (165 * 3600 + 26 * 60 + 22) * 1000;
      // Not the 5-minute generic backoff — the exact declared window.
      expect(result.cooldownMs).toBe(165 * 3600 * 1000 + 26 * 60 * 1000 + 22 * 1000);
      expect(result.resetAtMs).toBe(expectedReset);
      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "kiro-a",
        expect.objectContaining({
          "modelLock_gemini-3.8-flash-high": new Date(expectedReset).toISOString(),
          suspendedUntil: new Date(expectedReset).toISOString(),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours a Retry-After header when the message has no reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      const result = await markAccountUnavailable(
        "kiro-a",
        429,
        "Too many requests, please wait before trying again.",
        "kiro",
        "auto",
        null,
        "600",
      );

      expect(result.cooldownMs).toBe(600_000);
      expect(result.resetAtMs).toBe(Date.now() + 600_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to generic backoff when no reset is declared", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      const result = await markAccountUnavailable(
        "kiro-a",
        429,
        "Too many requests, please wait before trying again.",
        "kiro",
        "auto",
      );

      // No declared reset → exponential backoff, not a 24h/7d window.
      expect(result.resetAtMs).toBeNull();
      expect(result.cooldownMs).toBeLessThanOrEqual(5 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });
});
