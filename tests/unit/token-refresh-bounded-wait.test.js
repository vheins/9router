/**
 * Regression tests for FIX-007 (bounded wait / fail-open in checkAndRefreshToken)
 * and FIX-006 (AbortSignal.timeout on every OAuth/token fetch).
 *
 * Covered:
 *   1. Bounded wait fail-open: a never-resolving refresh must not block the
 *      request path; checkAndRefreshToken resolves fast with the ORIGINAL creds
 *      and does NOT persist anything.
 *   2. force:true unbounded: the background tick waits for the refresh and
 *      returns the NEW token.
 *   3. Refresh rejection fails open: a rejected refresh must not throw and must
 *      return the original creds.
 *   4. Every provider refresh fetch passes a `signal` AbortSignal (FIX-006).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// src/sse/services/tokenRefresh.js imports these from the open-sse credential
// manager (aliased as _refreshProviderCredentials / _shouldRefreshCredentials).
// Mocking the module is the only way to intercept the internal call.
vi.mock("open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: vi.fn(),
  shouldRefreshCredentials: vi.fn(() => true),
}));

// updateProviderCredentials() (local to src/sse/services/tokenRefresh.js) persists
// through updateProviderConnection() from localDb. Mock the persistence boundary
// so we can assert "no write happened" without touching a real database.
vi.mock("../../src/lib/localDb.js", async (importActual) => {
  const actual = await importActual();
  return { ...actual, updateProviderConnection: vi.fn() };
});

const credManager = await import("open-sse/services/oauthCredentialManager.js");
const localDb = await import("../../src/lib/localDb.js");
const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

const refreshProviderCredentials = credManager.refreshProviderCredentials;
const updateProviderConnection = localDb.updateProviderConnection;

function baseCreds(overrides = {}) {
  return {
    connectionId: "conn-1",
    provider: "grok-cli",
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

describe("checkAndRefreshToken — bounded wait (FIX-007)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credManager.shouldRefreshCredentials.mockReturnValue(true);
    updateProviderConnection.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails open fast and does not persist when the refresh never resolves", async () => {
    // Never-resolving refresh (simulates an in-flight refresh that hangs).
    refreshProviderCredentials.mockImplementation(() => new Promise(() => {}));

    const creds = baseCreds();
    const start = Date.now();
    const result = await checkAndRefreshToken("grok-cli", creds, { waitTimeoutMs: 50 });
    const elapsed = Date.now() - start;

    // Resolved well under the ~2s ceiling thanks to the 50ms bounded wait.
    expect(elapsed).toBeLessThan(1000);
    // Actually waited for the timeout (not an instant no-op).
    expect(elapsed).toBeGreaterThanOrEqual(40);

    expect(refreshProviderCredentials).toHaveBeenCalledTimes(1);
    // Fail-open: original credentials returned unchanged.
    expect(result.accessToken).toBe("old-access-token");
    expect(result.refreshToken).toBe("old-refresh-token");
    // Nothing persisted on timeout.
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("force:true waits unbounded and returns the refreshed token", async () => {
    refreshProviderCredentials.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ accessToken: "new-access-token", expiresIn: 3600 }),
            100
          )
        )
    );

    const creds = baseCreds();
    const start = Date.now();
    const result = await checkAndRefreshToken("grok-cli", creds, { force: true });
    const elapsed = Date.now() - start;

    // Waited for the ~100ms refresh instead of failing open at 0ms.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(result.accessToken).toBe("new-access-token");
    // A successful refresh is persisted.
    expect(updateProviderConnection).toHaveBeenCalledTimes(1);
  });

  it("fails open (does not throw) when the refresh rejects", async () => {
    refreshProviderCredentials.mockRejectedValue(new Error("network down"));

    const creds = baseCreds();
    await expect(
      checkAndRefreshToken("grok-cli", creds, { waitTimeoutMs: 50 })
    ).resolves.toEqual(expect.objectContaining({ accessToken: "old-access-token" }));

    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("checkAndRefreshToken — late persistence (FIX-009) and force rejection (FIX-010)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    credManager.shouldRefreshCredentials.mockReturnValue(true);
    updateProviderConnection.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists the late-completing refresh result after failing open", async () => {
    // Refresh resolves with a NEW token well after the 40ms bounded wait.
    refreshProviderCredentials.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ accessToken: "late-new-token", expiresIn: 3600 }),
            120
          )
        )
    );

    const creds = baseCreds();
    const start = Date.now();
    const result = await checkAndRefreshToken("grok-cli", creds, { waitTimeoutMs: 40 });
    const elapsed = Date.now() - start;

    // Returned quickly with the ORIGINAL creds (fail-open before the refresh resolved).
    expect(elapsed).toBeLessThan(100);
    expect(result.accessToken).toBe("old-access-token");

    // Wait for the in-flight refresh to complete and the continuation to persist.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(updateProviderConnection).toHaveBeenCalledTimes(1);
    const [, updates] = updateProviderConnection.mock.calls[0];
    expect(updates.accessToken).toBe("late-new-token");
  });

  it("force:true resolves with original creds when the refresh rejects (no throw)", async () => {
    refreshProviderCredentials.mockRejectedValue(new Error("refresh failed"));

    const creds = baseCreds();
    await expect(
      checkAndRefreshToken("grok-cli", creds, { force: true })
    ).resolves.toEqual(expect.objectContaining({ accessToken: "old-access-token" }));

    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("provider refresh fetch — AbortSignal (FIX-006)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refreshGoogleToken passes an AbortSignal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "google-acc", expires_in: 3600 }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const { refreshGoogleToken } = await import(
      "open-sse/services/tokenRefresh/providers.js"
    );

    // Unique token/clientId avoids the module-level dedup cache.
    const out = await refreshGoogleToken(
      "google-refresh-abort-signal",
      "client-id-abort-signal",
      "client-secret",
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(out.accessToken).toBe("google-acc");
  });
});
