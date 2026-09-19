import { describe, it, expect, vi } from "vitest";
import { unavailableResponse } from "../../open-sse/utils/error.js";

// FIX-013: a null retryAfter used to become `new Date(null).getTime() === 0`,
// clamp to 1 and emit `Retry-After: 1` — a 1-second tight retry loop for an
// account that actually needs a manual unban.
describe("FIX-013: unavailableResponse Retry-After guard", () => {
  it("omits Retry-After when retryAfter is null (manual unban required)", () => {
    const res = unavailableResponse(503, "unavailable", null, "manual unban required");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(res.headers.get("Retry-After")).not.toBe("1");
  });

  it("omits Retry-After when retryAfter is undefined", () => {
    const res = unavailableResponse(503, "unavailable", undefined, "");
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("omits Retry-After when retryAfter is in the past", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const res = unavailableResponse(503, "unavailable", past, "reset after 0s");
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("emits the correct seconds for a valid future ISO timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const res = unavailableResponse(503, "unavailable", "2026-01-01T00:01:30.000Z", "reset after 1m 30s");
      expect(res.headers.get("Retry-After")).toBe("90");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a short future window as a whole second (minimum 1)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const res = unavailableResponse(503, "unavailable", "2026-01-01T00:00:00.250Z", "reset after 0s");
      expect(res.headers.get("Retry-After")).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the status code and human-readable body", async () => {
    const res = unavailableResponse(503, "all accounts banned", null, "manual unban required");
    expect(res.status).toBe(503);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body.error.message).toBe("all accounts banned (manual unban required)");
  });
});
