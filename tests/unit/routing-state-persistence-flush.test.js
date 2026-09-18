import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Focused proof that a mutation landing DURING an in-flight flush (i.e. while
// `kv.set` is awaited) keeps the store dirty for the next flush — write-behind
// must never silently drop a concurrent change.
//
// kvStore is mocked with a controllable, delayable in-memory store so the race
// is deterministic. The real-DB round-trip lives in routing-state-persistence.test.js.
const kvControl = vi.hoisted(() => ({
  setDelayMs: 0,
  store: new Map(),
}));

vi.mock("@/lib/db/helpers/kvStore.js", () => ({
  makeKv: () => ({
    async get(key, fallback = null) {
      return kvControl.store.has(key) ? JSON.parse(kvControl.store.get(key)) : fallback;
    },
    async set(key, value) {
      const serialized = JSON.stringify(value ?? null);
      if (kvControl.setDelayMs > 0) {
        await new Promise((r) => setTimeout(r, kvControl.setDelayMs));
      }
      kvControl.store.set(key, serialized);
    },
    async remove(key) { kvControl.store.delete(key); },
    async clear() { kvControl.store.clear(); },
  }),
}));

let routingStateStore;
let persistence;

beforeEach(async () => {
  vi.resetModules();
  kvControl.setDelayMs = 0;
  kvControl.store.clear();
  ({ routingStateStore } = await import("open-sse/services/routingStateStore.js"));
  persistence = await import("@/shared/services/routingStatePersistence.js");
  routingStateStore._resetAll();
});

afterEach(() => {
  persistence?.stopRoutingStatePersistence?.();
});

describe("routingStatePersistence — concurrent mutation during flush", () => {
  it("a mutation during an awaited flush stays dirty for the next flush", async () => {
    routingStateStore.recordOutcome("k1", { ok: true, latencyMs: 100 });

    // Slow the write so a second mutation lands while kv.set is in flight.
    kvControl.setDelayMs = 50;
    const flushPromise = persistence.flushRoutingState(true);

    // Mutation during the awaited write (after the version was captured).
    await new Promise((r) => setTimeout(r, 10));
    routingStateStore.recordOutcome("k1", { ok: true, latencyMs: 200 });

    const wrote = await flushPromise;
    expect(wrote).toBe(true);
    // The concurrent mutation must keep the store dirty.
    expect(routingStateStore.isDirty()).toBe(true);
    expect(routingStateStore.getStats("k1").usageCount).toBe(2);

    // A subsequent flush persists the newer state and clears dirty.
    kvControl.setDelayMs = 0;
    const wrote2 = await persistence.flushRoutingState();
    expect(wrote2).toBe(true);
    expect(routingStateStore.isDirty()).toBe(false);
    const persisted = JSON.parse(kvControl.store.get("state"));
    expect(persisted.stats.k1.usageCount).toBe(2);
  });

  it("stopRoutingStatePersistence detaches listeners and clears the interval", async () => {
    persistence.stopRoutingStatePersistence();
    const baseline = process.listenerCount("beforeExit");
    await persistence.initRoutingStatePersistence();
    const registered = process.listenerCount("beforeExit");
    expect(registered).toBe(baseline + 1);

    persistence.stopRoutingStatePersistence();
    expect(process.listenerCount("beforeExit")).toBe(baseline);

    // Re-init must not double-register.
    await persistence.initRoutingStatePersistence();
    expect(process.listenerCount("beforeExit")).toBe(baseline + 1);
    persistence.stopRoutingStatePersistence();
  });
});
