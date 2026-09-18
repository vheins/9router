// Shared routing-strategy engine.
//
// ONE ordering engine used by BOTH:
//   • combo model selection (open-sse/services/combo.js)
//   • provider-connection / account selection (src/sse/services/auth.js)
//
// Each strategy turns an ordered list of "targets" into a NEW ordered list.
// Callers then either iterate the list (combo fallback) or take the head
// (account selection). Keeping the engine pure (no node:fs, no DB, no globals
// beyond a tiny in-memory round-robin map) lets the dashboard import the
// strategy metadata for its dropdowns without pulling server code into the
// browser bundle.
//
// A "target" is a plain object. Recognized fields (all optional; missing data
// degrades gracefully to the caller's incoming order):
//   key                 string  stable id (model string / connection id)
//   priority            number  lower = earlier (1 = highest)
//   weight              number  relative weight for `weighted` (default 1)
//   cost                number  $ per request estimate (for `cost-optimized`)
//   quotaRemainingPct   number  0-100 remaining quota (headroom/reset-aware)
//   resetAtMs           number  epoch ms when quota resets (reset-*)
//   usageCount          number  cumulative requests served (least-used)
//   consecutiveUseCount number  current streak (p2c load proxy)
//   activeRequests      number  in-flight requests (p2c load proxy)
//   consecutiveErrors   number  recent failures (auto penalty)
//   successRate         number  0-1 (auto)
//   latencyMs           number  recent avg latency (auto)
//   testStatus          string  "active" | "unavailable" | ... (auto)
//   lastUsedAt          string|number  ISO or epoch (recency/auto)
//   lastSuccessAt       string|number  ISO or epoch (lkgp)

import { routingStateStore } from "./routingStateStore.js";

/** Selection strategies — order/pick targets. */
export const SELECTION_STRATEGIES = [
  { value: "priority", label: "Priority", desc: "Strict priority tiers — lowest number first" },
  { value: "fill-first", label: "Fill First", desc: "Drain the first target, then move on" },
  { value: "weighted", label: "Weighted", desc: "Weighted random pick by configured weight" },
  { value: "round-robin", label: "Round Robin", desc: "Cycle in order, N calls per target" },
  { value: "p2c", label: "Power of Two", desc: "Pick 2 at random, take the less loaded" },
  { value: "least-used", label: "Least Used", desc: "Fewest requests served so far" },
  { value: "random", label: "Random", desc: "Uniform random — no repeat until all used" },
  { value: "strict-random", label: "Strict Random", desc: "Pure random — repeats allowed" },
  { value: "cost-optimized", label: "Cost Optimized", desc: "Cheapest $ per request first" },
  { value: "headroom", label: "Headroom", desc: "Most remaining quota first" },
  { value: "reset-window", label: "Reset Window", desc: "Quota resets soonest → use it" },
  { value: "reset-aware", label: "Reset Aware", desc: "Rank by reset window, short first" },
  { value: "lkgp", label: "Last Known Good", desc: "Sticky to the last successful target" },
  { value: "auto", label: "Auto (scored)", desc: "Live multi-factor scoring" },
];

/** Orchestration strategies — change the request flow, not just the pick. */
export const ORCHESTRATION_STRATEGIES = [
  { value: "fallback", label: "Fallback", desc: "Try targets in order until one succeeds" },
  { value: "fusion", label: "Fusion", desc: "Panel of models + a judge that synthesizes" },
];

export const ALL_STRATEGIES = [...ORCHESTRATION_STRATEGIES, ...SELECTION_STRATEGIES];

const SELECTION_VALUES = new Set(SELECTION_STRATEGIES.map((s) => s.value));
const ORCHESTRATION_VALUES = new Set(ORCHESTRATION_STRATEGIES.map((s) => s.value));

// Strategies whose ordering is purely positional (the caller's order encodes
// intent). Only these get the quota-aware "sink depleted targets" pass; scoring
// and sampling strategies already factor quota into their own ranking.
const QUOTA_AWARE_STRATEGIES = new Set(["fallback", "fill-first", "priority", "lkgp"]);

/** True when `value` is a known selection strategy. `fallback` counts as fill-first. */
export function isSelectionStrategy(value) {
  return value === "fallback" || SELECTION_VALUES.has(value);
}

/** True when `value` is an orchestration strategy (fallback / fusion). */
export function isOrchestrationStrategy(value) {
  return ORCHESTRATION_VALUES.has(value);
}

/** Metadata for a strategy value, or undefined. */
export function getStrategyMeta(value) {
  return ALL_STRATEGIES.find((s) => s.value === value);
}

