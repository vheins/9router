import { describe, it, expect } from "vitest";
import {
  orderTargets,
  nextRoundRobinIndex,
  resetRotationState,
  isSelectionStrategy,
  isOrchestrationStrategy,
  getStrategyMeta,
  SELECTION_STRATEGIES,
} from "open-sse/services/routingStrategies.js";

// Deterministic RNG (mulberry32) so shuffle-based strategies are reproducible.
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T = (key, extra = {}) => ({ key, ...extra });

describe("routingStrategies — metadata", () => {
  it("classifies selection vs orchestration", () => {
    expect(isSelectionStrategy("weighted")).toBe(true);
    expect(isSelectionStrategy("fallback")).toBe(true);
    expect(isSelectionStrategy("fusion")).toBe(false);
    expect(isOrchestrationStrategy("fusion")).toBe(true);
    expect(isOrchestrationStrategy("fallback")).toBe(true);
    expect(isOrchestrationStrategy("weighted")).toBe(false);
  });

  it("exposes a label for every selection strategy", () => {
    for (const s of SELECTION_STRATEGIES) {
      expect(getStrategyMeta(s.value)?.label).toBeTruthy();
    }
  });
});

describe("routingStrategies — deterministic orderings", () => {
  it("priority sorts by ascending priority", () => {
    const out = orderTargets([T("a", { priority: 3 }), T("b", { priority: 1 }), T("c", { priority: 2 })], "priority");
    expect(out.map((t) => t.key)).toEqual(["b", "c", "a"]);
  });

  it("fill-first / fallback preserves incoming order", () => {
    const input = [T("a"), T("b"), T("c")];
    expect(orderTargets(input, "fill-first").map((t) => t.key)).toEqual(["a", "b", "c"]);
    expect(orderTargets(input, "fallback").map((t) => t.key)).toEqual(["a", "b", "c"]);
  });

  it("least-used sorts by ascending usageCount", () => {
    const out = orderTargets([T("a", { usageCount: 5 }), T("b", { usageCount: 1 }), T("c", { usageCount: 3 })], "least-used");
    expect(out.map((t) => t.key)).toEqual(["b", "c", "a"]);
  });

  it("cost-optimized puts cheapest first, unknown cost last", () => {
    const out = orderTargets([T("a", { cost: 5 }), T("b", { cost: 0 }), T("c", {})], "cost-optimized");
    expect(out.map((t) => t.key)).toEqual(["b", "a", "c"]);
  });

  it("headroom puts most remaining quota first", () => {
    const out = orderTargets([T("a", { quotaRemainingPct: 10 }), T("b", { quotaRemainingPct: 90 }), T("c", { quotaRemainingPct: 50 })], "headroom");
    expect(out.map((t) => t.key)).toEqual(["b", "c", "a"]);
  });

  it("reset-window puts soonest reset first", () => {
    const now = Date.now();
    const out = orderTargets([
      T("a", { resetAtMs: now + 60000 }),
      T("b", { resetAtMs: now + 1000 }),
      T("c", { resetAtMs: now + 30000 }),
    ], "reset-window");
    expect(out.map((t) => t.key)).toEqual(["b", "c", "a"]);
  });

  it("reset-aware prefers targets with quota, then soonest reset", () => {
    const now = Date.now();
    const out = orderTargets([
      T("exhausted", { quotaRemainingPct: 0, resetAtMs: now + 1000 }),
      T("fresh", { quotaRemainingPct: 50, resetAtMs: now + 90000 }),
      T("soon", { quotaRemainingPct: 80, resetAtMs: now + 5000 }),
    ], "reset-aware");
    // both with quota first (soon before fresh), exhausted last
    expect(out.map((t) => t.key)).toEqual(["soon", "fresh", "exhausted"]);
  });

  it("lkgp floats the last-known-good target to the front", () => {
    const out = orderTargets([T("a"), T("b"), T("c")], "lkgp", { lastGoodKey: "c" });
    expect(out.map((t) => t.key)).toEqual(["c", "a", "b"]);
  });

  it("lkgp keeps order when no last-good key", () => {
    const out = orderTargets([T("a"), T("b")], "lkgp", {});
    expect(out.map((t) => t.key)).toEqual(["a", "b"]);
  });
});

