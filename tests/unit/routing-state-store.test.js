import { describe, it, expect, beforeEach } from "vitest";
import { routingStateStore } from "open-sse/services/routingStateStore.js";

describe("routingStateStore — round-robin rotation", () => {
  beforeEach(() => routingStateStore._resetAll());

  it("nextRotation advances every call with stickyLimit=1", () => {
    expect(routingStateStore.nextRotation("k", 3, 1)).toBe(0);
    expect(routingStateStore.nextRotation("k", 3, 1)).toBe(1);
    expect(routingStateStore.nextRotation("k", 3, 1)).toBe(2);
    expect(routingStateStore.nextRotation("k", 3, 1)).toBe(0);
  });

  it("nextRotation sticks for stickyLimit calls", () => {
    expect(routingStateStore.nextRotation("k", 3, 2)).toBe(0);
    expect(routingStateStore.nextRotation("k", 3, 2)).toBe(0);
    expect(routingStateStore.nextRotation("k", 3, 2)).toBe(1);
    expect(routingStateStore.nextRotation("k", 3, 2)).toBe(1);
    expect(routingStateStore.nextRotation("k", 3, 2)).toBe(2);
    expect(routingStateStore.nextRotation("k", 3, 2)).toBe(2);
  });

  it("getRotation returns the stored {index,consecutiveUseCount}", () => {
    routingStateStore.setRotation("r", { index: 2, consecutiveUseCount: 1 });
    const rot = routingStateStore.getRotation("r");
    expect(rot).toMatchObject({ index: 2, consecutiveUseCount: 1 });
    expect(rot.lastUsedAt).toBeTruthy(); // rotation entries carry their own age
    expect(routingStateStore.getRotation("missing")).toBeNull();
  });

  it("resetRotation clears one key or all", () => {
    routingStateStore.nextRotation("a", 2, 1);
    routingStateStore.nextRotation("b", 2, 1);
    routingStateStore.resetRotation("a");
    expect(routingStateStore.getRotation("a")).toBeNull();
    expect(routingStateStore.getRotation("b")).not.toBeNull();
    routingStateStore.resetRotation();
    expect(routingStateStore.getRotation("b")).toBeNull();
  });
});

describe("routingStateStore — outcome stats", () => {
  beforeEach(() => routingStateStore._resetAll());

  it("first sample sets latencyEwmaMs; second applies EWMA (0.7/0.3)", () => {
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 100 });
    expect(routingStateStore.getStats("s").latencyEwmaMs).toBe(100);
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 200 });
    expect(routingStateStore.getStats("s").latencyEwmaMs).toBeCloseTo(100 * 0.7 + 200 * 0.3, 6);
  });

  it("tracks usage/success/error counts and successRate", () => {
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 10 });
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 10 });
    routingStateStore.recordOutcome("s", { ok: false, latencyMs: 10 });
    const st = routingStateStore.getStats("s");
    expect(st.usageCount).toBe(3);
    expect(st.successCount).toBe(2);
    expect(st.errorCount).toBe(1);
    expect(st.successCount / st.usageCount).toBeCloseTo(2 / 3, 6);
  });

  it("sets lastSuccessAt only on ok and lastErrorAt on failure", () => {
    routingStateStore.recordOutcome("s", { ok: false, latencyMs: 10 });
    let st = routingStateStore.getStats("s");
    expect(st.lastSuccessAt).toBeNull();
    expect(st.lastErrorAt).toBeTruthy();
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 10 });
    st = routingStateStore.getStats("s");
    expect(st.lastSuccessAt).toBeTruthy();
  });

  it("treats non-finite / non-positive latency as absent (undefined, not 0)", () => {
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 0 });
    expect(routingStateStore.getStats("s").latencyEwmaMs).toBeUndefined();
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: NaN });
    expect(routingStateStore.getStats("s").latencyEwmaMs).toBeUndefined();
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: null });
    expect(routingStateStore.getStats("s").latencyEwmaMs).toBeUndefined();
  });

  it("is dirty after a record and clean after clearDirty", () => {
    routingStateStore.clearDirty();
    expect(routingStateStore.isDirty()).toBe(false);
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 10 });
    expect(routingStateStore.isDirty()).toBe(true);
    routingStateStore.clearDirty();
    expect(routingStateStore.isDirty()).toBe(false);
  });
});

