/**
 * Combo topology helpers.
 *
 * Resolves a combo name into its ordered chain of combo names plus the terminal
 * provider/model pairs, following nested combo references (combo -> combo -> model).
 * Pure and fail-open: malformed combos, cycles and over-deep nesting degrade to a
 * shorter chain instead of throwing.
 *
 * Consumers:
 *  - src/lib/db/repos/usageRepo.js — attributes in-flight requests to a combo.
 *  - src/app/api/usage/topology/route.js — builds the renderable nodes/edges graph.
 */

import { getComboModelsFromData } from "open-sse/services/combo.js";

// Bounds nested-combo traversal; a cycle or runaway chain stops here.
export const MAX_COMBO_DEPTH = 10;
// Model nodes are bounded to this window (locked decision: last 1 hour).
export const TOPOLOGY_WINDOW_MS = 60 * 60 * 1000;
export const ROUTER_NODE_ID = "router";

const COMBOS_CACHE_TTL_MS = 5000;

/**
 * Split a "provider/model" member string.
 * @param {string} modelStr
 * @returns {{provider: string|null, model: string}}
 */
export function splitModelRef(modelStr) {
  if (typeof modelStr !== "string") return { provider: null, model: "" };
  const slash = modelStr.indexOf("/");
  if (slash <= 0) return { provider: null, model: modelStr };
  return { provider: modelStr.slice(0, slash), model: modelStr.slice(slash + 1) };
}

/**
 * Resolve a combo into its chain and terminal models.
 * @param {string} comboName - Root combo name (bare, no "/").
 * @param {Array|Object} combosData - Combos array or { combos } wrapper.
 * @param {{maxDepth?: number}} [options]
 * @returns {{combo: string, chain: string[], terminals: Array<{provider: string|null, model: string, modelKey: string}>, links: Array<{source: string, target: string, kind: string, provider?: string|null, model?: string}>}}
 */
