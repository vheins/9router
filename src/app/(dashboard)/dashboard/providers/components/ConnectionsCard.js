"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getStatusVariant as getConnectionStatusVariant } from "@/shared/utils/connectionStatus";
import PropTypes from "prop-types";
import { Card, Badge, Button, Modal, Select, Toggle, EditConnectionModal, ConfirmModal } from "@/shared/components";
import { SELECTION_STRATEGIES } from "open-sse/services/routingStrategies.js";

// Provider-connection selection strategies (shared engine). "fill-first" is the default.
const PROVIDER_STRATEGY_OPTIONS = SELECTION_STRATEGIES.map((s) => ({
  value: s.value,
  label: `${s.label} — ${s.desc}`,
}));

// ── CooldownTimer ──────────────────────────────────────────────
function CooldownTimer({ until }) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    const update = () => {
      const diff = new Date(until).getTime() - Date.now();
      if (diff <= 0) { setRemaining(""); return; }
      const s = Math.floor(diff / 1000);
      if (s < 60) setRemaining(`${s}s`);
      else if (s < 3600) setRemaining(`${Math.floor(s / 60)}m ${s % 60}s`);
      else setRemaining(`${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, [until]);

  if (!remaining) return null;
  return <span className="text-xs text-orange-500 font-mono">⏱ {remaining}</span>;
}

CooldownTimer.propTypes = { until: PropTypes.string.isRequired };

// ── ConnectionRow ──────────────────────────────────────────────
function ConnectionRow({ connection, proxyPools, isOAuth, isFirst, isLast, onMoveUp, onMoveDown, onToggleActive, onToggleBanned, onUpdateProxy, onEdit, onDelete }) {
  const [showProxyDropdown, setShowProxyDropdown] = useState(false);
  const [updatingProxy, setUpdatingProxy] = useState(false);
  const [isCooldown, setIsCooldown] = useState(false);
  const proxyDropdownRef = useRef(null);

  const proxyPoolMap = new Map((proxyPools || []).map((p) => [p.id, p]));
  const boundProxyPoolId = connection.providerSpecificData?.proxyPoolId || null;
  const boundProxyPool = boundProxyPoolId ? proxyPoolMap.get(boundProxyPoolId) : null;
  const hasLegacyProxy = connection.providerSpecificData?.connectionProxyEnabled === true && !!connection.providerSpecificData?.connectionProxyUrl;
  const hasAnyProxy = !!boundProxyPoolId || hasLegacyProxy;

  const proxyDisplayText = boundProxyPool
    ? `Pool: ${boundProxyPool.name}`
    : boundProxyPoolId ? `Pool: ${boundProxyPoolId} (inactive/missing)`
    : hasLegacyProxy ? `Legacy: ${connection.providerSpecificData?.connectionProxyUrl}` : "";

  let maskedProxyUrl = "";
  const rawProxyUrl = boundProxyPool?.proxyUrl || connection.providerSpecificData?.connectionProxyUrl;
  if (rawProxyUrl) {
    try {
      const p = new URL(rawProxyUrl);
      maskedProxyUrl = `${p.protocol}//${p.hostname}${p.port ? `:${p.port}` : ""}`;
    } catch { maskedProxyUrl = rawProxyUrl; }
  }

  const noProxyText = boundProxyPool?.noProxy || connection.providerSpecificData?.connectionNoProxy || "";
  const proxyBadgeVariant = boundProxyPool?.isActive === true ? "success" : (boundProxyPoolId || hasLegacyProxy) ? "error" : "default";

  const modelLockUntil = Object.entries(connection)
    .filter(([k]) => k.startsWith("modelLock_"))
    .map(([, v]) => v).filter(Boolean).sort()[0] || null;

  useEffect(() => {
    const check = () => {
      const until = Object.entries(connection)
        .filter(([k]) => k.startsWith("modelLock_"))
        .map(([, v]) => v).filter(v => v && new Date(v).getTime() > Date.now()).sort()[0] || null;
      setIsCooldown(!!until);
    };
    check();
    const t = modelLockUntil ? setInterval(check, 1000) : null;
    return () => { if (t) clearInterval(t); };
  }, [modelLockUntil]);

  useEffect(() => {
    if (!showProxyDropdown) return;
    const handler = (e) => {
      if (proxyDropdownRef.current && !proxyDropdownRef.current.contains(e.target))
        setShowProxyDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showProxyDropdown]);

  const effectiveStatus = connection.testStatus === "unavailable" && !isCooldown ? "active" : connection.testStatus;

  const getStatusVariant = () => getConnectionStatusVariant(connection.isActive, effectiveStatus, connection.banned);

  const isBanned = connection.banned === true;
  const [banPending, setBanPending] = useState(false);
  const banTooltipText = [
    connection.banReason || null,
    connection.banRetryAt ? `Retry after ${connection.banRetryAt}` : (!connection.banRetryAt && isBanned ? "Skipped by routing until manually unbanned" : null),
  ].filter(Boolean).join(" — ") || null;

  const handleToggleBanned = async () => {
    if (!onToggleBanned || banPending) return;
    setBanPending(true);
    try { await onToggleBanned(!isBanned); }
    finally { setBanPending(false); }
  };

  const displayName = isOAuth
    ? connection.name || connection.email || connection.displayName || "OAuth Account"
    : connection.name;

  const handleSelectProxy = async (poolId) => {
    setUpdatingProxy(true);
    try { await onUpdateProxy(poolId === "__none__" ? null : poolId); }
    finally { setUpdatingProxy(false); setShowProxyDropdown(false); }
  };

  return (
    <div className={`group flex flex-col gap-3 p-2 rounded-lg sm:flex-row sm:items-center sm:justify-between hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors ${connection.isActive === false ? "opacity-60" : ""}`}>
      <div className="flex w-full min-w-0 flex-1 items-start gap-3 sm:items-center">
        <div className="flex flex-col">
          <button onClick={onMoveUp} disabled={isFirst} className={`p-0.5 rounded ${isFirst ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}>
            <span className="material-symbols-outlined text-sm">keyboard_arrow_up</span>
          </button>
          <button onClick={onMoveDown} disabled={isLast} className={`p-0.5 rounded ${isLast ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}>
            <span className="material-symbols-outlined text-sm">keyboard_arrow_down</span>
          </button>
        </div>
        <span className="material-symbols-outlined text-base text-text-muted">{isOAuth ? "lock" : "key"}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{displayName}</p>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <Badge variant={getStatusVariant()} size="sm" dot>
              {connection.isActive === false ? "disabled" : (effectiveStatus || "Unknown")}
            </Badge>
            {isBanned && (
              <span title={banTooltipText || "Banned"}>
                <Badge variant="warning" size="sm">banned</Badge>
              </span>
            )}
            {hasAnyProxy && <Badge variant={proxyBadgeVariant} size="sm">Proxy</Badge>}
            {isCooldown && connection.isActive !== false && <CooldownTimer until={modelLockUntil} />}
            {connection.lastError && connection.isActive !== false && !isBanned && (
              <span className="text-xs text-red-500 truncate max-w-[300px]" title={connection.lastError}>{connection.lastError}</span>
            )}
            {isBanned && (connection.banReason || connection.banRetryAt) && (
              <span className="text-xs text-yellow-600 dark:text-yellow-400 truncate max-w-[300px]" title={banTooltipText}>
                {connection.banReason || `Retry after ${connection.banRetryAt}`}
              </span>
            )}
            <span className="text-xs text-text-muted">#{connection.priority}</span>
          </div>
          {hasAnyProxy && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-text-muted truncate max-w-[420px]" title={proxyDisplayText}>{proxyDisplayText}</span>
              {maskedProxyUrl && <code className="text-[10px] font-mono bg-black/5 dark:bg-white/5 px-1 py-0.5 rounded text-text-muted">{maskedProxyUrl}</code>}
              {noProxyText && <span className="text-[11px] text-text-muted truncate max-w-[320px]" title={noProxyText}>no_proxy: {noProxyText}</span>}
            </div>
          )}
        </div>
      </div>
      <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
        <div className="flex flex-wrap gap-1">
          {(proxyPools || []).length > 0 && (
            <div className="relative" ref={proxyDropdownRef}>
              <button
                onClick={() => setShowProxyDropdown((v) => !v)}
                className={`flex flex-col items-center px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors ${hasAnyProxy ? "text-primary" : "text-text-muted hover:text-primary"}`}
                disabled={updatingProxy}
              >
                <span className="material-symbols-outlined text-[18px]">{updatingProxy ? "progress_activity" : "lan"}</span>
                <span className="text-[10px] leading-tight">Proxy</span>
              </button>
              {showProxyDropdown && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-bg border border-border rounded-lg shadow-lg py-1 min-w-[160px]">
                  <button onClick={() => handleSelectProxy("__none__")} className={`w-full text-left px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${!boundProxyPoolId ? "text-primary font-medium" : "text-text-main"}`}>None</button>
                  {(proxyPools || []).map((pool) => (
                    <button key={pool.id} onClick={() => handleSelectProxy(pool.id)} className={`w-full text-left px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${boundProxyPoolId === pool.id ? "text-primary font-medium" : "text-text-main"}`}>{pool.name}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button onClick={onEdit} className="flex flex-col items-center px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary">
            <span className="material-symbols-outlined text-[18px]">edit</span>
            <span className="text-[10px] leading-tight">Edit</span>
          </button>
          {onToggleBanned && (
            <button
              onClick={handleToggleBanned}
              disabled={banPending}
              title={isBanned ? (banTooltipText || "Unban this account") : "Ban this account (excluded from routing)"}
              className={`flex flex-col items-center px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 ${isBanned ? "text-yellow-600 dark:text-yellow-400" : "text-text-muted hover:text-primary"} ${banPending ? "opacity-50 cursor-wait" : ""}`}
            >
              <span className="material-symbols-outlined text-[18px]">{banPending ? "progress_activity" : isBanned ? "lock_open" : "block"}</span>
              <span className="text-[10px] leading-tight">{isBanned ? "Unban" : "Ban"}</span>
            </button>
          )}
          <button onClick={onDelete} className="flex flex-col items-center px-2 py-1 rounded hover:bg-red-500/10 text-red-500">
            <span className="material-symbols-outlined text-[18px]">delete</span>
            <span className="text-[10px] leading-tight">Delete</span>
          </button>
        </div>
        <Toggle size="sm" checked={connection.isActive ?? true} onChange={onToggleActive} title={isBanned ? "Banned: skipped by routing even while enabled" : (connection.isActive ?? true) ? "Disable" : "Enable"} />
      </div>
    </div>
  );
}

ConnectionRow.propTypes = {
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    displayName: PropTypes.string,
    testStatus: PropTypes.string,
    isActive: PropTypes.bool,
    banned: PropTypes.bool,
    banReason: PropTypes.string,
    banRetryAt: PropTypes.string,
    lastError: PropTypes.string,
    priority: PropTypes.number,
  }).isRequired,
  proxyPools: PropTypes.array,
  isOAuth: PropTypes.bool.isRequired,
  isFirst: PropTypes.bool.isRequired,
  isLast: PropTypes.bool.isRequired,
  onMoveUp: PropTypes.func.isRequired,
  onMoveDown: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  onToggleBanned: PropTypes.func,
  onUpdateProxy: PropTypes.func,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
};

// ── AddApiKeyModal ─────────────────────────────────────────────
function AddApiKeyModal({ isOpen, provider, providerName, proxyPools, onSave, onClose }) {
  const NONE = "__none__";
  const [formData, setFormData] = useState({ name: "", apiKey: "", priority: 1, weight: 1, proxyPoolId: NONE });
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: formData.apiKey }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch { setValidationResult("failed"); }
    finally { setValidating(false); }
  };

  const handleSubmit = async () => {
    if (!provider || !formData.apiKey) return;
    setSaving(true);
    try {
      let isValid = false;
      try {
        setValidating(true); setValidationResult(null);
        const res = await fetch("/api/providers/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, apiKey: formData.apiKey }),
        });
        const data = await res.json();
        isValid = !!data.valid;
        setValidationResult(isValid ? "success" : "failed");
      } catch { setValidationResult("failed"); }
      finally { setValidating(false); }
      await onSave({
        name: formData.name,
        apiKey: formData.apiKey,
        priority: formData.priority,
        weight: formData.weight,
        proxyPoolId: formData.proxyPoolId === NONE ? null : formData.proxyPoolId,
        testStatus: isValid ? "active" : "unknown",
      });
    } finally { setSaving(false); }
  };

  if (!provider) return null;

  return (
    <Modal isOpen={isOpen} title={`Add ${providerName || provider} API Key`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-xs text-text-muted mb-1 block">Name</label>
          <input className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Production Key" />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs text-text-muted mb-1 block">API Key</label>
            <input type="password" className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary" value={formData.apiKey} onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })} />
          </div>
          <div className="pt-6">
            <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
              {validating ? "Checking..." : "Check"}
            </Button>
          </div>
        </div>
        {validationResult && (
          <Badge variant={validationResult === "success" ? "success" : "error"}>
            {validationResult === "success" ? "Valid" : "Invalid"}
          </Badge>
        )}
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs text-text-muted mb-1 block">Priority</label>
            <input type="number" className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary" value={formData.priority} onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value) || 1 })} />
          </div>
          <div className="flex-1">
            <label className="text-xs text-text-muted mb-1 block">Weight</label>
            <input type="number" min={0} className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary" value={formData.weight} onChange={(e) => setFormData({ ...formData, weight: Number.parseFloat(e.target.value) || 0 })} />
          </div>
        </div>
        <Select label="Proxy Pool" value={formData.proxyPoolId} onChange={(e) => setFormData({ ...formData, proxyPoolId: e.target.value })}
          options={[{ value: NONE, label: "None" }, ...(proxyPools || []).map((p) => ({ value: p.id, label: p.name }))]} />
        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={!formData.name || !formData.apiKey || saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

AddApiKeyModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string,
  providerName: PropTypes.string,
  proxyPools: PropTypes.array,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

// ── ConnectionsCard ────────────────────────────────────────────
// Self-contained card: fetches, displays and manages all connections for a provider.
export default function ConnectionsCard({ providerId, isOAuth }) {
  const [connections, setConnections] = useState([]);
  const [proxyPools, setProxyPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [providerStrategy, setProviderStrategy] = useState(null);
  const [providerStickyLimit, setProviderStickyLimit] = useState("1");
  const [providerQuotaAware, setProviderQuotaAware] = useState(false);
  const [confirmState, setConfirmState] = useState(null);

  const fetch_ = useCallback(async () => {
    try {
      const [connRes, proxyRes, settingsRes] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);
      const connData = await connRes.json();
      const proxyData = await proxyRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      if (connRes.ok) setConnections((connData.connections || []).filter((c) => c.provider === providerId));
      if (proxyRes.ok) setProxyPools(proxyData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProviderStrategy(override.fallbackStrategy || null);
      setProviderStickyLimit(override.stickyRoundRobinLimit != null ? String(override.stickyRoundRobinLimit) : "1");
      setProviderQuotaAware(override.quotaAware === true);
    } catch (e) { console.log("ConnectionsCard fetch error:", e); }
    finally { setLoading(false); }
  }, [providerId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  const saveStrategy = async (strategy, stickyLimit) => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = {};
      if (strategy && strategy !== "fill-first") override.fallbackStrategy = strategy;
      if (strategy === "round-robin" && stickyLimit !== "") override.stickyRoundRobinLimit = Number(stickyLimit) || 3;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerStrategies: updated }) });
    } catch (e) { console.log("saveStrategy error:", e); }
  };

  // Partial merge: preserve other override keys (e.g. quotaAware) when the
  // caller only changes one field.
  const patchProviderOverride = async (patch) => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const next = { ...(current[providerId] || {}), ...patch };
      for (const k of Object.keys(next)) {
        if (next[k] === null || next[k] === undefined || next[k] === "") delete next[k];
      }
      const updated = { ...current };
      if (Object.keys(next).length === 0) delete updated[providerId];
      else updated[providerId] = next;
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerStrategies: updated }) });
    } catch (e) { console.log("patchProviderOverride error:", e); }
  };

  const handleSwapPriority = async (i1, i2) => {
    const next = [...connections];
    [next[i1], next[i2]] = [next[i2], next[i1]];
    setConnections(next);
    try {
      await Promise.all([
        fetch(`/api/providers/${next[i1].id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priority: i1 }) }),
        fetch(`/api/providers/${next[i2].id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priority: i2 }) }),
      ]);
    } catch { await fetch_(); }
  };

  const handleDelete = async (id) => {
    setConfirmState({
      title: "Delete Connection",
      message: "Delete this connection?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
          if (res.ok) setConnections((prev) => prev.filter((c) => c.id !== id));
        } catch (e) { console.log("delete error:", e); }
      }
    });
  };

  const handleToggleActive = async (id, isActive) => {
    try {
      const res = await fetch(`/api/providers/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }) });
      if (res.ok) setConnections((prev) => prev.map((c) => c.id === id ? { ...c, isActive } : c));
    } catch (e) { console.log("toggle error:", e); }
  };

  const handleToggleBanned = async (id, banned) => {
    try {
      const res = await fetch(`/api/providers/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ banned }) });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const updated = data?.connection || null;
        setConnections((prev) => prev.map((c) => c.id === id
          ? (updated ? { ...c, ...updated } : { ...c, banned, bannedAt: banned ? c.bannedAt || new Date().toISOString() : null, banReason: banned ? (c.banReason || "Manually banned") : null, banRetryAt: null })
          : c));
      }
    } catch (e) { console.log("ban toggle error:", e); }
  };

  const handleUpdateProxy = async (connId, proxyPoolId) => {
    try {
      const res = await fetch(`/api/providers/${connId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proxyPoolId: proxyPoolId || null }) });
      if (res.ok) setConnections((prev) => prev.map((c) => c.id === connId ? { ...c, providerSpecificData: { ...c.providerSpecificData, proxyPoolId: proxyPoolId || null } } : c));
    } catch (e) { console.log("proxy error:", e); }
  };

  const handleSaveApiKey = async (formData) => {
    try {
      const res = await fetch("/api/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: providerId, ...formData }) });
      if (res.ok) { await fetch_(); setShowAddModal(false); }
    } catch (e) { console.log("save apikey error:", e); }
  };

  const handleUpdateConnection = async (formData) => {
    try {
      const res = await fetch(`/api/providers/${selectedConnection.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(formData) });
      if (res.ok) { await fetch_(); setShowEditModal(false); }
    } catch (e) { console.log("update connection error:", e); }
  };

  if (loading) return <Card><div className="h-20 animate-pulse bg-black/5 rounded-lg" /></Card>;

  return (
    <>
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <h2 className="text-lg font-semibold">Connections</h2>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-muted font-medium">Strategy</span>
            <div className="w-full sm:w-[220px]">
              <Select
                options={PROVIDER_STRATEGY_OPTIONS}
                value={providerStrategy || "fill-first"}
                onChange={(e) => {
                  const strategy = e.target.value;
                  setProviderStrategy(strategy === "fill-first" ? null : strategy);
                  if (strategy === "round-robin" && !providerStickyLimit) setProviderStickyLimit("1");
                  saveStrategy(strategy, providerStickyLimit || "1");
                }}
                selectClassName="py-1.5 text-xs"
              />
            </div>
            {providerStrategy === "round-robin" && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-text-muted">Sticky:</span>
                <input
                  type="number" min={1} value={providerStickyLimit}
                  onChange={(e) => { setProviderStickyLimit(e.target.value); saveStrategy("round-robin", e.target.value); }}
                  className="w-16 px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:border-primary"
                />
              </div>
            )}
            <label className="flex items-center gap-1.5" title="Deprioritize accounts whose Quota Tracker snapshot shows depleted quota">
              <span className="text-xs text-text-muted font-medium">Quota-aware</span>
              <Toggle
                size="sm"
                checked={providerQuotaAware}
                onChange={(enabled) => { setProviderQuotaAware(enabled); patchProviderOverride({ quotaAware: enabled ? true : null }); }}
              />
            </label>
          </div>
        </div>

        {connections.length === 0 ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-text-muted">No connections yet</p>
            <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>Add Connection</Button>
          </div>
        ) : (
          <>
            <div className="flex flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03] max-h-[500px] overflow-y-auto pr-1">
              {connections.map((conn, idx) => (
                <ConnectionRow
                  key={conn.id}
                  connection={conn}
                  proxyPools={proxyPools}
                  isOAuth={isOAuth}
                  isFirst={idx === 0}
                  isLast={idx === connections.length - 1}
                  onMoveUp={() => handleSwapPriority(idx, idx - 1)}
                  onMoveDown={() => handleSwapPriority(idx, idx + 1)}
                  onToggleActive={(isActive) => handleToggleActive(conn.id, isActive)}
                  onToggleBanned={(banned) => handleToggleBanned(conn.id, banned)}
                  onUpdateProxy={(poolId) => handleUpdateProxy(conn.id, poolId)}
                  onEdit={() => { setSelectedConnection(conn); setShowEditModal(true); }}
                  onDelete={() => handleDelete(conn.id)}
                />
              ))}
            </div>
            <div className="mt-4 flex justify-stretch sm:justify-start">
              <Button size="sm" icon="add" onClick={() => setShowAddModal(true)}>Add</Button>
            </div>
          </>
        )}
      </Card>

      <AddApiKeyModal
        isOpen={showAddModal}
        provider={providerId}
        proxyPools={proxyPools}
        onSave={handleSaveApiKey}
        onClose={() => setShowAddModal(false)}
      />
      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => setShowEditModal(false)}
      />

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </>
  );
}

ConnectionsCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  isOAuth: PropTypes.bool,
};