// ── small helpers ────────────────────────────────────────────────────────

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function ts(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// Stable sort by a numeric key (V8's sort is stable).
function sortBy(list, keyFn) {
  return list
    .map((t, i) => ({ t, i, k: keyFn(t) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.t);
}

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function rotateBy(list, index) {
  const n = list.length;
  if (n <= 1) return [...list];
  const k = ((Math.floor(index) % n) + n) % n;
  return [...list.slice(k), ...list.slice(0, k)];
}

// Weighted sampling WITHOUT replacement: repeatedly pick proportional to weight.
function weightedOrder(list, weightFn, rng) {
  const pool = list.map((t) => ({ t, w: Math.max(0, weightFn(t)) }));
  const out = [];
  while (pool.length > 0) {
    const total = pool.reduce((s, p) => s + p.w, 0);
    if (total <= 0) {
      // No weights configured — fall back to uniform without replacement.
      const idx = Math.floor(rng() * pool.length);
      out.push(pool.splice(idx, 1)[0].t);
      continue;
    }
    let r = rng() * total;
    let picked = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) { picked = i; break; }
    }
    out.push(pool.splice(picked, 1)[0].t);
  }
  return out;
}

function loadOf(t) {
  // Prefer live in-flight count, else the recent streak, else cumulative usage.
  return num(t.activeRequests, num(t.consecutiveUseCount, num(t.usageCount, 0)));
}

// Power of two choices: sample two distinct targets, put the less-loaded first.
function p2cOrder(list, rng) {
  if (list.length <= 1) return [...list];
  const idxA = Math.floor(rng() * list.length);
  let idxB = Math.floor(rng() * list.length);
  if (idxB === idxA) idxB = (idxA + 1) % list.length;
  const a = list[idxA];
  const b = list[idxB];
  const winner = loadOf(a) <= loadOf(b) ? idxA : idxB;
  const loser = winner === idxA ? idxB : idxA;
  const rest = list.filter((_, i) => i !== winner && i !== loser);
  return [list[winner], list[loser], ...rest];
}

function costOf(t) {
  const c = Number(t.cost);
  return Number.isFinite(c) ? c : Number.POSITIVE_INFINITY;
}

function quotaOf(t) {
  const q = Number(t.quotaRemainingPct);
  // Unknown quota → neutral 50 so it neither dominates nor is starved.
  return Number.isFinite(q) ? q : 50;
}

function resetOf(t) {
  const r = ts(t.resetAtMs);
  return r === null ? Number.POSITIVE_INFINITY : r;
}

// Threshold below which a target counts as "depleted" for quota-aware ordering.
const DEPLETED_QUOTA_THRESHOLD = 5;

// Is this target currently out of quota? Unknown quota is treated as available
// (we must not starve a target just because we never measured it).
function isDepleted(t, nowMs) {
  if (t.quotaUnlimited) return false;
  const q = Number(t.quotaRemainingPct);
  if (!Number.isFinite(q)) return false;
  if (q > DEPLETED_QUOTA_THRESHOLD) return false;
  // If a reset time is known and already past, the window has refilled.
  const r = ts(t.resetAtMs);
  if (r !== null && r <= nowMs) return false;
  return true;
}

// Quota-aware reorder: keep the caller's order but float depleted targets to the
// end (stable partition). Used for fallback / fill-first / priority so an
// exhausted account is only tried after every account that still has quota.
export function quotaAwareOrder(list, nowMs = Date.now()) {
  const available = [];
  const depleted = [];
  for (const t of list) (isDepleted(t, nowMs) ? depleted : available).push(t);
  return [...available, ...depleted];
}

// reset-aware: targets that still have quota first, then soonest reset first.
function resetAwareRank(t) {
  const hasQuota = quotaOf(t) > 0 ? 0 : 1;
  return hasQuota * 1e15 + resetOf(t);
}

// lkgp: last-known-good target first, everything else keeps its order.
function lkgpOrder(list, lastGoodKey) {
  if (!lastGoodKey) return [...list];
  const idx = list.findIndex((t) => t.key === lastGoodKey);
  if (idx <= 0) return [...list];
  const out = [...list];
  const [good] = out.splice(idx, 1);
  return [good, ...out];
}

// auto: weighted multi-factor score. Higher = better. All factors normalized
// within the candidate set so the score is comparable.
function autoScore(t, ctx) {
  const set = ctx?._set || [];
  const norm = (v, min, max) => (max > min ? (v - min) / (max - min) : 0.5);

  const costs = set.map(costOf).filter(Number.isFinite);
  const lats = set.map((x) => num(x.latencyMs, NaN)).filter(Number.isFinite);
  const usages = set.map((x) => num(x.usageCount, 0));
  const prios = set.map((x) => num(x.priority, 999));

  let score = 0;
  // Success rate — 0..30
  score += num(t.successRate, 0.5) * 30;
  // Cost — cheaper is better (0..15)
  if (costs.length) {
    const c = costOf(t);
    if (Number.isFinite(c)) score += (1 - norm(c, Math.min(...costs), Math.max(...costs))) * 15;
  } else {
    score += 7.5;
  }
  // Latency — faster is better (0..10)
  if (lats.length) {
    const l = num(t.latencyMs, Math.max(...lats));
    score += (1 - norm(l, Math.min(...lats), Math.max(...lats))) * 10;
  } else {
    score += 5;
  }
  // Quota headroom (0..15)
  score += (quotaOf(t) / 100) * 15;
  // Usage spread — less used is better (0..10)
  if (usages.length) {
    const u = num(t.usageCount, 0);
    score += (1 - norm(u, Math.min(...usages), Math.max(...usages))) * 10;
  }
  // Priority — lower number better (0..10)
  if (prios.length) {
    const p = num(t.priority, 999);
    score += (1 - norm(p, Math.min(...prios), Math.max(...prios))) * 10;
  }
  // Error penalty
  score -= num(t.consecutiveErrors, 0) * 5;
  // Health
  if (t.testStatus === "active") score += 5;
  else if (t.testStatus === "unavailable") score -= 10;
  return score;
}

/**
 * Order targets by strategy.
 *
 * @param {Array<object>} targets - normalized target objects (see file header)
 * @param {string} strategy - one of SELECTION_STRATEGIES[].value (or "fallback")
 * @param {object} [ctx]
 * @param {number} [ctx.rotationIndex=0] - round-robin start index (caller-owned)
 * @param {string} [ctx.lastGoodKey] - last-known-good key for `lkgp`
 * @param {string} [ctx.lastHeadKey] - previous head for `random` dedup
 * @param {boolean} [ctx.quotaAware] - sink depleted targets for order-based strategies
 * @param {number} [ctx.nowMs] - clock override for quota reset checks
 * @param {() => number} [ctx.rng] - RNG (default Math.random; injectable for tests)
 * @returns {Array<object>} a NEW ordered array (never mutates input)
 */
export function orderTargets(targets, strategy, ctx = {}) {
  const list = Array.isArray(targets) ? [...targets] : [];
  if (list.length <= 1) return list;

  const rng = typeof ctx.rng === "function" ? ctx.rng : Math.random;
  const scoringCtx = { ...ctx, _set: list };

  const ordered = orderByStrategy(list, strategy, ctx, rng, scoringCtx);

  // Quota-aware pass (FINAL step) applies only to order-preserving strategies —
  // for these the strategy's order encodes intent (priority / sticky last-good),
  // and we merely demote exhausted targets so they are tried last. Running it
  // last also means lkgp won't stick to a depleted last-known-good account.
  if (ctx.quotaAware === true && QUOTA_AWARE_STRATEGIES.has(strategy)) {
    const nowMs = Number.isFinite(ctx.nowMs) ? ctx.nowMs : Date.now();
    return quotaAwareOrder(ordered, nowMs);
  }
  return ordered;
}

function orderByStrategy(list, strategy, ctx, rng, scoringCtx) {
  switch (strategy) {
    case "priority":
      return sortBy(list, (t) => num(t.priority, 999));

    case "weighted":
      return weightedOrder(list, (t) => num(t.weight, 1), rng);

    case "round-robin":
      return rotateBy(list, num(ctx.rotationIndex, 0));

    case "p2c":
      return p2cOrder(list, rng);

    case "least-used":
      return sortBy(list, (t) => num(t.usageCount, 0));

    case "random": {
      const out = shuffle(list, rng);
      // Dedup consecutive heads: avoid repeating the previous head when possible.
      if (ctx.lastHeadKey && out.length > 1 && out[0]?.key === ctx.lastHeadKey) {
        [out[0], out[1]] = [out[1], out[0]];
      }
      return out;
    }

    case "strict-random":
      return shuffle(list, rng);

    case "cost-optimized":
      return sortBy(list, (t) => costOf(t));

    case "headroom":
      return sortBy(list, (t) => -quotaOf(t));

    case "reset-window":
      return sortBy(list, (t) => resetOf(t));

    case "reset-aware":
      return sortBy(list, (t) => resetAwareRank(t));

    case "lkgp":
      return lkgpOrder(list, ctx.lastGoodKey);

    case "auto":
      return sortBy(list, (t) => -autoScore(t, scoringCtx));

    case "fallback":
    case "fill-first":
    default:
      // Caller-provided order (priority-sorted for connections, user order for combos).
      return list;
  }
}

// ── round-robin state ────────────────────────────────────────────────────
// State now lives in the shared routingStateStore (keyed by combo name / provider
// id), which is periodically snapshotted to the DB by routingStatePersistence.js.
// The engine stays pure — it just delegates to the pure in-memory store.

/**
 * Resolve the round-robin start index for `key`, advancing the sticky counter.
 * @param {string} key
 * @param {number} count - number of targets
 * @param {number|string} stickyLimit - calls per target before advancing
 * @returns {number} index to pass as ctx.rotationIndex
 */
export function nextRoundRobinIndex(key, count, stickyLimit = 1) {
  return routingStateStore.nextRotation(key || "__default__", count, stickyLimit);
}

/** Clear round-robin state for one key, or all when omitted. */
export function resetRotationState(key) {
  routingStateStore.resetRotation(key);
}
