import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// quotaTracker is a fork-only table that persists Quota Tracker snapshots so
// fallback routing can consult them. These tests exercise the REAL repo against
// a temp DB (mirrors usage-byuser.test.js).
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-quotatracker-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("quotaTrackerRepo", () => {
  it("saves and reads back a snapshot (upsert)", async () => {
    await db.saveQuotaSnapshot("conn-1", {
      provider: "claude",
      status: "empty",
      remainingPct: 0,
      resetAt: "2030-01-01T00:00:00.000Z",
      quotas: [{ name: "session (5h)", remainingPercentage: 0 }],
    });
    const snap = await db.getQuotaSnapshot("conn-1");
    expect(snap).toBeTruthy();
    expect(snap.provider).toBe("claude");
    expect(snap.status).toBe("empty");
    expect(snap.remainingPct).toBe(0);
    expect(snap.resetAt).toBe("2030-01-01T00:00:00.000Z");
    expect(Array.isArray(snap.quotas)).toBe(true);
    expect(snap.quotas[0].name).toBe("session (5h)");

    // Upsert overwrites.
    await db.saveQuotaSnapshot("conn-1", {
      provider: "claude",
      status: "available",
      remainingPct: 80,
      resetAt: null,
      quotas: [],
    });
    const snap2 = await db.getQuotaSnapshot("conn-1");
    expect(snap2.status).toBe("available");
    expect(snap2.remainingPct).toBe(80);
    expect(snap2.resetAt).toBeNull();
  });

  it("getQuotaSnapshots returns a Map keyed by connectionId", async () => {
    await db.saveQuotaSnapshot("conn-a", { provider: "codex", status: "available", remainingPct: 90 });
    await db.saveQuotaSnapshot("conn-b", { provider: "codex", status: "empty", remainingPct: 2 });
    const map = await db.getQuotaSnapshots(["conn-a", "conn-b", "missing"]);
    expect(map).toBeInstanceOf(Map);
    expect(map.get("conn-a").remainingPct).toBe(90);
    expect(map.get("conn-b").status).toBe("empty");
    expect(map.has("missing")).toBe(false);
  });

  it("getQuotaSnapshots([]) returns an empty Map without querying", async () => {
    const map = await db.getQuotaSnapshots([]);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it("getAllQuotaSnapshots lists every row", async () => {
    const all = await db.getAllQuotaSnapshots();
    const ids = all.map((r) => r.connectionId);
    expect(ids).toContain("conn-1");
    expect(ids).toContain("conn-a");
    expect(ids).toContain("conn-b");
  });

  it("deleteQuotaSnapshot removes one row", async () => {
    await db.deleteQuotaSnapshot("conn-a");
    expect(await db.getQuotaSnapshot("conn-a")).toBeNull();
    const map = await db.getQuotaSnapshots(["conn-a"]);
    expect(map.has("conn-a")).toBe(false);
  });

  it("deleteQuotaSnapshotsByProvider removes all rows for a provider", async () => {
    await db.deleteQuotaSnapshotsByProvider("codex");
    expect(await db.getQuotaSnapshot("conn-b")).toBeNull();
    // claude row (conn-1) is untouched.
    expect(await db.getQuotaSnapshot("conn-1")).toBeTruthy();
  });

  it("deleting a connection also deletes its quota snapshot", async () => {
    const conn = await db.createProviderConnection({
      provider: "claude",
      authType: "apikey",
      name: "qt-del",
      apiKey: "sk-test",
    });
    await db.saveQuotaSnapshot(conn.id, { provider: "claude", status: "empty", remainingPct: 0 });
    expect(await db.getQuotaSnapshot(conn.id)).toBeTruthy();
    await db.deleteProviderConnection(conn.id);
    expect(await db.getQuotaSnapshot(conn.id)).toBeNull();
  });
});
