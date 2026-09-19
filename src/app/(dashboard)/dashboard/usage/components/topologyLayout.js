"use client";

import {
  COL_X_GAP,
  ROW_Y_GAP,
  ROUTER_W,
  ROUTER_H,
  getProviderConfig,
  getProviderImageUrl,
} from "./TopologyElements";

/**
 * Legacy layout: ellipse of provider nodes around the router.
 * Used when no topology graph is available (fetch failed / loading).
 */
export function buildLegacyLayout(providers, activeSet, lastSet, errorSet) {
  const nodeW = 180;
  const nodeH = 30;
  const nodeGap = 24;

  const count = providers.length;
  if (count === 0) {
    return {
      nodes: [
        {
          id: "router",
          type: "router",
          position: { x: 0, y: 0 },
          data: { activeCount: 0 },
          draggable: false,
        },
      ],
      edges: [],
    };
  }

  // Compute rx so arc spacing between nodes >= nodeW + nodeGap
  const minRx = ((nodeW + nodeGap) * count) / (2 * Math.PI);
  const rx = Math.max(320, minRx);
  const ry = Math.max(200, rx * 0.55); // ellipse ratio ~0.55

  const nodes = [];
  const edges = [];

  nodes.push({
    id: "router",
    type: "router",
    position: { x: -ROUTER_W / 2, y: -ROUTER_H / 2 },
    data: { activeCount: activeSet.size },
    draggable: false,
  });

  const edgeStyle = (active, last, error) => {
    if (error) return { stroke: "#ef4444", strokeWidth: 2.5, opacity: 0.9 };
    if (active) return { stroke: "#22d3ee", strokeWidth: 3.5, opacity: 1 };
    if (last) return { stroke: "#f59e0b", strokeWidth: 2, opacity: 0.7 };
    return { stroke: "var(--color-border)", strokeWidth: 1, opacity: 0.3 };
  };

  providers.forEach((p, i) => {
    const config = getProviderConfig(p.provider);
    const active = activeSet.has(p.provider?.toLowerCase());
    const last = !active && lastSet.has(p.provider?.toLowerCase());
    const error = !active && errorSet.has(p.provider?.toLowerCase());
    const nodeId = `provider-${p.provider}`;
    const data = {
      label:
        (config.name !== p.provider ? config.name : null) ||
        p.nodeName ||
        p.name ||
        p.provider,
      color: config.color || "#6b7280",
      imageUrl: getProviderImageUrl(p.provider),
      textIcon:
        config.textIcon || (p.provider || "?").slice(0, 2).toUpperCase(),
      active,
    };

    // Distribute evenly starting from top (−π/2), clockwise
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    const cx = rx * Math.cos(angle);
    const cy = ry * Math.sin(angle);

    // Pick router handle closest to the node direction
    let sourceHandle, targetHandle;
    if (
      Math.abs(angle + Math.PI / 2) < Math.PI / 4 ||
      Math.abs(angle - (3 * Math.PI) / 2) < Math.PI / 4
    ) {
      sourceHandle = "top";
      targetHandle = "bottom";
    } else if (Math.abs(angle - Math.PI / 2) < Math.PI / 4) {
      sourceHandle = "bottom";
      targetHandle = "top";
    } else if (cx > 0) {
      sourceHandle = "right";
      targetHandle = "left";
    } else {
      sourceHandle = "left";
      targetHandle = "right";
    }

    nodes.push({
      id: nodeId,
      type: "provider",
      position: { x: cx - nodeW / 2, y: cy - nodeH / 2 },
      data,
      draggable: false,
    });

    edges.push({
      id: `e-${nodeId}`,
      type: "topology",
      source: "router",
      sourceHandle,
      target: nodeId,
      targetHandle,
      animated: false,
      data: { active },
      style: edgeStyle(active, last, error),
    });
  });

  return { nodes, edges };
}

/**
 * Layered layout from the /api/usage/topology graph:
 * router (col 0) -> combos by nesting depth -> providers -> models.
 * Nested combos render as consecutive combo nodes (combo -> combo -> ...).
 * Only the live active path animates; inactive branches are dimmed.
 */
