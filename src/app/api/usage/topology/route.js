import { NextResponse } from "next/server";
import { getActiveRequests, getUsageHistory } from "@/lib/usageDb";
import { getCombos, getProviderNodes } from "@/lib/localDb";
import { buildTopology, TOPOLOGY_WINDOW_MS } from "@/lib/comboTopology.js";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

/**
 * Resolve a provider id to a display name (provider node name wins over registry).
 * @param {Array} nodes - providerNodes rows
 * @returns {(id: string) => string}
 */
function buildProviderNameResolver(nodes) {
  const nodeMap = {};
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.id && node?.name) nodeMap[node.id] = node.name;
  }
  return (id) => {
    if (!id) return "";
    if (nodeMap[id]) return nodeMap[id];
    const config = getProviderByAlias(id) || AI_PROVIDERS[id];
    return config?.name || id;
  };
}

/**
 * GET /api/usage/topology
 * Returns a renderable router -> combo -> provider -> model graph, including
 * nested combo chains, bounded to models used in the last hour.
 */
export async function GET() {
  try {
    const now = Date.now();
    const startDate = new Date(now - TOPOLOGY_WINDOW_MS);

    const [combos, nodes, activeState, history] = await Promise.all([
      getCombos().catch(() => []),
      getProviderNodes().catch(() => []),
      getActiveRequests().catch(() => ({ activeRequests: [] })),
      getUsageHistory({ startDate }).catch(() => []),
    ]);

    const topology = buildTopology({
      combos,
      activeRequests: activeState?.activeRequests || [],
      history: Array.isArray(history) ? history : [],
      now,
      resolveProviderName: buildProviderNameResolver(nodes),
    });

    return NextResponse.json(topology);
  } catch (error) {
    console.error("[API] Failed to build usage topology:", error);
    // Fail-open: an empty graph is renderable, a 500 is not.
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      windowMs: TOPOLOGY_WINDOW_MS,
      nodes: [],
      edges: [],
      combos: [],
      providers: [],
      models: [],
    });
  }
}
