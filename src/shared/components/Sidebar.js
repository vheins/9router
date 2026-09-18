"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import Button from "./Button";
import { ConfirmModal } from "./Modal";
import NineRemotePromoModal from "./NineRemotePromoModal";

// const VISIBLE_MEDIA_KINDS = ["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"];
const VISIBLE_MEDIA_KINDS = ["embedding", "image", "video", "tts", "stt"];
// Combined entry: webSearch + webFetch share one page at /dashboard/media-providers/web
const COMBINED_WEB_ITEM = { id: "web", label: "Web Fetch & Search", icon: "travel_explore", href: "/dashboard/media-providers/web" };

const navItems = [
  { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "api" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  // { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat" }, // Hidden
  { href: "/dashboard/combos", label: "Combo & Vision Adapter", icon: "layers" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
  // { href: "/dashboard/pxpipe", label: "PXPIPE", icon: "image" },
  { href: "/dashboard/cli-tools", label: "CLI Tools", icon: "terminal" },
];

const debugItems = [
  { href: "/dashboard/console-log", label: "Console Log", icon: "terminal" },
  { href: "/dashboard/translator", label: "Translator", icon: "translate" },
];

const systemItems = [
  { href: "/dashboard/proxy-pools", label: "Proxy Pools", icon: "lan" },
  { href: "/dashboard/skills", label: "Skills", icon: "extension" },
];

export default function Sidebar({
  onClose,
  collapsed: externalCollapsed,
  onToggleCollapse: externalToggleCollapse,
}) {
  const pathname = usePathname();
  const [internalCollapsed, setInternalCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("sidebar:collapsed") === "true";
    } catch {
      return false;
    }
  });
  const [mediaOpen, setMediaOpen] = useState(false);
  const [showRemoteModal, setShowRemoteModal] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [shutdownCountdown, setShutdownCountdown] = useState(0);
  const [enableTranslator, setEnableTranslator] = useState(false);
  const { copied, copy } = useCopyToClipboard(2000);

  const INSTALL_CMD = UPDATER_CONFIG.installCmdLatest;

  const isControlled = externalCollapsed !== undefined;
  // If onClose is provided (mobile drawer), it's never collapsed
  const isCollapsed = onClose ? false : isControlled ? externalCollapsed : internalCollapsed;

  const toggleCollapse = () => {
    if (onClose) return;
    if (isControlled && externalToggleCollapse) {
      externalToggleCollapse();
    } else {
      setInternalCollapsed((prev) => {
        const next = !prev;
        try {
          localStorage.setItem("sidebar:collapsed", String(next));
        } catch {
          // ignore
        }
        return next;
      });
    }
  };

  useEffect(() => {
    fetch("/api/settings")
      .then(res => res.json())
      .then(data => { if (data.enableTranslator) setEnableTranslator(true); })
      .catch(() => {});
  }, []);

  // Lazy check for new npm version on mount
  useEffect(() => {
    fetch("/api/version")
      .then(res => res.json())
      .then(data => { if (data.hasUpdate) setUpdateInfo(data); })
      .catch(() => {});
  }, []);

  const isActive = (href) => {
    if (href === "/dashboard/endpoint") {
      return pathname === "/dashboard" || pathname.startsWith("/dashboard/endpoint");
    }
    return pathname.startsWith(href);
  };

  // Open manual update panel (no countdown yet — user must click Copy to trigger shutdown)
  const handleUpdate = () => {
    setShowUpdateModal(false);
    setIsUpdating(true);
  };

  // Triggered by Copy button inside ManualUpdatePanel: copy + countdown + shutdown
  const handleCopyAndShutdown = async () => {
    try { await navigator.clipboard.writeText(INSTALL_CMD); } catch { /* clipboard blocked */ }
    copy(INSTALL_CMD);
    let remaining = UPDATER_CONFIG.shutdownCountdownSec;
    setShutdownCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      setShutdownCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
        setIsDisconnected(true);
      }
    }, 1000);
  };

  const handleCancelUpdate = () => {
    setIsUpdating(false);
    setShutdownCountdown(0);
  };

  // Note: legacy updater poll removed. New flow: copy install cmd + shutdown server,
  // user runs the command manually in another terminal.


  return (
    <>
      <aside
        className={cn(
          "flex flex-col border-r border-border-subtle bg-vibrancy backdrop-blur-xl transition-[width] duration-200 ease-in-out min-h-full shrink-0 select-none overflow-x-hidden",
          isCollapsed ? "w-16" : "w-72"
        )}
      >
        {/* Traffic lights & header controls */}
        <div
          className={cn(
            "flex items-center pt-5 pb-2 transition-all duration-200",
            isCollapsed ? "justify-center px-2" : "justify-between px-6"
          )}
        >
          <div className={cn("flex items-center", isCollapsed ? "gap-1.5" : "gap-2")}>
            <div className={cn("rounded-full bg-[#FF5F56]", isCollapsed ? "size-2" : "size-3")} />
            <div className={cn("rounded-full bg-[#FFBD2E]", isCollapsed ? "size-2" : "size-3")} />
            <div className={cn("rounded-full bg-[#27C93F]", isCollapsed ? "size-2" : "size-3")} />
          </div>
          {!isCollapsed && !onClose && (
            <button
              type="button"
              onClick={toggleCollapse}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="hidden lg:flex items-center justify-center size-6 rounded-md text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[18px]">chevron_left</span>
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close menu"
              className="lg:hidden p-1 text-text-muted hover:text-text-main transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          )}
        </div>

        {/* Logo */}
        <div className={cn("flex flex-col gap-2 transition-all duration-200", isCollapsed ? "px-2 py-4 items-center" : "px-6 py-4")}>
          <Link
            href="/dashboard"
            onClick={onClose}
            title={isCollapsed ? `${APP_CONFIG.name} v${APP_CONFIG.version}` : undefined}
            aria-label={APP_CONFIG.name}
            className={cn("flex items-center transition-all", isCollapsed ? "justify-center" : "gap-3")}
          >
            <div className="flex items-center justify-center size-9 rounded-[10px] bg-gradient-to-br from-brand-500 to-brand-700 shadow-[var(--shadow-warm)] shrink-0">
              <span className="material-symbols-outlined text-white text-[20px]">hub</span>
            </div>
            {!isCollapsed && (
              <div className="flex flex-col min-w-0">
                <h1 className="text-lg font-semibold tracking-tight text-text-main truncate">
                  {APP_CONFIG.name}
                </h1>
                <span className="text-xs text-text-muted truncate">v{APP_CONFIG.version}</span>
              </div>
            )}
          </Link>
          {updateInfo && (
            !isCollapsed ? (
              <div className="flex flex-col gap-1.5 rounded p-1 -m-1">
                <span className="text-xs font-semibold text-green-600 dark:text-amber-500">
                  ↑ New version available: v{updateInfo.latestVersion}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowUpdateModal(true)}
                    className="px-2 py-1 rounded bg-green-600 hover:bg-green-700 dark:bg-amber-500 dark:hover:bg-amber-600 text-white text-[11px] font-semibold transition-colors cursor-pointer"
                  >
                    Update now
                  </button>
                  <button
                    type="button"
                    onClick={() => copy(INSTALL_CMD)}
                    title="Copy install command"
                    className="flex-1 text-left hover:opacity-80 transition-opacity cursor-pointer min-w-0"
                  >
                    <code className="block text-[10px] text-green-600/80 dark:text-amber-400/70 font-mono truncate">
                      {copied ? "✓ copied!" : INSTALL_CMD}
                    </code>
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowUpdateModal(true)}
                title={`New version available: v${updateInfo.latestVersion}`}
                aria-label={`Update available: v${updateInfo.latestVersion}`}
                className="relative flex items-center justify-center size-8 rounded-lg bg-green-500/10 dark:bg-amber-500/10 text-green-600 dark:text-amber-500 hover:bg-green-500/20 dark:hover:bg-amber-500/20 transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">upgrade</span>
                <span className="absolute top-1 right-1 size-2 rounded-full bg-green-500 dark:bg-amber-500" />
              </button>
            )
          )}
        </div>

        {/* Navigation */}
        <nav className={cn("flex-1 py-2 space-y-1 overflow-y-auto overflow-x-hidden custom-scrollbar", isCollapsed ? "px-2" : "px-4")}>
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              title={isCollapsed ? item.label : undefined}
              aria-label={item.label}
              className={cn(
                "flex items-center rounded-lg transition-all group",
                isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-1.5",
                isActive(item.href)
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px] shrink-0",
                  isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors"
                )}
              >
                {item.icon}
              </span>
              {!isCollapsed && <span className="text-[13px] font-medium truncate whitespace-nowrap">{item.label}</span>}
            </Link>
          ))}

          {/* System section */}
          <div className="pt-2 mt-2 space-y-1">
            {!isCollapsed ? (
              <p className="px-4 text-xs font-semibold text-text-muted/60 uppercase tracking-wider mb-2">
                System
              </p>
            ) : (
              <div className="my-2 border-t border-border-subtle mx-1" />
            )}

            {/* Media Providers accordion */}
            <button
              type="button"
              onClick={() => setMediaOpen((v) => !v)}
              title={isCollapsed ? "Media Providers" : undefined}
              aria-label="Media Providers"
              className={cn(
                "w-full flex items-center rounded-lg transition-all group cursor-pointer",
                isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-1.5",
                pathname.startsWith("/dashboard/media-providers")
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px] shrink-0">perm_media</span>
              {!isCollapsed && (
                <>
                  <span className="text-[13px] font-medium flex-1 text-left truncate whitespace-nowrap">
                    Media Providers
                  </span>
                  <span
                    className="material-symbols-outlined text-[14px] transition-transform"
                    style={{ transform: mediaOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                  >
                    expand_more
                  </span>
                </>
              )}
            </button>
            {mediaOpen && (
              <div className={cn(isCollapsed ? "space-y-1 my-1" : "pl-4 space-y-0.5")}>
                {MEDIA_PROVIDER_KINDS.filter((k) => VISIBLE_MEDIA_KINDS.includes(k.id)).map((kind) => (
                  <Link
                    key={kind.id}
                    href={`/dashboard/media-providers/${kind.id}`}
                    onClick={onClose}
                    title={isCollapsed ? kind.label : undefined}
                    aria-label={kind.label}
                    className={cn(
                      "flex items-center rounded-lg transition-all group",
                      isCollapsed ? "justify-center p-2" : "gap-3 px-4 py-1",
                      pathname.startsWith(`/dashboard/media-providers/${kind.id}`)
                        ? "bg-primary/10 text-primary"
                        : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                    )}
                  >
                    <span className="material-symbols-outlined text-[16px] shrink-0">{kind.icon}</span>
                    {!isCollapsed && <span className="text-sm truncate whitespace-nowrap">{kind.label}</span>}
                  </Link>
                ))}
                <Link
                  key={COMBINED_WEB_ITEM.id}
                  href={COMBINED_WEB_ITEM.href}
                  onClick={onClose}
                  title={isCollapsed ? COMBINED_WEB_ITEM.label : undefined}
                  aria-label={COMBINED_WEB_ITEM.label}
                  className={cn(
                    "flex items-center rounded-lg transition-all group",
                    isCollapsed ? "justify-center p-2" : "gap-3 px-4 py-1",
                    pathname.startsWith(COMBINED_WEB_ITEM.href)
                      ? "bg-primary/10 text-primary"
                      : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  <span className="material-symbols-outlined text-[16px] shrink-0">{COMBINED_WEB_ITEM.icon}</span>
                  {!isCollapsed && <span className="text-sm truncate whitespace-nowrap">{COMBINED_WEB_ITEM.label}</span>}
                </Link>
              </div>
            )}

            {systemItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                title={isCollapsed ? item.label : undefined}
                aria-label={item.label}
                className={cn(
                  "flex items-center rounded-lg transition-all group",
                  isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-1.5",
                  isActive(item.href)
                    ? "bg-primary/10 text-primary"
                    : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                )}
              >
                <span
                  className={cn(
                    "material-symbols-outlined text-[18px] shrink-0",
                    isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors"
                  )}
                >
                  {item.icon}
                </span>
                {!isCollapsed && <span className="text-[13px] font-medium truncate whitespace-nowrap">{item.label}</span>}
              </Link>
            ))}

            {/* Debug items (inside System section, before Settings) */}
            {debugItems.map((item) => {
              const show = item.href !== "/dashboard/translator" || enableTranslator;
              return show ? (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  title={isCollapsed ? item.label : undefined}
                  aria-label={item.label}
                  className={cn(
                    "flex items-center rounded-lg transition-all group",
                    isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-1.5",
                    isActive(item.href)
                      ? "bg-primary/10 text-primary"
                      : "text-text-muted hover:bg-surface-2 hover:text-text-main"
                  )}
                >
                  <span
                    className={cn(
                      "material-symbols-outlined text-[18px] shrink-0",
                      isActive(item.href) ? "fill-1" : "group-hover:text-primary transition-colors"
                    )}
                  >
                    {item.icon}
                  </span>
                  {!isCollapsed && <span className="text-[13px] font-medium truncate whitespace-nowrap">{item.label}</span>}
                </Link>
              ) : null;
            })}

            {/* Remote */}
            <button
              type="button"
              onClick={() => setShowRemoteModal(true)}
              title={isCollapsed ? "9Remote" : undefined}
              aria-label="9Remote"
              className={cn(
                "flex items-center rounded-lg transition-all group w-full cursor-pointer",
                isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-1.5",
                "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px] shrink-0 group-hover:text-primary transition-colors">
                computer
              </span>
              {!isCollapsed && <span className="text-[13px] font-medium truncate whitespace-nowrap">9Remote</span>}
            </button>

            {/* 9English */}
            <a
              href="https://9english.net/"
              target="_blank"
              rel="noreferrer"
              onClick={onClose}
              title={isCollapsed ? "9English" : undefined}
              aria-label="9English"
              className={cn(
                "flex items-center rounded-lg transition-all group w-full",
                isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-1.5",
                "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px] shrink-0 group-hover:text-primary transition-colors">
                translate
              </span>
              {!isCollapsed && <span className="text-[13px] font-medium truncate whitespace-nowrap">9English</span>}
            </a>

            {/* Settings */}
            <Link
              href="/dashboard/profile"
              onClick={onClose}
              title={isCollapsed ? "Settings" : undefined}
              aria-label="Settings"
              className={cn(
                "flex items-center rounded-lg transition-all group",
                isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-1.5",
                isActive("/dashboard/profile")
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              )}
            >
              <span
                className={cn(
                  "material-symbols-outlined text-[18px] shrink-0",
                  isActive("/dashboard/profile") ? "fill-1" : "group-hover:text-primary transition-colors"
                )}
              >
                settings
              </span>
              {!isCollapsed && <span className="text-[13px] font-medium truncate whitespace-nowrap">Settings</span>}
            </Link>
          </div>
        </nav>

        {/* Toggle Collapse Button (Desktop only) */}
        {!onClose && (
          <div className="p-2 border-t border-border-subtle mt-auto shrink-0 hidden lg:block">
            <button
              type="button"
              onClick={toggleCollapse}
              aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={cn(
                "w-full flex items-center rounded-lg text-text-muted hover:bg-surface-2 hover:text-text-main transition-all group cursor-pointer",
                isCollapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2 text-left"
              )}
            >
              <span className="material-symbols-outlined text-[20px] shrink-0 group-hover:text-primary transition-colors">
                {isCollapsed ? "chevron_right" : "chevron_left"}
              </span>
              {!isCollapsed && (
                <span className="text-[13px] font-medium truncate whitespace-nowrap">Collapse</span>
              )}
            </button>
          </div>
        )}
      </aside>

      {/* Remote Promo Modal */}
      <NineRemotePromoModal isOpen={showRemoteModal} onClose={() => setShowRemoteModal(false)} />

      {/* Update Confirmation Modal */}
      <ConfirmModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleUpdate}
        title="Update 9Router"
        message={`Show install command for v${updateInfo?.latestVersion || ""}? You can copy it and shutdown to install manually.`}
        confirmText="Show Command"
        cancelText="Cancel"
        variant="primary"
      />

      {/* Disconnected / Updating Overlay */}
      {(isDisconnected || isUpdating) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
          {isUpdating ? (
            <ManualUpdatePanel
              latestVersion={updateInfo?.latestVersion}
              installCmd={INSTALL_CMD}
              copied={copied}
              onCopyAndShutdown={handleCopyAndShutdown}
              onCancel={handleCancelUpdate}
              countdown={shutdownCountdown}
              isDisconnected={isDisconnected}
            />
          ) : (
            <div className="text-center p-8">
              <div className="flex items-center justify-center size-16 rounded-full bg-red-500/20 text-red-500 mx-auto mb-4">
                <span className="material-symbols-outlined text-[32px]">power_off</span>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Server Disconnected</h2>
              <p className="text-text-muted mb-6">The proxy server has been stopped.</p>
              <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                Reload Page
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
  collapsed: PropTypes.bool,
  onToggleCollapse: PropTypes.func,
};

function ManualUpdatePanel({ latestVersion, installCmd, copied, onCopyAndShutdown, onCancel, countdown, isDisconnected }) {
  const isCountingDown = countdown > 0;
  return (
    <div className="w-full max-w-lg rounded-xl bg-neutral-900/95 border border-white/10 p-6 text-white">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center justify-center size-11 rounded-full bg-amber-500/20 text-amber-400">
          <span className="material-symbols-outlined text-[24px]">content_copy</span>
        </div>
        <div>
          <h2 className="text-lg font-semibold">Update 9Router{latestVersion ? ` to v${latestVersion}` : ""}</h2>
          <p className="text-xs text-white/60">
            {isDisconnected
              ? "Server stopped. Paste the command into a terminal to install."
              : isCountingDown
                ? `Command copied. Server will stop in ${countdown}s...`
                : "Click the button below to copy the install command and shutdown."}
          </p>
        </div>
      </div>

      <p className="text-sm text-white/80 mb-2">Install command:</p>
      <div className="w-full px-3 py-2 rounded bg-white/5 mb-4">
        <code className="text-xs font-mono text-amber-400 break-all">{installCmd}</code>
      </div>

      <ol className="text-xs text-white/70 space-y-1 list-decimal list-inside mb-4">
        <li>Click <strong>Copy & Shutdown</strong> below.</li>
        <li>Paste the command into your terminal and press Enter.</li>
        <li>Run <code className="px-1 rounded bg-white/10 text-green-400">9router</code> again after install.</li>
      </ol>

      {isDisconnected ? (
        <Button variant="secondary" fullWidth onClick={() => globalThis.location.reload()}>
          Reload Page
        </Button>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={isCountingDown}>
            Cancel
          </Button>
          <Button variant="primary" fullWidth onClick={onCopyAndShutdown} disabled={isCountingDown}>
            {copied ? "✓ Copied — shutting down..." : isCountingDown ? `Shutting down in ${countdown}s` : "Copy & Shutdown"}
          </Button>
        </div>
      )}
    </div>
  );
}

ManualUpdatePanel.propTypes = {
  latestVersion: PropTypes.string,
  installCmd: PropTypes.string.isRequired,
  copied: PropTypes.bool,
  onCopyAndShutdown: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
  countdown: PropTypes.number,
  isDisconnected: PropTypes.bool,
};