describe("routingStrategies — randomized orderings (seeded)", () => {
  it("strict-random is a permutation of the input", () => {
    const input = [T("a"), T("b"), T("c"), T("d")];
    const out = orderTargets(input, "strict-random", { rng: seededRng(42) });
    expect(out.map((t) => t.key).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("random is a permutation and avoids repeating the previous head", () => {
    const input = [T("a"), T("b"), T("c")];
    // Force the shuffle to put "a" first, then verify dedup swaps it away.
    const out = orderTargets(input, "random", { rng: () => 0, lastHeadKey: "a" });
    expect(out[0].key).not.toBe("a");
    expect(out.map((t) => t.key).sort()).toEqual(["a", "b", "c"]);
  });

  it("weighted favors higher weights over many trials", () => {
    const input = [T("heavy", { weight: 9 }), T("light", { weight: 1 })];
    let heavyFirst = 0;
    for (let seed = 0; seed < 200; seed++) {
      const out = orderTargets(input, "weighted", { rng: seededRng(seed) });
      if (out[0].key === "heavy") heavyFirst++;
    }
    expect(heavyFirst).toBeGreaterThan(140); // ~90% expected
  });

  it("weighted with no weights behaves like uniform without replacement", () => {
    const out = orderTargets([T("a"), T("b"), T("c")], "weighted", { rng: seededRng(7) });
    expect(out.map((t) => t.key).sort()).toEqual(["a", "b", "c"]);
  });

  it("p2c picks the less-loaded of two candidates", () => {
    const input = [T("busy", { activeRequests: 10 }), T("idle", { activeRequests: 0 })];
    const out = orderTargets(input, "p2c", { rng: () => 0 }); // picks idx 0 and 1
    expect(out[0].key).toBe("idle");
    expect(out[1].key).toBe("busy");
  });
});

describe("routingStrategies — round robin", () => {
  it("orderTargets rotates by rotationIndex", () => {
    const out = orderTargets([T("a"), T("b"), T("c")], "round-robin", { rotationIndex: 1 });
    expect(out.map((t) => t.key)).toEqual(["b", "c", "a"]);
  });

  it("nextRoundRobinIndex advances after stickyLimit uses", () => {
    resetRotationState("t");
    expect(nextRoundRobinIndex("t", 3, 1)).toBe(0); // use 1 → advance
    expect(nextRoundRobinIndex("t", 3, 1)).toBe(1);
    expect(nextRoundRobinIndex("t", 3, 1)).toBe(2);
    expect(nextRoundRobinIndex("t", 3, 1)).toBe(0);
  });

  it("nextRoundRobinIndex sticks for stickyLimit calls", () => {
    resetRotationState("s");
    expect(nextRoundRobinIndex("s", 3, 2)).toBe(0);
    expect(nextRoundRobinIndex("s", 3, 2)).toBe(0); // second use of index 0
    expect(nextRoundRobinIndex("s", 3, 2)).toBe(1);
    expect(nextRoundRobinIndex("s", 3, 2)).toBe(1);
    expect(nextRoundRobinIndex("s", 3, 2)).toBe(2);
  });
});

describe("routingStrategies — auto scoring", () => {
  it("prefers healthy, cheap, low-latency, high-success targets", () => {
    const out = orderTargets([
      T("bad", { successRate: 0.1, cost: 10, latencyMs: 5000, testStatus: "unavailable", consecutiveErrors: 3 }),
      T("good", { successRate: 0.99, cost: 0.1, latencyMs: 300, testStatus: "active", consecutiveErrors: 0 }),
    ], "auto");
    expect(out[0].key).toBe("good");
  });
});

describe("routingStrategies — purity", () => {
  it("never mutates the input array", () => {
    const input = [T("a", { priority: 2 }), T("b", { priority: 1 })];
    const snapshot = input.map((t) => t.key);
    orderTargets(input, "priority");
    orderTargets(input, "strict-random", { rng: seededRng(1) });
    expect(input.map((t) => t.key)).toEqual(snapshot);
  });

  it("returns a copy for <=1 targets", () => {
    const single = [T("only")];
    const out = orderTargets(single, "weighted");
    expect(out).not.toBe(single);
    expect(out[0].key).toBe("only");
  });

  it("handles empty / null input", () => {
    expect(orderTargets(null, "priority")).toEqual([]);
    expect(orderTargets([], "auto")).toEqual([]);
  });
});