describe("routingStateStore — snapshot / restore", () => {
  beforeEach(() => routingStateStore._resetAll());

  it("round-trips all four maps", () => {
    routingStateStore.nextRotation("rot", 3, 1);
    routingStateStore.setLastGood("combo", "provider/model");
    routingStateStore.setLastHead("prov", "conn-1");
    routingStateStore.recordOutcome("conn-1", { ok: true, latencyMs: 42 });

    const snap = routingStateStore.snapshot();
    expect(snap.savedAt).toBeTruthy();
    expect(snap.rotation.rot).toMatchObject({ index: 1, consecutiveUseCount: 0 });
    expect(snap.lastGood.combo).toBe("provider/model");
    expect(snap.lastHead.prov).toBe("conn-1");
    expect(snap.stats["conn-1"].usageCount).toBe(1);

    routingStateStore._resetAll();
    expect(routingStateStore.getRotation("rot")).toBeNull();
    expect(routingStateStore.getLastGood("combo")).toBeNull();
    expect(routingStateStore.getLastHead("prov")).toBeNull();
    expect(routingStateStore.getStats("conn-1")).toBeNull();

    routingStateStore.restore(snap);
    expect(routingStateStore.getRotation("rot")).toMatchObject({ index: 1, consecutiveUseCount: 0 });
    expect(routingStateStore.getLastGood("combo")).toBe("provider/model");
    expect(routingStateStore.getLastHead("prov")).toBe("conn-1");
    expect(routingStateStore.getStats("conn-1").usageCount).toBe(1);
  });

  it("restore MERGES: keeps newer in-memory state, fills missing entries", () => {
    // A live request wrote rotation for "live" AFTER the snapshot was taken.
    routingStateStore.nextRotation("live", 3, 1);
    const liveBefore = routingStateStore.getRotation("live");

    // Persisted snapshot predates that request and lacks "live".
    const snap = {
      rotation: { old: { index: 2, consecutiveUseCount: 0, lastUsedAt: new Date().toISOString() } },
      lastGood: { "combo-old": "provider/old" },
      lastHead: { "prov-old": "conn-old" },
      stats: { "conn-old": { usageCount: 5, lastUsedAt: new Date().toISOString() } },
      savedAt: new Date().toISOString(),
    };
    routingStateStore.restore(snap);

    // Earlier in-memory state survives (not cleared / overwritten).
    expect(routingStateStore.getRotation("live")).toEqual(liveBefore);
    // Missing entries from the snapshot are filled in.
    expect(routingStateStore.getRotation("old")).toBeTruthy();
    expect(routingStateStore.getLastGood("combo-old")).toBe("provider/old");
    expect(routingStateStore.getLastHead("prov-old")).toBe("conn-old");
    expect(routingStateStore.getStats("conn-old").usageCount).toBe(5);
  });

  it("restore tolerates null / missing sub-objects", () => {
    expect(() => routingStateStore.restore(null)).not.toThrow();
    expect(() => routingStateStore.restore(undefined)).not.toThrow();
    expect(() => routingStateStore.restore({})).not.toThrow();
    expect(() => routingStateStore.restore({ rotation: null, stats: "nope" })).not.toThrow();
  });
});

