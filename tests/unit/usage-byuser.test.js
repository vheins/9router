import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The User tab derives its data from stats.byUser, which is built from raw
// usageHistory rows so it can carry latency + success/error timestamps. These
// tests exercise the REAL repo against a temp DB.
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let keyA;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-byuser-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  keyA = await db.createApiKey("Rheza", "machine-a");

  // Two successful requests for Rheza on model X, one on model Y.
  await db.saveRequestUsage({ provider: "openai", model: "gpt-4o", apiKey: keyA.key, tokens: { prompt_tokens: 1000, completion_tokens: 500, cached_tokens: 400 }, timestamp: new Date(Date.now() - 3000).toISOString(), ttftMs: 1000, totalMs: 4000 });
  await db.saveRequestUsage({ provider: "openai", model: "gpt-4o", apiKey: keyA.key, tokens: { prompt_tokens: 1000, completion_tokens: 500, cached_tokens: 400 }, timestamp: new Date(Date.now() - 2000).toISOString(), ttftMs: 3000, totalMs: 6000 });
  await db.saveRequestUsage({ provider: "openai", model: "gpt-4o-mini", apiKey: keyA.key, tokens: { prompt_tokens: 500, completion_tokens: 100 }, timestamp: new Date(Date.now() - 1000).toISOString(), ttftMs: 500, totalMs: 1000 });
  // One anonymous (no key) request.
  await db.saveRequestUsage({ provider: "openai", model: "gpt-4o", tokens: { prompt_tokens: 200, completion_tokens: 50 }, timestamp: new Date().toISOString(), ttftMs: 800, totalMs: 1600 });
  // One failed request for Rheza → drives Last Error.
  await db.recordRequestError({ provider: "openai", model: "gpt-4o", apiKey: keyA.key, error: "upstream 500" });
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("stats.byUser aggregation", () => {
  it("groups requests by API key with per-model breakdown", async () => {
    const stats = await db.getUsageStats("all");
    const byUser = stats.byUser;
    expect(byUser).toBeDefined();

    const rheza = byUser[keyA.key.slice(0, 8) + "***"];
    expect(rheza).toBeDefined();
    expect(rheza.keyName).toBe("Rheza");
    // 3 successes + 1 error row attributed to Rheza
    expect(rheza.requests).toBe(4);
    expect(rheza.errorRequests).toBe(1);
    expect(rheza.promptTokens).toBe(2500);
    expect(rheza.completionTokens).toBe(1100);
    expect(rheza.cachedTokens).toBe(800);

    // Model X aggregated across 2 requests
    const modelX = rheza.models["gpt-4o (openai)"];
    expect(modelX).toBeDefined();
    expect(modelX.requests).toBe(3); // 2 success + 1 error
    expect(modelX.promptTokens).toBe(2000);
    // avg ttft = (1000+3000)/2 = 2000 ; avg total = (4000+6000)/2 = 5000
    expect(modelX.avgTtftMs).toBe(2000);
    expect(modelX.avgTotalMs).toBe(5000);

    // Anonymous bucket present
    expect(byUser["local-no-key"]).toBeDefined();
    expect(byUser["local-no-key"].requests).toBe(1);
  });

  it("computes latency averages, TPS and last-success/error timestamps", async () => {
    const stats = await db.getUsageStats("all");
    const rheza = stats.byUser[keyA.key.slice(0, 8) + "***"];

    // 3 successful latency samples: (1000,4000), (3000,6000), (500,1000)
    expect(rheza.avgTtftMs).toBe(Math.round((1000 + 3000 + 500) / 3));
    expect(rheza.avgTotalMs).toBe(Math.round((4000 + 6000 + 1000) / 3));
    // TPS = sampled output tokens / sampled total time = 1100 / 11s = 100.0.
    // (The old bug divided the summed tokens by the AVERAGED time → ~300.)
    expect(rheza.sampledRequests).toBe(3);
    expect(rheza.sampledCompletionTokens).toBe(1100);
    expect(rheza.tps).toBe(100);
    expect(rheza.lastSuccess).toBeTruthy();
    expect(rheza.lastError).toBeTruthy();
    expect(rheza.cacheHitRate).toBeCloseTo(800 / 2500, 4);
  });

  it("reflects latency columns on getUsageHistory", async () => {
    const rows = await db.getUsageHistory({});
    const withLatency = rows.filter((r) => r.totalMs > 0);
    expect(withLatency.length).toBeGreaterThanOrEqual(4);
    const errRow = rows.find((r) => r.status === "error");
    expect(errRow).toBeDefined();
  });
});