export function buildLayeredLayout(graph, live) {
  const empty = {
    nodes: [
      {
        id: "router",
        type: "router",
        position: { x: -ROUTER_W / 2, y: -ROUTER_H / 2 },
        data: { activeCount: 0 },
        draggable: false,
      },
    ],
    edges: [],
  };
  try {
    const gNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const gEdges = Array.isArray(graph?.edges) ? graph.edges : [];
    if (gNodes.length === 0) return empty;

    const byId = new Map(gNodes.map((n) => [n?.id, n]));
    const combos = gNodes.filter((n) => n?.type === "combo");

    // Nesting depth per combo from combo -> combo edges (cycle-guarded).
    const depth = new Map(combos.map((c) => [c.id, 1]));
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;
      for (const e of gEdges) {
        if (e?.kind !== "combo" || e.source === e.target) continue;
        if (!depth.has(e.source) || !depth.has(e.target)) continue;
        const next = depth.get(e.source) + 1;
        if (next > depth.get(e.target)) {
          depth.set(e.target, next);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const maxComboDepth = combos.length === 0 ? 0 : Math.max(...depth.values());
    const providerCol = maxComboDepth + 1;
    const modelCol = maxComboDepth + 2;

    const colOf = (n) => {
      if (!n || n.id === "router") return 0;
      if (n.type === "combo") return depth.get(n.id) || 1;
      if (n.type === "provider") return providerCol;
      if (n.type === "model") return modelCol;
      return providerCol;
    };

    // Group node ids per column, sorted for a stable layout.
    const columns = new Map();
    for (const n of gNodes) {
      if (!n?.id) continue;
      const col = colOf(n);
      if (!columns.has(col)) columns.set(col, []);
      columns.get(col).push(n.id);
    }
    for (const ids of columns.values()) {
      ids.sort((a, b) => {
        const na = byId.get(a);
        const nb = byId.get(b);
        return String(na?.label || a).localeCompare(String(nb?.label || b));
      });
    }

    const posOf = new Map();
    for (const [col, ids] of columns) {
      ids.forEach((id, i) => {
        posOf.set(id, {
          x: col * COL_X_GAP,
          y: (i - (ids.length - 1) / 2) * ROW_Y_GAP,
        });
      });
    }

    const hasLivePath = live.models.size > 0 || live.combos.size > 0;

    const isNodeActive = (n) => {
      if (!n) return false;
      if (n.id === "router") return hasLivePath;
      if (n.type === "combo") {
        const name = n.combo || n.label;
        return live.combos.has(name);
      }
      if (n.type === "provider")
        return live.providers.has(String(n.provider || "").toLowerCase());
      if (n.type === "model") {
        const key =
          `${n.provider || ""}|${n.model || n.label || ""}`.toLowerCase();
        return live.models.has(key);
      }
      return false;
    };

    const nodes = [];
    for (const n of gNodes) {
      if (!n?.id) continue;
      const p = posOf.get(n.id) || { x: 0, y: 0 };
      const active = isNodeActive(n);
      const dimmed = hasLivePath && !active && !n.recent;
      if (n.id === "router" || n.type === "router") {
        nodes.push({
          id: "router",
          type: "router",
          position: { x: p.x - ROUTER_W / 2, y: p.y - ROUTER_H / 2 },
          data: { activeCount: live.models.size },
          draggable: false,
          style: dimmed ? { opacity: 0.45 } : undefined,
        });
        continue;
      }
      if (n.type === "combo") {
        nodes.push({
          id: n.id,
          type: "combo",
          position: { x: p.x - 70, y: p.y - 20 },
          data: { label: n.label || n.combo || n.id, active },
          draggable: false,
          style: dimmed ? { opacity: 0.45 } : undefined,
        });
        continue;
      }
      if (n.type === "provider") {
        const config = getProviderConfig(n.provider);
        nodes.push({
          id: n.id,
          type: "provider",
          position: { x: p.x - 90, y: p.y - 20 },
          data: {
            label: n.label || config.name || n.provider,
            color: config.color || "#6b7280",
            imageUrl: getProviderImageUrl(n.provider),
            textIcon:
              config.textIcon ||
              String(n.provider || "?")
                .slice(0, 2)
                .toUpperCase(),
            active,
          },
          draggable: false,
          style: dimmed ? { opacity: 0.45 } : undefined,
        });
        continue;
      }
      if (n.type === "model") {
        const config = getProviderConfig(n.provider);
        nodes.push({
          id: n.id,
          type: "model",
          position: { x: p.x - 75, y: p.y - 18 },
          data: {
            label: n.label || n.model || n.id,
            color: config.color || "#22d3ee",
            count: typeof n.count === "number" ? n.count : undefined,
            active,
          },
          draggable: false,
          style: dimmed ? { opacity: 0.45 } : undefined,
        });
        continue;
      }
    }

    const isEdgeActive = (e) => {
      if (!e || !hasLivePath) return false;
      const target = byId.get(e.target);
      if (e.kind === "combo") {
        const tName = target?.combo || target?.label;
        if (!tName || !live.combos.has(tName)) return false;
        if (e.source === "router") return true;
        const sName = byId.get(e.source)?.combo || byId.get(e.source)?.label;
        return !!sName && live.combos.has(sName);
      }
      if (e.kind === "provider") {
        const tProv = String(target?.provider || "").toLowerCase();
        if (!tProv || !live.providers.has(tProv)) return false;
        if (e.source === "router") return true;
        const sName = byId.get(e.source)?.combo || byId.get(e.source)?.label;
        return !!sName && live.combos.has(sName);
      }
      const tKey =
        `${target?.provider || ""}|${target?.model || target?.label || ""}`.toLowerCase();
      return live.models.has(tKey);
    };

    const edgeStyle = (e, active) => {
      if (active) return { stroke: "#22d3ee", strokeWidth: 3.5, opacity: 1 };
      const t = byId.get(e.target);
      const tProv = String(t?.provider || "").toLowerCase();
      if (tProv && live.last.has(tProv))
        return { stroke: "#f59e0b", strokeWidth: 2, opacity: 0.7 };
      if (tProv && live.error.has(tProv))
        return { stroke: "#ef4444", strokeWidth: 2.5, opacity: 0.9 };
      return {
        stroke: "var(--color-border)",
        strokeWidth: 1,
        opacity: hasLivePath ? 0.15 : 0.3,
      };
    };

    const edges = [];
    for (const e of gEdges) {
      if (!e?.source || !e?.target) continue;
      if (!byId.has(e.source) && e.source !== "router") continue;
      if (!byId.has(e.target)) continue;
      const active = isEdgeActive(e);
      edges.push({
        id: e.id || `e-${e.source}-${e.target}`,
        type: "topology",
        source: e.source,
        sourceHandle: "right",
        target: e.target,
        targetHandle: "left",
        animated: false,
        data: { active },
        style: edgeStyle(e, active),
      });
    }

    return { nodes, edges };
  } catch {
    return empty;
  }
}
