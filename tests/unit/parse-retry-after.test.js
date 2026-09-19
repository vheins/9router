import { describe, expect, it, vi } from "vitest";
import {
  parseDurationToMs,
  parseResetTimeFromMessage,
  parseRetryAfterHeader,
  resolveResetAt,
  clampCooldownMs,
  MIN_RESET_COOLDOWN_MS,
  MAX_RESET_COOLDOWN_MS,
} from "../../open-sse/utils/parseRetryAfter.js";

describe("parseDurationToMs", () => {
  it("parses compound h/m/s durations", () => {
    expect(parseDurationToMs("165h26m22s")).toBe(
      (165 * 3600 + 26 * 60 + 22) * 1000,
    );
  });

  it("parses spaced and word units", () => {
    expect(parseDurationToMs("2 minutes 30 seconds")).toBe(150_000);
    expect(parseDurationToMs("1 hour")).toBe(3_600_000);
    expect(parseDurationToMs("1 day")).toBe(86_400_000);
  });

  it("returns null when no unit is present", () => {
    expect(parseDurationToMs("120")).toBeNull();
    expect(parseDurationToMs("")).toBeNull();
    expect(parseDurationToMs(null)).toBeNull();
  });
});

describe("parseResetTimeFromMessage", () => {
  it("parses Google 'Resets in 165h26m22s'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      const at = parseResetTimeFromMessage(
        "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 165h26m22s.",
      );
      const expected = Date.now() + (165 * 3600 + 26 * 60 + 22) * 1000;
      expect(at).toBe(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses 'retry after 30s'", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      expect(parseResetTimeFromMessage("rate limited, retry after 30s")).toBe(
        Date.now() + 30_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses an absolute resets_at timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      expect(
        parseResetTimeFromMessage("usage_limit_reached resets_at 2026-09-20T10:00:00Z"),
      ).toBe(new Date("2026-09-20T10:00:00Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null for a message with no reset info", () => {
    expect(
      parseResetTimeFromMessage("Too many requests, please wait before trying again."),
    ).toBeNull();
  });

  it("ignores past absolute timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      expect(
        parseResetTimeFromMessage("resets_at 2026-01-01T00:00:00Z"),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseRetryAfterHeader", () => {
  it("parses delta seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      expect(parseRetryAfterHeader("120")).toBe(Date.now() + 120_000);
      expect(parseRetryAfterHeader(120)).toBe(Date.now() + 120_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses an HTTP-date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      const target = "2026-09-19T10:05:00.000Z";
      expect(parseRetryAfterHeader(new Date(target).toUTCString())).toBe(
        new Date(target).getTime(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null for empty/garbage values", () => {
    expect(parseRetryAfterHeader(null)).toBeNull();
    expect(parseRetryAfterHeader("")).toBeNull();
    expect(parseRetryAfterHeader("not-a-date")).toBeNull();
  });
});

describe("resolveResetAt", () => {
  it("prefers the message over the header and explicit value", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      const at = resolveResetAt({
        errorText: "Resets in 10m",
        retryAfter: "3600",
        resetsAtMs: Date.now() + 999_999,
      });
      expect(at).toBe(Date.now() + 600_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the header when the message has no reset", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      expect(resolveResetAt({ errorText: "nope", retryAfter: "60" })).toBe(
        Date.now() + 60_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to an explicit resetsAtMs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
    try {
      expect(resolveResetAt({ errorText: "nope", resetsAtMs: Date.now() + 5_000 })).toBe(
        Date.now() + 5_000,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when nothing is available", () => {
    expect(resolveResetAt({ errorText: "unknown", retryAfter: null })).toBeNull();
  });
});

describe("clampCooldownMs", () => {
  it("clamps to the shared bounds", () => {
    expect(clampCooldownMs(0)).toBe(MIN_RESET_COOLDOWN_MS);
    expect(clampCooldownMs(60_000)).toBe(60_000);
    expect(clampCooldownMs(MAX_RESET_COOLDOWN_MS + 1)).toBe(MAX_RESET_COOLDOWN_MS);
  });
});
