"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, PieChart, Pie, Cell, AreaChart, Area,
} from "recharts";
import Card from "@/shared/components/Card";
import { fmt } from "./UsageTable";

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];

const PERIOD_MINUTES = { today: null, "24h": 1440, "7d": 10080, "30d": 43200, "60d": 86400, all: null };

function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n || 0);
}
function fmtCost(n) { return `$${(n || 0).toFixed(4)}`; }
function fmtMs(ms) { return ms == null ? "—" : `${(ms / 1000).toFixed(2)}s`; }
function fmtTps(tps) { return tps == null ? "—" : `${tps.toFixed(1)} tok/s`; }
function fmtPct(v) { return `${(v * 100).toFixed(1)}%`; }

function relTime(iso) {
  if (!iso) return "Never";
  const diffMins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return `${Math.floor(diffMins / 1440)}d ago`;
}

function SummaryCard({ label, value, sub, accent }) {
  return (
    <Card padding="sm" className="flex min-w-0 flex-col">
      <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</span>
      <span className={`mt-1 truncate text-xl font-semibold ${accent || "text-text-main"}`}>{value}</span>
      {sub && <span className="mt-0.5 truncate text-xs text-text-muted">{sub}</span>}
    </Card>
  );
}

function Toggle({ options, value, onChange, size = "md" }) {
  const pad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1 text-sm";
  return (
    <div className="grid grid-flow-col gap-1 rounded-lg border border-border bg-bg-subtle p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md font-medium transition-colors ${pad} ${value === o.value ? "bg-primary text-white shadow-sm" : "text-text-muted hover:bg-bg-hover hover:text-text"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Period → elapsed minutes for RPM. "today"/"all" fall back to elapsed wall time.
function elapsedMinutes(period) {
  if (period === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return Math.max(1, (Date.now() - start.getTime()) / 60000);
  }
  const fixed = PERIOD_MINUTES[period];
  if (fixed) return fixed;
  return Math.max(1, (Date.now() - new Date(new Date().toDateString()).getTime()) / 60000);
}

export default function UserTab({ period = "today" }) {
  const [stats, setStats] = useState(null);
  const [chart, setChart] = useState([]);
  const [loading, setLoading] = useState(true);
  const [groupBy, setGroupBy] = useState("userModel");
  const [valueMode, setValueMode] = useState("tokens");
  const [chartMode, setChartMode] = useState("tokens");
  const [selectedUser, setSelectedUser] = useState("all");
  const [live, setLive] = useState(false);

  const load = useCallback(async (signal) => {
    const [s, c] = await Promise.all([
      fetch(`/api/usage/stats?period=${period}`, { signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`/api/usage/chart?period=${period}`, { signal }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ]);
    if (s) setStats(s);
    setChart(Array.isArray(c) ? c : []);
  }, [period]);

  // Initial + period-change load.
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    load(ac.signal).finally(() => setLoading(false));
    return () => ac.abort();
  }, [load]);

  // Realtime: the shared SSE stream emits an event whenever usage is written.
  // We don't merge the stream's payload directly (it is always period="all");
  // instead we refetch the REST stats/chart for the *selected* period, debounced
  // so a burst of writes collapses into one refetch.
  useEffect(() => {
    let timer = null;
    const es = new EventSource("/api/usage/stream");
    es.onopen = () => setLive(true);
    es.onmessage = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; load(); }, 800);
    };
    es.onerror = () => setLive(false);
    return () => { if (timer) clearTimeout(timer); es.close(); };
  }, [load]);

  const users = useMemo(() => Object.values(stats?.byUser || {}), [stats]);

  const totals = useMemo(() => {
    const requests = users.reduce((s, u) => s + (u.requests || 0), 0);
    const promptTokens = users.reduce((s, u) => s + (u.promptTokens || 0), 0);
    const completionTokens = users.reduce((s, u) => s + (u.completionTokens || 0), 0);
    const cachedTokens = users.reduce((s, u) => s + (u.cachedTokens || 0), 0);
    const cost = users.reduce((s, u) => s + (u.cost || 0), 0);
    // Latency averages weighted by the number of requests that actually
    // recorded a sample. TPS uses summed sampled tokens / summed sampled time
    // (NOT the averaged time, which would inflate throughput by the sample count).
    let sumTtft = 0, sumTotal = 0, samples = 0, sampledCompletion = 0;
    for (const u of users) {
      const n = u.sampledRequests || 0;
      if (u.avgTotalMs != null && n) {
        sumTtft += (u.avgTtftMs || 0) * n;
        sumTotal += u.avgTotalMs * n;
        sampledCompletion += u.sampledCompletionTokens || 0;
        samples += n;
      }
    }
    const avgTtftMs = samples ? Math.round(sumTtft / samples) : null;
    const avgTotalMs = samples ? Math.round(sumTotal / samples) : null;
    const totalTokens = promptTokens + completionTokens;
    const tps = sumTotal > 0 ? Number((sampledCompletion / (sumTotal / 1000)).toFixed(1)) : null;
    const cacheHitRate = promptTokens ? cachedTokens / promptTokens : 0;
    const minutes = elapsedMinutes(period);
    return {
      users: users.length, requests, promptTokens, completionTokens, cachedTokens, cost,
      totalTokens, avgTtftMs, avgTotalMs, tps, cacheHitRate,
      tokensPerReq: requests ? Math.round(totalTokens / requests) : 0,
      rpm: minutes ? Number((requests / minutes).toFixed(2)) : 0,
    };
  }, [users, period]);

  // Stacked bar: one column per user, stacked by model (tokens).
  const modelNames = useMemo(() => {
    const set = new Set();
    for (const u of users) for (const m of Object.values(u.models || {})) set.add(m.rawModel || "unknown");
    return [...set];
  }, [users]);

  const stackedData = useMemo(() => users.map((u) => {
    const row = { name: u.keyName || u.apiKeyKey, _user: u };
    for (const m of Object.values(u.models || {})) {
      row[m.rawModel || "unknown"] = (row[m.rawModel || "unknown"] || 0) + (m.promptTokens || 0) + (m.completionTokens || 0);
    }
    return row;
  }), [users]);

  const pieData = useMemo(() => users
    .map((u) => ({ name: u.keyName || u.apiKeyKey, value: u.requests || 0 }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value), [users]);

  // "Usage by User × Model" rows, reshaped by groupBy.
  const rows = useMemo(() => {
    const out = [];
    for (const u of users) {
      if (selectedUser !== "all" && (u.keyName || u.apiKeyKey) !== selectedUser) continue;
      for (const m of Object.values(u.models || {})) {
        out.push({
          user: u.keyName || u.apiKeyKey,
          model: m.rawModel || "unknown",
          provider: m.provider || "",
          requests: m.requests || 0,
          errorRequests: m.errorRequests || 0,
          promptTokens: m.promptTokens || 0,
          completionTokens: m.completionTokens || 0,
          cachedTokens: m.cachedTokens || 0,
          totalTokens: m.totalTokens || (m.promptTokens || 0) + (m.completionTokens || 0),
          cost: m.cost || 0,
          avgTtftMs: m.avgTtftMs,
          avgTotalMs: m.avgTotalMs,
          tps: m.tps,
          sampledRequests: m.sampledRequests || 0,
          sampledCompletionTokens: m.sampledCompletionTokens || 0,
          sampledTotalMs: m.sampledTotalMs || 0,
          tokensPerReq: m.tokensPerReq,
          lastUsed: m.lastUsed,
          lastSuccess: m.lastSuccess,
          lastError: m.lastError,
        });
      }
    }
    if (groupBy === "user") {
      const agg = {};
      for (const r of out) {
        const g = agg[r.user] || (agg[r.user] = { user: r.user, model: "—", provider: "", requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, lastUsed: null, lastSuccess: null, lastError: null, _sTtft: 0, _sTotal: 0, _n: 0, _sComp: 0 });
        g.requests += r.requests; g.promptTokens += r.promptTokens; g.completionTokens += r.completionTokens;
        g.cachedTokens += r.cachedTokens; g.totalTokens += r.totalTokens; g.cost += r.cost;
        if (r.lastUsed && (!g.lastUsed || r.lastUsed > g.lastUsed)) g.lastUsed = r.lastUsed;
        if (r.lastSuccess && (!g.lastSuccess || r.lastSuccess > g.lastSuccess)) g.lastSuccess = r.lastSuccess;
        if (r.lastError && (!g.lastError || r.lastError > g.lastError)) g.lastError = r.lastError;
        if (r.avgTotalMs != null && r.sampledRequests) {
          g._sTtft += (r.avgTtftMs || 0) * r.sampledRequests; g._sTotal += r.avgTotalMs * r.sampledRequests;
          g._sComp += r.sampledCompletionTokens || 0; g._n += r.sampledRequests;
        }
      }
      return Object.values(agg).map((g) => ({
        ...g,
        avgTtftMs: g._n ? Math.round(g._sTtft / g._n) : null,
        avgTotalMs: g._n ? Math.round(g._sTotal / g._n) : null,
        tps: g._sTotal > 0 ? Number((g._sComp / (g._sTotal / 1000)).toFixed(1)) : null,
        tokensPerReq: g.requests ? Math.round(g.totalTokens / g.requests) : 0,
      }));
    }
    if (groupBy === "model") {
      const agg = {};
      for (const r of out) {
        const key = `${r.model}|${r.provider}`;
        const g = agg[key] || (agg[key] = { user: "—", model: r.model, provider: r.provider, requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, lastUsed: null, lastSuccess: null, lastError: null, _sTtft: 0, _sTotal: 0, _n: 0, _sComp: 0 });
        g.requests += r.requests; g.promptTokens += r.promptTokens; g.completionTokens += r.completionTokens;
        g.cachedTokens += r.cachedTokens; g.totalTokens += r.totalTokens; g.cost += r.cost;
        if (r.lastUsed && (!g.lastUsed || r.lastUsed > g.lastUsed)) g.lastUsed = r.lastUsed;
        if (r.lastSuccess && (!g.lastSuccess || r.lastSuccess > g.lastSuccess)) g.lastSuccess = r.lastSuccess;
        if (r.lastError && (!g.lastError || r.lastError > g.lastError)) g.lastError = r.lastError;
        if (r.avgTotalMs != null && r.sampledRequests) {
          g._sTtft += (r.avgTtftMs || 0) * r.sampledRequests; g._sTotal += r.avgTotalMs * r.sampledRequests;
          g._sComp += r.sampledCompletionTokens || 0; g._n += r.sampledRequests;
        }
      }
      return Object.values(agg).map((g) => ({
        ...g,
        avgTtftMs: g._n ? Math.round(g._sTtft / g._n) : null,
        avgTotalMs: g._n ? Math.round(g._sTotal / g._n) : null,
        tps: g._sTotal > 0 ? Number((g._sComp / (g._sTotal / 1000)).toFixed(1)) : null,
        tokensPerReq: g.requests ? Math.round(g.totalTokens / g.requests) : 0,
      }));
    }
    return out;
  }, [users, groupBy, selectedUser]);

  // Requests-per-minute per row, over the selected period's elapsed window.
  const rowsWithRpm = useMemo(() => {
    const minutes = elapsedMinutes(period);
    return rows.map((r) => ({ ...r, rpm: minutes ? Number((r.requests / minutes).toFixed(2)) : 0 }));
  }, [rows, period]);

  const topCombos = useMemo(() => [...rows]
    .sort((a, b) => (valueMode === "cost" ? (b.cost || 0) - (a.cost || 0) : (b.totalTokens || 0) - (a.totalTokens || 0)))
    .slice(0, 8)
    .map((r) => ({ name: `${r.user} › ${r.model}`, value: valueMode === "cost" ? (r.cost || 0) : (r.totalTokens || 0) })), [rows, valueMode]);

  const sortedRows = useMemo(() => [...rowsWithRpm].sort((a, b) => (b.requests || 0) - (a.requests || 0)), [rowsWithRpm]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-text-muted">
        <span className="material-symbols-outlined animate-spin text-[32px]">progress_activity</span>
      </div>
    );
  }

  if (users.length === 0) {
    return (
      <Card padding="lg" className="text-center text-text-muted">
        No per-user usage recorded yet. Usage is attributed by the API key that authenticated each request.
      </Card>
    );
  }

  const groupOptions = [
    { value: "user", label: "User" },
    { value: "model", label: "Model" },
    { value: "userModel", label: "User × Model" },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Live status */}
      <div className="flex items-center gap-2 px-1">
        <span className={`inline-flex h-2 w-2 rounded-full ${live ? "bg-success animate-pulse" : "bg-text-muted"}`} />
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
          {live ? "Live · updates automatically" : "Connecting…"}
        </span>
      </div>

      {/* Row 1 — headline totals */}
      <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">
        <SummaryCard label="Users" value={fmt(totals.users)} sub="all keys" />
        <SummaryCard label="Requests" value={fmt(totals.requests)} sub={`${fmt(totals.cachedTokens)} cached`} />
        <SummaryCard label="Tokens" value={fmt(totals.totalTokens)} sub={`${fmt(totals.promptTokens)} in / ${fmt(totals.completionTokens)} out`} />
        <SummaryCard label="Cost" value={`$${totals.cost.toFixed(4)}`} sub="estimated" />
      </div>

      {/* Row 2 — derived metrics */}
      <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-6">
        <SummaryCard label="Avg TTFT" value={fmtMs(totals.avgTtftMs)} sub="first token" />
        <SummaryCard label="Avg Total" value={fmtMs(totals.avgTotalMs)} sub="wall time" />
        <SummaryCard label="TPS" value={totals.tps == null ? "—" : `${totals.tps} tok/s`} sub={totals.tps ? `incl. TTFT · ${(1000 / totals.tps).toFixed(1)}ms/tok` : "—"} />
        <SummaryCard label="Cache Hit" value={fmtPct(totals.cacheHitRate)} sub={`${fmt(totals.cachedTokens)} / ${fmt(totals.promptTokens)}`} />
        <SummaryCard label="Tok/Req" value={fmt(totals.tokensPerReq)} sub={`${fmt(Math.round(totals.promptTokens / Math.max(1, totals.requests)))} in · ${fmt(Math.round(totals.completionTokens / Math.max(1, totals.requests)))} out`} />
        <SummaryCard label="RPM" value={totals.rpm} sub="req/min avg" />
      </div>

      {/* Charts row */}
      <div className="grid min-w-0 grid-cols-1 items-stretch gap-2 lg:grid-cols-[minmax(0,3fr)_minmax(240px,2fr)]">
        <Card padding="sm" className="min-w-0">
          <div className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Tokens by User — stacked by Model</div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={stackedData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtTokens} />
              <Tooltip formatter={(v) => fmt(v)} contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {modelNames.map((m, i) => (
                <Bar key={m} dataKey={m} stackId="tokens" fill={COLORS[i % COLORS.length]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card padding="sm" className="min-w-0">
          <div className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Request Share</div>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={2}>
                {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(v) => fmt(v)} contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Time-series area chart */}
      <Card padding="sm" className="min-w-0">
        <div className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="px-1 text-xs font-semibold uppercase tracking-wide text-text-muted">Usage Over Time</span>
          <Toggle options={[{ value: "tokens", label: "Tokens" }, { value: "cost", label: "Cost" }]} value={chartMode} onChange={setChartMode} size="sm" />
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradUserTokens" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradUserCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={chartMode === "cost" ? (v) => `$${(v || 0).toFixed(2)}` : fmtTokens} />
            <Tooltip formatter={(v) => (chartMode === "cost" ? fmtCost(v) : fmt(v))} contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
            {chartMode === "cost" ? (
              <Area type="monotone" dataKey="cost" stroke="#f59e0b" fill="url(#gradUserCost)" strokeWidth={2} />
            ) : (
              <Area type="monotone" dataKey="tokens" stroke="#6366f1" fill="url(#gradUserTokens)" strokeWidth={2} />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      {/* Usage by User × Model panel */}
      <Card padding="sm" className="overflow-hidden">
        <div className="flex flex-col gap-2 px-1 pb-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Usage by User × Model</span>
            <select
              value={selectedUser}
              onChange={(e) => setSelectedUser(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50 sm:w-auto"
            >
              <option value="all">All Users</option>
              {users.map((u) => <option key={u.apiKeyKey} value={u.keyName || u.apiKeyKey}>{u.keyName || u.apiKeyKey}</option>)}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-text-muted">Group by:</span>
            <Toggle options={groupOptions} value={groupBy} onChange={setGroupBy} size="sm" />
            <span className="text-[11px] text-text-muted">· {groupBy === "userModel" ? "per user-model combo" : groupBy === "user" ? "per user" : "per model"}</span>
          </div>
        </div>

        <div className="mb-4 rounded-lg border border-border bg-bg-subtle/50 p-2 sm:p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Top 8 combos</span>
            <Toggle options={[{ value: "tokens", label: "Tokens" }, { value: "cost", label: "Cost" }]} value={valueMode} onChange={setValueMode} size="sm" />
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={topCombos} layout="vertical" margin={{ top: 2, right: 12, left: 8, bottom: 2 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.08} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={valueMode === "cost" ? (v) => `$${(v || 0).toFixed(2)}` : fmtTokens} />
              <YAxis type="category" dataKey="name" width={148} tick={{ fontSize: 10 }} />
              <Tooltip formatter={(v) => (valueMode === "cost" ? fmtCost(v) : fmt(v))} contentStyle={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="value" fill={valueMode === "cost" ? "#f59e0b" : "#6366f1"} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="max-h-[480px] overflow-auto">
          <table className="w-full min-w-[1300px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-bg">
              <tr className="border-b border-border text-left text-text-muted">
                <th className="px-3 py-2 font-semibold">{groupBy === "user" ? "User" : groupBy === "model" ? "Model" : "User"}</th>
                {groupBy !== "user" && <th className="px-3 py-2 font-semibold">Model</th>}
                {groupBy !== "user" && <th className="px-3 py-2 font-semibold">Provider</th>}
                <th className="px-3 py-2 text-right font-semibold">Requests</th>
                <th className="px-3 py-2 text-right font-semibold">In</th>
                <th className="px-3 py-2 text-right font-semibold">Out</th>
                <th className="px-3 py-2 text-right font-semibold">Cached</th>
                <th className="px-3 py-2 text-right font-semibold">Cost</th>
                <th className="px-3 py-2 text-right font-semibold">Avg TTFT</th>
                <th className="px-3 py-2 text-right font-semibold">Avg Total</th>
                <th className="px-3 py-2 text-right font-semibold">TPS</th>
                <th className="px-3 py-2 text-right font-semibold">Tok/Req</th>
                <th className="px-3 py-2 text-right font-semibold">RPM</th>
                <th className="px-3 py-2 text-right font-semibold">Last Success</th>
                <th className="px-3 py-2 text-right font-semibold">Last Error</th>
                <th className="px-3 py-2 text-right font-semibold">Last Used</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {sortedRows.map((r, i) => (
                <tr key={`${r.user}|${r.model}|${i}`} className="transition-colors hover:bg-bg-subtle">
                  <td className="max-w-[140px] truncate px-3 py-2 font-medium" title={r.user}>{r.user}</td>
                  {groupBy !== "user" && <td className="max-w-[180px] truncate px-3 py-2 font-mono" title={r.model}>{r.model}</td>}
                  {groupBy !== "user" && (
                    <td className="px-3 py-2">
                      {r.provider ? <span className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-[10px] text-text-muted">{r.provider}</span> : "—"}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right">{fmt(r.requests)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-primary">{fmt(r.promptTokens)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-success">{fmt(r.completionTokens)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-text-muted">{r.cachedTokens ? fmt(r.cachedTokens) : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">{fmtCost(r.cost)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-text-muted">{fmtMs(r.avgTtftMs)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-text-muted">{fmtMs(r.avgTotalMs)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-text-muted">{fmtTps(r.tps)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-text-muted">{fmt(r.tokensPerReq)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-text-muted">{r.rpm}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-success">{relTime(r.lastSuccess)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">{r.lastError ? <span className="text-error">{relTime(r.lastError)}</span> : <span className="text-text-muted">—</span>}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-text-muted">{relTime(r.lastUsed)}</td>
                </tr>
              ))}
              {sortedRows.length === 0 && (
                <tr><td colSpan={16} className="px-3 py-8 text-center text-text-muted">No usage in this period.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
