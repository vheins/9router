"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import { ReactFlow, Controls } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  nodeTypes,
  edgeTypes,
  FE_ACTIVE_TIMEOUT_MS,
  FE_ACTIVE_TICK_MS,
  FIT_OPTIONS,
} from "./TopologyElements";
import { buildLegacyLayout, buildLayeredLayout } from "./topologyLayout";

export default function ProviderTopology({
  providers = [],
  activeRequests = [],
  lastProvider = "",
  errorProvider = "",
  graph = null,
}) {
  // Serialize to stable string keys so useMemo only re-runs when values actually change
  const activeKey = useMemo(
    () =>
      activeRequests
        .map(
          (r) =>
            `${r.provider?.toLowerCase() || ""}|${r.model || ""}|${r.combo || ""}`,
        )
        .filter((s) => s !== "||")
        .sort()
        .join(","),
    [activeRequests],
  );
  const lastKey = lastProvider?.toLowerCase() || "";
  const errorKey = errorProvider?.toLowerCase() || "";

  const rawActive = useMemo(() => {
    const combos = new Set();
    const providersSet = new Set();
    const models = new Set();
    if (activeKey) {
      for (const part of activeKey.split(",")) {
        const [prov, model, combo] = part.split("|");
        if (prov) providersSet.add(prov);
        if (prov && model) models.add(`${prov}|${model}`.toLowerCase());
        if (combo) {
          combos.add(combo);
          // Nested chain from backend (comboChain) lights every combo node on the path
          const req = activeRequests.find((r) => r.combo === combo);
          for (const c of req?.comboChain || []) combos.add(c);
        }
      }
    }
    return { combos, providers: providersSet, models };
  }, [activeKey, activeRequests]);

  const lastSet = useMemo(() => new Set(lastKey ? [lastKey] : []), [lastKey]);
  const errorSet = useMemo(
    () => new Set(errorKey ? [errorKey] : []),
    [errorKey],
  );

  // Track active items with a frontend timeout so stuck requests eventually clear.
  const [liveActive, setLiveActive] = useState(() => ({
    combos: new Set(),
    providers: new Set(),
    models: new Set(),
  }));

  useEffect(() => {
    const seen = {};
    const sync = () => {
      const now = Date.now();
      const current = new Set([
        ...rawActive.combos,
        ...rawActive.providers,
        ...rawActive.models,
      ]);
      for (const k of current) {
        if (!seen[k]) seen[k] = now;
      }
      for (const k of Object.keys(seen)) {
        if (!current.has(k) || now - seen[k] >= FE_ACTIVE_TIMEOUT_MS) {
          delete seen[k];
        }
      }
      const isFresh = (k) => Boolean(seen[k]);
      setLiveActive({
        combos: new Set([...rawActive.combos].filter(isFresh)),
        providers: new Set([...rawActive.providers].filter(isFresh)),
        models: new Set([...rawActive.models].filter(isFresh)),
      });
    };

    sync();
    if (rawActive.models.size === 0 && rawActive.combos.size === 0) return;
    const id = setInterval(sync, FE_ACTIVE_TICK_MS);
    return () => clearInterval(id);
  }, [rawActive]);

  const live = useMemo(
    () => ({
      ...liveActive,
      last: lastSet,
      error: errorSet,
    }),
    [liveActive, lastSet, errorSet],
  );

  const legacyActiveSet = live.providers;
  const hasGraph = !!graph && Array.isArray(graph.nodes);

  const { nodes, edges } = useMemo(() => {
    if (hasGraph) return buildLayeredLayout(graph, live);
    return buildLegacyLayout(providers, legacyActiveSet, lastSet, errorSet);
  }, [hasGraph, graph, live, providers, legacyActiveSet, lastSet, errorSet]);

  // Stable key — remount only when the node id set changes, not on counts
  const layoutKey = useMemo(
    () =>
      nodes
        .map((n) => n.id)
        .sort()
        .join(","),
    [nodes],
  );

  const rfInstance = useRef(null);
  const containerRef = useRef(null);
  const onInit = useCallback((instance) => {
    rfInstance.current = instance;
    setTimeout(() => instance.fitView(FIT_OPTIONS), 50);
  }, []);

  // Re-fit on container resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (rfInstance.current) rfInstance.current.fitView(FIT_OPTIONS);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-fit when node count/layout changes
  useEffect(() => {
    if (rfInstance.current) {
      const id = setTimeout(() => rfInstance.current.fitView(FIT_OPTIONS), 50);
      return () => clearTimeout(id);
    }
  }, [nodes.length]);

  const isEmpty = hasGraph
    ? nodes.filter((n) => n.id !== "router").length === 0
    : providers.length === 0;

  return (
    <div
      ref={containerRef}
      className="h-[320px] w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 sm:h-[480px]"
    >
      {isEmpty ? (
        <div className="h-full flex items-center justify-center text-text-muted text-sm">
          {hasGraph ? "No usage in the last hour" : "No providers connected"}
        </div>
      ) : (
        <ReactFlow
          key={layoutKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={FIT_OPTIONS}
          minZoom={0.1}
          maxZoom={2}
          onInit={onInit}
          proOptions={{ hideAttribution: true }}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick
          preventScrolling={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Controls
            showInteractive={false}
            className="react-flow-controls-custom"
          />
        </ReactFlow>
      )}
    </div>
  );
}

ProviderTopology.propTypes = {
  providers: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      provider: PropTypes.string,
      name: PropTypes.string,
    }),
  ),
  activeRequests: PropTypes.arrayOf(
    PropTypes.shape({
      provider: PropTypes.string,
      model: PropTypes.string,
      account: PropTypes.string,
      combo: PropTypes.string,
      comboChain: PropTypes.arrayOf(PropTypes.string),
    }),
  ),
  lastProvider: PropTypes.string,
  errorProvider: PropTypes.string,
  graph: PropTypes.shape({
    nodes: PropTypes.array,
    edges: PropTypes.array,
  }),
};