export function resolveCombo(comboName, combosData, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : MAX_COMBO_DEPTH;
  const chain = [];
  const terminals = [];
  const links = [];
  const seenTerminals = new Set();
  const seenLinks = new Set();
  const visited = new Set();

  const addLink = (link) => {
    const key = `${link.source}->${link.target}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);
    links.push(link);
  };

  const addTerminal = (provider, model) => {
    const modelKey = provider ? `${provider}/${model}` : model;
    if (seenTerminals.has(modelKey)) return;
    seenTerminals.add(modelKey);
    terminals.push({ provider, model, modelKey });
  };

  const walk = (name, depth, parent) => {
    if (!name || depth > maxDepth) return;
    const members = getComboModelsFromData(name, combosData);
    if (!Array.isArray(members) || members.length === 0) return;
    const alreadyVisited = visited.has(name);
    if (!alreadyVisited) {
      visited.add(name);
      chain.push(name);
    }
    // Record the parent link even when the child was already expanded (shared
    // nested combo / diamond), but never re-walk its subtree (cycle guard).
    if (parent) addLink({ source: parent, target: name, kind: "combo" });
    if (alreadyVisited) return;

    for (const member of members) {
      if (typeof member !== "string" || member.length === 0) continue;
      if (member.includes("/")) {
        const { provider, model } = splitModelRef(member);
        addTerminal(provider, model);
        addLink({ source: name, target: member, kind: "model", provider, model });
        continue;
      }
      if (getComboModelsFromData(member, combosData)) {
        walk(member, depth + 1, name);
      } else {
        // Bare name that is not a known combo — keep it visible as a provider-less terminal.
        addTerminal(null, member);
        addLink({ source: name, target: member, kind: "model", provider: null, model: member });
      }
    }
  };

  walk(comboName, 0, null);
  return { combo: comboName, chain, terminals, links };
}

let combosCache = { data: null, ts: 0 };

async function loadCombosCached() {
  const now = Date.now();
  if (combosCache.data && now - combosCache.ts < COMBOS_CACHE_TTL_MS) return combosCache.data;
  try {
    const { getCombos } = await import("./db/repos/combosRepo.js");
    const combos = await getCombos();
    combosCache.data = Array.isArray(combos) ? combos : [];
    combosCache.ts = now;
  } catch {
    if (!combosCache.data) combosCache.data = [];
  }
  return combosCache.data;
}

/**
 * Resolve every known combo into a name -> resolution map (cached, fail-open).
 * @returns {Promise<Map<string, ReturnType<typeof resolveCombo>>>}
 */
export async function getComboChainMap() {
  const combos = await loadCombosCached();
  const map = new Map();
  for (const combo of combos) {
    if (!combo?.name) continue;
    try {
      map.set(combo.name, resolveCombo(combo.name, combos));
    } catch {
      // Malformed combo must never break request tracking.
    }
  }
  return map;
}

/**
 * Build a renderable router -> combo -> provider -> model graph.
 *
 * - Combos are "in use" when active now, or when one of their terminal models
 *   was used inside the 1h window (or is in flight now).
 * - Model nodes come only from the 1h history plus models with an in-flight
 *   request (so the live path can animate before its usage row lands).
 * - Never throws; returns an empty graph for malformed input.
 *
 * @param {object} input
 * @param {Array} input.combos - Combos rows.
 * @param {Array} input.activeRequests - Entries from getActiveRequests().
 * @param {Array} input.history - Rows from getUsageHistory({ startDate }).
 * @param {number} [input.now]
 * @param {(id: string) => string} [input.resolveProviderName]
 * @returns {{generatedAt: string, windowMs: number, nodes: Array, edges: Array, combos: Array, providers: Array, models: Array}}
 */
export function buildTopology({ combos = [], activeRequests = [], history = [], now = Date.now(), resolveProviderName } = {}) {
  const combosData = Array.isArray(combos) ? combos : [];
  const providerName = typeof resolveProviderName === "function" ? resolveProviderName : (id) => id;

  const nodes = new Map();
  const edges = new Map();
  const activeCombos = new Set();
  const activeByComboProvider = new Set();
  const activeByProvider = new Set();
  const activeByModel = new Set();
  let activeCount = 0;

  for (const req of Array.isArray(activeRequests) ? activeRequests : []) {
    const provider = req?.provider || "";
    const model = req?.model || "";
    const combo = req?.combo || null;
    if (combo) activeCombos.add(combo);
    if (provider) activeByProvider.add(provider);
    if (provider && model) {
      activeByModel.add(`${provider}|${model}`);
      activeCount += req?.count || 1;
      if (combo) activeByComboProvider.add(`${combo}|${provider}`);
    }
  }

  const addNode = (node) => {
    const existing = nodes.get(node.id);
    if (!existing) {
      nodes.set(node.id, node);
      return node;
    }
    if (node.active) existing.active = true;
    if (node.recent) existing.recent = true;
    if (node.count != null) existing.count = node.count;
    if (node.lastUsed) existing.lastUsed = node.lastUsed;
    if (node.label && !existing.label) existing.label = node.label;
    return existing;
  };

  const addEdge = (edge) => {
    const existing = edges.get(edge.id);
    if (!existing) {
      edges.set(edge.id, edge);
      return edge;
    }
    if (edge.active) existing.active = true;
    return existing;
  };

  addNode({ id: ROUTER_NODE_ID, type: "router", label: "9Router", active: activeCount > 0 });

  // Resolve every known combo once; malformed entries are skipped.
  const resolved = new Map();
  for (const combo of combosData) {
    if (!combo?.name) continue;
    try {
      resolved.set(combo.name, resolveCombo(combo.name, combosData));
    } catch {
      // fail-open
    }
  }

  // Aggregate the 1h window per provider/model. The window is enforced here as
  // well as by the caller's query so a stale/absent startDate filter can never
  // widen the bounded graph.
  const windowStart = now - TOPOLOGY_WINDOW_MS;
  const recentModels = new Map();
  for (const row of Array.isArray(history) ? history : []) {
    if (!row?.model) continue;
    if (row.timestamp) {
      const ts = new Date(row.timestamp).getTime();
      if (Number.isFinite(ts) && ts < windowStart) continue;
    }
    const provider = row.provider || "";
    const key = `${provider}|${row.model}`;
    const entry = recentModels.get(key) || { provider, model: row.model, count: 0, lastUsed: null };
    entry.count += 1;
    if (row.timestamp && (!entry.lastUsed || new Date(row.timestamp) > new Date(entry.lastUsed))) entry.lastUsed = row.timestamp;
    recentModels.set(key, entry);
  }

  const hasRecentTerminal = (res) =>
    !!res && res.terminals.some((t) => t.provider && recentModels.has(`${t.provider}|${t.model}`));

  const hasActiveTerminal = (res) =>
    !!res && res.terminals.some((t) => t.provider && activeByModel.has(`${t.provider}|${t.model}`));

  // A combo is "in use" when active now, when a terminal model was used inside the
  // window, or when a terminal model has an in-flight request. The active case must
  // count, otherwise an in-flight request routed through a nested combo would emit
  // an edge from a combo node that never made it into the graph.
  const isComboUsed = (name) => {
    if (!name) return false;
    const res = resolved.get(name);
    return activeCombos.has(name) || hasRecentTerminal(res) || hasActiveTerminal(res);
  };

  // Combos in use = active now, or a terminal model seen in the last hour.
  const usedCombos = new Set(activeCombos);
  for (const [name, res] of resolved) {
    if (hasRecentTerminal(res) || hasActiveTerminal(res)) usedCombos.add(name);
  }

  // Nested combos hang off their parent; only roots attach to the router.
  const nestedCombos = new Set();
  for (const name of usedCombos) {
    const res = resolved.get(name);
    if (!res) continue;
    for (const link of res.links) {
      if (link.kind === "combo") nestedCombos.add(link.target);
    }
  }

  const attributedModels = new Set();

  const addProviderNode = (provider, { active = false, recent = false } = {}) =>
    addNode({
      id: `provider:${provider}`,
      type: "provider",
      label: providerName(provider) || provider,
      provider,
      active,
      recent,
    });

  const addModelNode = (provider, model, { active = false, recent = false, count = 0, lastUsed = null } = {}) =>
    addNode({
      id: `model:${provider || ""}|${model}`,
      type: "model",
      label: model,
      provider,
      model,
      active,
      recent,
      count,
      lastUsed,
    });

  for (const rootName of usedCombos) {
    const res = resolved.get(rootName);
    if (!res) continue;
    const rootActive = activeCombos.has(rootName);
    const rootRecent = hasRecentTerminal(res);

    addNode({ id: `combo:${rootName}`, type: "combo", label: rootName, combo: rootName, active: rootActive, recent: rootRecent });
    if (!nestedCombos.has(rootName)) {
      addEdge({
        id: `edge:${ROUTER_NODE_ID}->combo:${rootName}`,
        source: ROUTER_NODE_ID,
        target: `combo:${rootName}`,
        kind: "combo",
        active: rootActive,
      });
    }

    for (const name of res.chain) {
      if (!isComboUsed(name)) continue;
      addNode({
        id: `combo:${name}`,
        type: "combo",
        label: name,
        combo: name,
        active: activeCombos.has(name),
        recent: hasRecentTerminal(resolved.get(name)),
      });
    }

    for (const link of res.links) {
      if (link.kind === "combo") {
        // Only surface nested combos that are themselves in use; a stale branch
        // would otherwise dangle with no model children.
        if (!isComboUsed(link.target)) continue;
        addEdge({
          id: `edge:combo:${link.source}->combo:${link.target}`,
          source: `combo:${link.source}`,
          target: `combo:${link.target}`,
          kind: "combo",
          active: activeCombos.has(link.target) || rootActive,
        });
        continue;
      }

      const { provider, model } = link;
      const recent = provider ? recentModels.get(`${provider}|${model}`) : null;
      const active = provider ? activeByModel.has(`${provider}|${model}`) : false;
      // Bounded graph: only models used in the last hour (or in flight now) are nodes.
      if (!recent && !active) continue;

      if (!provider) {
        addModelNode(null, model, { active, recent: !!recent, count: recent?.count || 0, lastUsed: recent?.lastUsed || null });
        addEdge({
          id: `edge:combo:${link.source}->model:|${model}`,
          source: `combo:${link.source}`,
          target: `model:|${model}`,
          kind: "model",
          active,
        });
        attributedModels.add(`|${model}`);
        continue;
      }

      addProviderNode(provider, { active: activeByProvider.has(provider), recent: !!recent });
      addModelNode(provider, model, { active, recent: !!recent, count: recent?.count || 0, lastUsed: recent?.lastUsed || null });
      addEdge({
        id: `edge:combo:${link.source}->provider:${provider}`,
        source: `combo:${link.source}`,
        target: `provider:${provider}`,
        kind: "provider",
        active: active || activeByComboProvider.has(`${rootName}|${provider}`),
      });
      addEdge({
        id: `edge:provider:${provider}->model:${provider}|${model}`,
        source: `provider:${provider}`,
        target: `model:${provider}|${model}`,
        kind: "model",
        active,
      });
      attributedModels.add(`${provider}|${model}`);
    }
  }

  // Recent/active models that no combo owns attach directly under the router.
  const modelKeys = new Set([...recentModels.keys(), ...activeByModel]);
  for (const key of modelKeys) {
    if (attributedModels.has(key)) continue;
    const sep = key.indexOf("|");
    const provider = key.slice(0, sep);
    const model = key.slice(sep + 1);
    if (!provider || !model) continue;
    const recent = recentModels.get(key);
    const active = activeByModel.has(key);
    addProviderNode(provider, { active: activeByProvider.has(provider), recent: !!recent });
    addModelNode(provider, model, { active, recent: !!recent, count: recent?.count || 0, lastUsed: recent?.lastUsed || null });
    addEdge({
      id: `edge:${ROUTER_NODE_ID}->provider:${provider}`,
      source: ROUTER_NODE_ID,
      target: `provider:${provider}`,
      kind: "provider",
      active: activeByProvider.has(provider),
    });
    addEdge({
      id: `edge:provider:${provider}->model:${provider}|${model}`,
      source: `provider:${provider}`,
      target: `model:${provider}|${model}`,
      kind: "model",
      active,
    });
  }

  const combosOut = [];
  for (const name of usedCombos) {
    const res = resolved.get(name);
    combosOut.push({
      name,
      active: activeCombos.has(name),
      chain: res?.chain || [name],
      terminals: (res?.terminals || []).map((t) => ({ provider: t.provider, model: t.model })),
    });
  }

  const providersOut = [...nodes.values()]
    .filter((n) => n.type === "provider")
    .map((n) => ({ id: n.provider, label: n.label, active: !!n.active, recent: !!n.recent }));

  const modelsOut = [...recentModels.values()]
    .map((m) => ({
      provider: m.provider,
      model: m.model,
      count: m.count,
      lastUsed: m.lastUsed,
      active: activeByModel.has(`${m.provider}|${m.model}`),
    }))
    .sort((a, b) => b.count - a.count || String(a.model).localeCompare(String(b.model)));

  return {
    generatedAt: new Date(now).toISOString(),
    windowMs: TOPOLOGY_WINDOW_MS,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    combos: combosOut,
    providers: providersOut,
    models: modelsOut,
  };
}
