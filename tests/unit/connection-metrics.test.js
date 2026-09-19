import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { orderTargets } from "open-sse/services/routingStrategies.js";

// TASK-009: per-connection 24h rolling metrics for the `auto` routing strategy.
// Part 1 exercises the REAL repo aggregator against a temp DB.
// Part 2 exercises the pure autoScore() ranking with the new target fields.
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

const now = Date.now();

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-connmetrics-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();

  // connA: two successful requests with latency → full metrics.
  await db.saveRequestUsage({
    provider: "openai", model: "gpt-4o", connectionId: "connA",
    tokens: { prompt_tokens: 1000, completion_tokens: 500 },
    timestamp: new Date(now - 3000).toISOString(), ttftMs: 1000, totalMs: 4000,
  });
  await db.saveRequestUsage({
    provider: "openai", model: "gpt-4o", connectionId: "connA",
    tokens: { prompt_tokens: 1000, completion_tokens: 500 },
    timestamp: new Date(now - 2000).toISOString(), ttftMs: 3000, totalMs: 6000,
  });
  // connB: a single failed request (no tokens, no latency sample).
  await db.recordRequestError({
    provider: "openai", model: "gpt-4o", connectionId: "connB", error: "upstream 500",
  });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("per-connection 24h metrics aggregator", () => {
  it("computes latency averages, TPS, tokens/req, RPM and last success/error", async () => {
    const map = await db.refreshConnectionMetrics24h({ force: true });
    const a = map.connA;
    expect(a).toBeDefined();
    // avg ttft = (1000+3000)/2 ; avg total = (4000+6000)/2
    expect(a.avgTtftMs).toBe(2000);
    expect(a.avgTotalMs).toBe(5000);
    // TPS = sampled output tokens / summed wall time = 1000 / 10s = 100.
    expect(a.tps).toBe(100);
    // tokensPerReq = (1000+500 prompt+completion) * 2 / 2 = 1500.
    expect(a.tokensPerReq).toBe(1500);
    // RPM = 2 requests / (24h = 1440 min).
    expect(a.rpm).toBeCloseTo(2 / 1440, 4);
    expect(a.lastSuccessAt).toBeTruthy();
    expect(a.lastErrorAt).toBeNull();
    expect(a.sampleCount).toBe(2);
  });

  it("keeps latency/TPS null for a connection with only error rows", async () => {
    const map = await db.refreshConnectionMetrics24h({ force: true });
    const b = map.connB;
    expect(b).toBeDefined();
    expect(b.avgTtftMs).toBeNull();
    expect(b.avgTotalMs).toBeNull();
    expect(b.tps).toBeNull();
    expect(b.sampleCount).toBe(0);
    expect(b.tokensPerReq).toBe(0);
    expect(b.lastSuccessAt).toBeNull();
    expect(b.lastErrorAt).toBeTruthy();
  });

  it("omits connections with no samples", async () => {
    const map = await db.refreshConnectionMetrics24h({ force: true });
    expect(map.connC).toBeUndefined();
  });

  it("reads the cached map synchronously without another refresh", async () => {
    const map = await db.refreshConnectionMetrics24h({ force: true });
    expect(db.getConnectionMetrics24hCached()).toBe(map);
    // A non-forced read inside the TTL returns the same cached object.
    const again = await db.refreshConnectionMetrics24h();
    expect(again).toBe(map);
  });
});

// ── Part 2: autoScore consumes the metrics with bounded weights ──────────────
const base = {
  successRate: 0.9,
  cost: 1,
  latencyMs: 1000,
  quotaRemainingPct: 50,
  usageCount: 5,
  priority: 1,
  testStatus: "active",
  consecutiveErrors: 0,
};

describe("autoScore with 24h metrics", () => {
  it("ranks a faster + more reliable connection above a slower failing one", () => {
    const fast = {
      ...base, key: "fast",
      avgTtftMs: 200, avgTotalMs: 1000, tps: 120, tokensPerReq: 500, rpm: 8,
      lastSuccess24hAt: new Date(now - 60000).toISOString(),
    };
    const slow = {
      ...base, key: "slow",
      avgTtftMs: 4000, avgTotalMs: 12000, tps: 4, tokensPerReq: 500, rpm: 1,
      lastError24hAt: new Date(now - 60000).toISOString(),
    };
    const out = orderTargets([slow, fast], "auto", { nowMs: now });
    expect(out[0].key).toBe("fast");
  });

  it("does not throw and keeps a fully-sampled healthy target ahead of a metric-less one", () => {
    const rich = {
      key: "rich", successRate: 0.9, testStatus: "active",
      avgTtftMs: 200, avgTotalMs: 800, tps: 100, tokensPerReq: 400, rpm: 5,
      lastSuccess24hAt: new Date(now - 1000).toISOString(),
    };
    const bare = { key: "bare", successRate: 0.9, testStatus: "active" };
    expect(() => orderTargets([bare, rich], "auto", { nowMs: now })).not.toThrow();
    const out = orderTargets([bare, rich], "auto", { nowMs: now });
    expect(out[0].key).toBe("rich");
  });

  it("treats explicit null metrics as absent (error-only connection does not win)", () => {
    // The aggregator emits avgTtftMs/avgTotalMs/tps = null for connections with
    // only error rows; Number(null) === 0, so these must not be scored as best.
    const errored = {
      ...base, key: "errored", avgTtftMs: null, avgTotalMs: null, tps: null,
      tokensPerReq: 0, rpm: 0.0014, lastError24hAt: new Date(now - 1000).toISOString(),
    };
    const sampled = {
      ...base, key: "sampled", avgTtftMs: 2000, avgTotalMs: 5000, tps: 20,
      tokensPerReq: 500, rpm: 0.0014, lastSuccess24hAt: new Date(now - 1000).toISOString(),
    };
    const out = orderTargets([errored, sampled], "auto", { nowMs: now });
    expect(out[0].key).toBe("sampled");
  });

  it("penalizes a recent 24h error and rewards a recent 24h success", () => {
    const errored = {
      ...base, key: "errored",
      avgTtftMs: 200, avgTotalMs: 1000, tps: 120, tokensPerReq: 500, rpm: 8,
      lastError24hAt: new Date(now - 1000).toISOString(),
    };
    const succeeded = {
      ...base, key: "succeeded",
      avgTtftMs: 200, avgTotalMs: 1000, tps: 120, tokensPerReq: 500, rpm: 8,
      lastSuccess24hAt: new Date(now - 1000).toISOString(),
    };
    const out = orderTargets([errored, succeeded], "auto", { nowMs: now });
    expect(out[0].key).toBe("succeeded");
  });

  it("preserves the existing base weighting when no 24h metrics are present", () => {
    const out = orderTargets([
      { key: "bad", successRate: 0.1, cost: 10, latencyMs: 5000, testStatus: "unavailable", consecutiveErrors: 3 },
      { key: "good", successRate: 0.99, cost: 0.1, latencyMs: 300, testStatus: "active", consecutiveErrors: 0 },
    ], "auto", { nowMs: now });
    expect(out[0].key).toBe("good");
  });
});
