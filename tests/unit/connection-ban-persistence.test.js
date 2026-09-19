import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// FIX-012: ban markers live in the providerConnections data JSON. These tests
// exercise the REAL connectionsRepo against a temp DB (mirrors
// quota-tracker-repo.test.js) so the resetHealthStateOnActivation hook is not
// stubbed away.
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ban-"));
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

async function seedBannedConnection(overrides = {}) {
  const conn = await db.createProviderConnection({
    provider: "kiro",
    authType: "apikey",
    name: `banned-${Math.random().toString(36).slice(2, 8)}`,
    apiKey: "sk-test",
  });
  const banRetryAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await db.updateProviderConnection(conn.id, {
    banned: true,
    bannedAt: new Date().toISOString(),
    banReason: "temporarily suspended",
    banRetryAt,
    testStatus: "unavailable",
    lastError: "temporarily suspended",
    modelLock___all: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  });
  return { id: conn.id, banRetryAt };
}

describe("FIX-012: health-check activation must not unban", () => {
  it("preserves banned/bannedAt/banReason/banRetryAt on a testStatus:active update", async () => {
    const { id, banRetryAt } = await seedBannedConnection();

    // Health checks, model-endpoint tests and token refresh all send this.
    const updated = await db.updateProviderConnection(id, { testStatus: "active" });

    expect(updated.banned).toBe(true);
    expect(updated.banRetryAt).toBe(banRetryAt);
    expect(updated.banReason).toBe("temporarily suspended");
    expect(updated.bannedAt).toBeTruthy();
  });

  it("still resets health state (testStatus/lastError/model locks) on activation", async () => {
    const { id } = await seedBannedConnection();

    const updated = await db.updateProviderConnection(id, { testStatus: "active" });

    expect(updated.testStatus).toBe("active");
    expect(updated.lastError).toBeNull();
    expect(updated.modelLock___all).toBeNull();
    // Ban survives the same hook that clears the health fields.
    expect(updated.banned).toBe(true);
  });

  it("respects an explicit patch.banned:true passed alongside testStatus:active", async () => {
    const { id } = await seedBannedConnection({ banned: false, bannedAt: null, banReason: null, banRetryAt: null });

    const updated = await db.updateProviderConnection(id, { testStatus: "active", banned: true });

    expect(updated.banned).toBe(true);
  });

  it("clears all four ban markers on the explicit manual-unban patch", async () => {
    const { id } = await seedBannedConnection();

    // Exactly what PUT /api/providers/[id] { banned:false } sends.
    const updated = await db.updateProviderConnection(id, {
      banned: false,
      bannedAt: null,
      banReason: null,
      banRetryAt: null,
    });

    expect(updated.banned).toBe(false);
    expect(updated.bannedAt).toBeNull();
    expect(updated.banReason).toBeNull();
    expect(updated.banRetryAt).toBeNull();
  });
});