describe("routingStateStore — pruneStats", () => {
  beforeEach(() => routingStateStore._resetAll());

  it("drops an old entry and keeps a fresh one", () => {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    // Inject via snapshot/restore to bypass recordOutcome's fresh timestamps.
    routingStateStore.restore({
      stats: {
        old: { usageCount: 1, lastUsedAt: old },
        fresh: { usageCount: 1, lastUsedAt: new Date().toISOString() },
      },
    });
    const removed = routingStateStore.pruneStats({ maxAgeMs: 7 * 24 * 3600 * 1000 });
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(routingStateStore.getStats("old")).toBeNull();
    expect(routingStateStore.getStats("fresh")).not.toBeNull();
  });

  it("keeps only the most-recently-used maxEntries", () => {
    const now = Date.now();
    routingStateStore.restore({
      stats: {
        a: { usageCount: 1, lastUsedAt: new Date(now - 3000).toISOString() },
        b: { usageCount: 1, lastUsedAt: new Date(now - 2000).toISOString() },
        c: { usageCount: 1, lastUsedAt: new Date(now - 1000).toISOString() },
      },
    });
    routingStateStore.pruneStats({ maxEntries: 2 });
    expect(routingStateStore.getStats("c")).not.toBeNull();
    expect(routingStateStore.getStats("b")).not.toBeNull();
    expect(routingStateStore.getStats("a")).toBeNull();
  });

  it("a fresh combo rotation key survives pruning even without a stats entry", () => {
    // Rotation keys are combo/provider namespaces; stats keys are model/connection
    // namespaces. A combo that has rotated but never succeeded has rotation state
    // and NO stats — pruning must NOT treat it as an orphan.
    routingStateStore.nextRotation("code-xhigh", 3, 1);
    expect(routingStateStore.getStats("code-xhigh")).toBeNull();

    routingStateStore.pruneStats({ maxAgeMs: 7 * 24 * 3600 * 1000 });
    expect(routingStateStore.getRotation("code-xhigh")).toMatchObject({ index: 1, consecutiveUseCount: 0 });
  });

  it("prunes rotation / lastGood / lastHead by their own age", () => {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const fresh = new Date().toISOString();
    routingStateStore.restore({
      rotation: {
        "old-combo": { index: 1, consecutiveUseCount: 0, lastUsedAt: old },
        "fresh-combo": { index: 1, consecutiveUseCount: 0, lastUsedAt: fresh },
      },
      lastGood: { "old-combo": "m/old", "fresh-combo": "m/fresh" },
      lastGoodAt: { "old-combo": old, "fresh-combo": fresh },
      lastHead: { oldprov: "c-old", freshprov: "c-fresh" },
      lastHeadAt: { oldprov: old, freshprov: fresh },
    });
    routingStateStore.pruneStats({ maxAgeMs: 7 * 24 * 3600 * 1000 });
    expect(routingStateStore.getRotation("old-combo")).toBeNull();
    expect(routingStateStore.getRotation("fresh-combo")).not.toBeNull();
    expect(routingStateStore.getLastGood("old-combo")).toBeNull();
    expect(routingStateStore.getLastGood("fresh-combo")).toBe("m/fresh");
    expect(routingStateStore.getLastHead("oldprov")).toBeNull();
    expect(routingStateStore.getLastHead("freshprov")).toBe("c-fresh");
  });
});

describe("routingStateStore — mutation version", () => {
  beforeEach(() => routingStateStore._resetAll());

  it("increments on every mutation and is exposed via getVersion", () => {
    const v0 = routingStateStore.getVersion();
    routingStateStore.nextRotation("k", 2, 1);
    const v1 = routingStateStore.getVersion();
    expect(v1).toBeGreaterThan(v0);
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 5 });
    expect(routingStateStore.getVersion()).toBeGreaterThan(v1);
  });

  it("snapshot carries the version", () => {
    routingStateStore.nextRotation("k", 2, 1);
    expect(routingStateStore.snapshot().version).toBe(routingStateStore.getVersion());
  });

  it("clearDirty(v) keeps dirty when a mutation happened after v", () => {
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 5 });
    const flushedVersion = routingStateStore.getVersion();
    // A mutation lands while the flush's kv.set is in flight.
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 6 });
    routingStateStore.clearDirty(flushedVersion);
    expect(routingStateStore.isDirty()).toBe(true); // stays dirty for next flush
    routingStateStore.clearDirty(routingStateStore.getVersion());
    expect(routingStateStore.isDirty()).toBe(false);
  });

  it("clearDirty() with no version clears unconditionally (back-compat)", () => {
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 5 });
    routingStateStore.clearDirty();
    expect(routingStateStore.isDirty()).toBe(false);
  });
});

describe("routingStateStore — _resetAll", () => {
  it("clears everything", () => {
    routingStateStore.nextRotation("rot", 2, 1);
    routingStateStore.setLastGood("g", "m");
    routingStateStore.setLastHead("h", "id");
    routingStateStore.recordOutcome("s", { ok: true, latencyMs: 5 });
    routingStateStore._resetAll();
    expect(routingStateStore.getRotation("rot")).toBeNull();
    expect(routingStateStore.getLastGood("g")).toBeNull();
    expect(routingStateStore.getLastHead("h")).toBeNull();
    expect(routingStateStore.getStats("s")).toBeNull();
    expect(routingStateStore.isDirty()).toBe(false);
  });
});

describe("routingStateStore — purity / no DB coupling", () => {
  it("exports the expected singleton surface", () => {
    for (const m of [
      "getRotation", "setRotation", "nextRotation", "resetRotation",
      "getLastGood", "setLastGood", "clearLastGood",
      "getLastHead", "setLastHead",
      "recordOutcome", "getStats", "snapshot", "restore",
      "isDirty", "getVersion", "clearDirty", "pruneStats", "_resetAll",
    ]) {
      expect(typeof routingStateStore[m]).toBe("function");
    }
  });
});
