// Re-export from open-sse with local logger
import * as log from "../utils/logger.js";
import { updateProviderConnection } from "../../lib/localDb.js";
import {
  getProjectIdForConnection,
  invalidateProjectId,
  removeConnection,
} from "open-sse/services/projectId.js";
import {
  TOKEN_EXPIRY_BUFFER_MS as BUFFER_MS,
  refreshAccessToken as _refreshAccessToken,
  refreshClaudeOAuthToken as _refreshClaudeOAuthToken,
  refreshGoogleToken as _refreshGoogleToken,
  refreshCodexToken as _refreshCodexToken,
  refreshIflowToken as _refreshIflowToken,
  refreshGitHubToken as _refreshGitHubToken,
  refreshCopilotToken as _refreshCopilotToken,
  getAccessToken as _getAccessToken,
  refreshTokenByProvider as _refreshTokenByProvider,
  formatProviderCredentials as _formatProviderCredentials,
  getAllAccessTokens as _getAllAccessTokens,
  refreshKiroToken as _refreshKiroToken,
  getRefreshLeadMs as _getRefreshLeadMs
} from "open-sse/services/tokenRefresh.js";
import {
  refreshProviderCredentials as _refreshProviderCredentials,
  shouldRefreshCredentials as _shouldRefreshCredentials,
} from "open-sse/services/oauthCredentialManager.js";

export const TOKEN_EXPIRY_BUFFER_MS = BUFFER_MS;

// Max time the request path will wait for an in-flight token refresh before
// failing open with the existing credentials. The background tick passes
// force:true and waits unbounded (0).
const TOKEN_REFRESH_WAIT_TIMEOUT_MS = Number(process.env.TOKEN_REFRESH_WAIT_TIMEOUT_MS) || 10000;

// ─── Re-exports wrapped with local logger ─────────────────────────────────────

export const refreshAccessToken = (provider, refreshToken, credentials) =>
  _refreshAccessToken(provider, refreshToken, credentials, log);

export const refreshClaudeOAuthToken = (refreshToken) =>
  _refreshClaudeOAuthToken(refreshToken, log);

export const refreshGoogleToken = (refreshToken, clientId, clientSecret) =>
  _refreshGoogleToken(refreshToken, clientId, clientSecret, log);

export const refreshCodexToken = (refreshToken) =>
  _refreshCodexToken(refreshToken, log);

export const refreshIflowToken = (refreshToken) =>
  _refreshIflowToken(refreshToken, log);

export const refreshGitHubToken = (refreshToken) =>
  _refreshGitHubToken(refreshToken, log);

export const refreshCopilotToken = (githubAccessToken) =>
  _refreshCopilotToken(githubAccessToken, log);

export const refreshKiroToken = (refreshToken, providerSpecificData) =>
  _refreshKiroToken(refreshToken, providerSpecificData, log);

export const getAccessToken = (provider, credentials) =>
  _getAccessToken(provider, credentials, log);

export const refreshTokenByProvider = (provider, credentials) =>
  _refreshTokenByProvider(provider, credentials, log);

export const formatProviderCredentials = (provider, credentials) =>
  _formatProviderCredentials(provider, credentials, log);

export const getAllAccessTokens = (userInfo) =>
  _getAllAccessTokens(userInfo, log);

export const shouldRefreshCredentials = (provider, credentials) =>
  _shouldRefreshCredentials(provider, credentials);

// ─── Lifecycle hook ───────────────────────────────────────────────────────────

/**
 * Call this when a connection is fully closed / removed.
 * Aborts any in-flight projectId fetch and evicts its cache entry,
 * preventing the module-level Maps from accumulating stale entries.
 *
 * @param {string} connectionId
 */
export function releaseConnection(connectionId) {
  if (!connectionId) return;
  removeConnection(connectionId);
  log.debug("TOKEN_REFRESH", "Released connection resources", { connectionId });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Await `promise` but never longer than `timeoutMs`.
 *
 * - timeoutMs <= 0 → wait unbounded (background tick, force:true).
 * - On timeout → resolve { timedOut: true, value: null } so the caller proceeds
 *   with the existing credentials (fail-open).
 * - On refresh rejection → resolve { timedOut: false, value: null } (NOT throw):
 *   preserves current behaviour where a failed refresh returns null and the
 *   caller keeps the old credentials.
 *
 * @param {Promise<any>} promise
 * @param {number} timeoutMs
 * @returns {Promise<{ timedOut: boolean, value: any }>}
 */
function withBoundedWait(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise.then(
      (v) => ({ timedOut: false, value: v }),
      () => ({ timedOut: false, value: null }) // refresh failure -> fail-open
    );
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true, value: null }), timeoutMs);
    promise.then(
      (v) => { clearTimeout(timer); resolve({ timedOut: false, value: v }); },
      () => { clearTimeout(timer); resolve({ timedOut: false, value: null }); } // refresh failure -> fail-open
    );
  });
}

/**
 * Compute an ISO expiry timestamp from a relative expiresIn (seconds).
 * @param {number} expiresIn
 * @returns {string}
 */
function toExpiresAt(expiresIn) {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Providers that carry a real Google project ID.
 * @param {string} provider
 * @returns {boolean}
 */
function needsProjectId(provider) {
  return provider === "antigravity" || provider === "gemini-cli";
}

/**
 * Non-blocking: fetch the project ID for a connection after a token refresh and
 * persist it to localDb.  Invalidates the stale cached value first so the fetch
 * always retrieves a fresh one.
 *
 * @param {string} provider
 * @param {string} connectionId
 * @param {string} accessToken
 */
function _refreshProjectId(provider, connectionId, accessToken) {
  if (!needsProjectId(provider) || !connectionId || !accessToken) return;

  // Invalidate the stale cached entry so getProjectIdForConnection does a real fetch
  invalidateProjectId(connectionId);

  // Lazy resolution: Do not eagerly trigger onboardUser during background token refresh.
  // Eagerly fetching projectId across multiple accounts simultaneously triggers Google Cloud anti-abuse / rate limits.
  // Runtime handlers (e.g. chat handler) will lazily call getProjectIdForConnection() on demand.
  if (process.env.EAGER_PROJECT_ID_REFRESH === "true") {
    getProjectIdForConnection(connectionId, accessToken, provider)
      .then((projectId) => {
        if (!projectId) return;
        updateProviderCredentials(connectionId, { projectId }).catch((err) => {
          log.debug("TOKEN_REFRESH", "Failed to persist refreshed projectId", {
            connectionId,
            error: err?.message ?? err,
          });
        });
      })
      .catch((err) => {
        log.debug("TOKEN_REFRESH", "Failed to fetch projectId after token refresh", {
          connectionId,
          error: err?.message ?? err,
        });
      });
  }
}

// ─── Local-specific: persist credentials to localDb ──────────────────────────

/**
 * Persist updated credentials for a connection to localDb.
 * Only fields that are present in `newCredentials` are written.
 *
 * @param {string} connectionId
 * @param {object} newCredentials
 * @returns {Promise<boolean>}
 */
export async function updateProviderCredentials(connectionId, newCredentials) {
  try {
    const updates = {};

    if (newCredentials.accessToken)         updates.accessToken  = newCredentials.accessToken;
    if (newCredentials.refreshToken)        updates.refreshToken = newCredentials.refreshToken;
    if (newCredentials.idToken)             updates.idToken = newCredentials.idToken;
    if (newCredentials.lastRefreshAt)       updates.lastRefreshAt = newCredentials.lastRefreshAt;
    if (newCredentials.expiresAt)           updates.expiresAt = newCredentials.expiresAt;
    if (newCredentials.expiresIn) {
      updates.expiresAt = toExpiresAt(newCredentials.expiresIn);
      updates.expiresIn = newCredentials.expiresIn;
    } else if (newCredentials.expiresAt) {
      const expiresAt = normalizeExpiresAt(newCredentials.expiresAt);
      if (expiresAt) {
        updates.expiresAt = expiresAt;
        updates.expiresIn = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      }
    }
    if (newCredentials.providerSpecificData) {
      updates.providerSpecificData = {
        ...(newCredentials.existingProviderSpecificData || {}),
        ...newCredentials.providerSpecificData,
      };
    }
    if (newCredentials.copilotToken || newCredentials.copilotTokenExpiresAt) {
      updates.providerSpecificData = {
        ...(updates.providerSpecificData || newCredentials.existingProviderSpecificData || {}),
        ...(newCredentials.copilotToken ? { copilotToken: newCredentials.copilotToken } : {}),
        ...(newCredentials.copilotTokenExpiresAt ? { copilotTokenExpiresAt: newCredentials.copilotTokenExpiresAt } : {}),
      };
    }
    if (newCredentials.projectId)            updates.projectId = newCredentials.projectId;

    const result = await updateProviderConnection(connectionId, updates);
    log.info("TOKEN_REFRESH", "Credentials updated in localDb", {
      connectionId,
      success: !!result
    });
    return !!result;
  } catch (error) {
    log.error("TOKEN_REFRESH", "Error updating credentials in localDb", {
      connectionId,
      error: error.message,
    });
    return false;
  }
}

// ─── Local-specific: proactive token refresh ─────────────────────────────────

/**
 * Check whether the provider token (and, for GitHub, the Copilot token) is
 * about to expire and refresh it proactively.
 *
 * @param {string} provider
 * @param {object} credentials
 * @param {{ force?: boolean, waitTimeoutMs?: number }} [options]  force=true skips the on-request lead check
 *   (used by background scheduler which applies a larger lead) and waits unbounded.
 *   waitTimeoutMs bounds the wait for an in-flight refresh on the request path
 *   (defaults to TOKEN_REFRESH_WAIT_TIMEOUT_MS, or 0 when force=true).
 * @returns {Promise<object>} updated credentials object
 */
export async function checkAndRefreshToken(provider, credentials, options = {}) {
  let creds = { ...credentials };
  if (!creds.connectionId && creds.id) {
    creds.connectionId = creds.id;
  }

  const force = options?.force === true;
  const waitTimeoutMs = options.waitTimeoutMs !== undefined
    ? options.waitTimeoutMs
    : (force ? 0 : TOKEN_REFRESH_WAIT_TIMEOUT_MS);

  // ── 1. Regular access-token expiry ────────────────────────────────────────
  if (force || _shouldRefreshCredentials(provider, creds)) {
    const expiresAt = creds.expiresAt ? new Date(creds.expiresAt).getTime() : null;
    const remaining = expiresAt ? expiresAt - Date.now() : null;
    const refreshLead = _getRefreshLeadMs(provider);

    log.info("TOKEN_REFRESH", "Refreshing provider credentials proactively", {
      provider,
      expiresIn: remaining === null ? null : Math.round(remaining / 1000),
      refreshLeadMs: refreshLead,
      lastRefreshAt: creds.lastRefreshAt || null,
    });

    const refreshPromise = _refreshProviderCredentials(provider, creds, log);
    const { timedOut, value: newCreds } = await withBoundedWait(refreshPromise, waitTimeoutMs);

    // Timed out waiting for an in-flight refresh: fail open with existing creds.
    // The in-flight refresh does NOT persist itself, so we attach a continuation
    // that persists its late result once it eventually resolves. Otherwise the
    // fresh tokens (and any rotated refresh token) would be lost.
    if (timedOut) {
      log.warn("TOKEN_REFRESH", "Timed out waiting for in-flight refresh, using existing credentials", {
        provider,
        connectionId: creds.connectionId,
        waitTimeoutMs,
      });

      refreshPromise
        .then(async (lateCreds) => {
          if (!(lateCreds?.accessToken || lateCreds?.apiKey || lateCreds?.copilotToken)) return;
          const mergedLate = { ...lateCreds, existingProviderSpecificData: creds.providerSpecificData };
          await updateProviderCredentials(creds.connectionId, mergedLate);
          _refreshProjectId(provider, creds.connectionId, lateCreds.accessToken);
        })
        .catch((err) => {
          log.debug("TOKEN_REFRESH", "Late in-flight refresh failed to persist", {
            provider, connectionId: creds.connectionId, error: err?.message ?? String(err),
          });
        });
      return creds;
    }

    if (newCreds?.accessToken || newCreds?.apiKey || newCreds?.copilotToken) {
      const mergedCreds = {
        ...newCreds,
        existingProviderSpecificData: creds.providerSpecificData,
      };

      // Persist to DB (non-blocking path continues below)
      await updateProviderCredentials(creds.connectionId, mergedCreds);

      creds = {
        ...creds,
        ...newCreds,
        expiresAt: newCreds.expiresIn
          ? toExpiresAt(newCreds.expiresIn)
          : normalizeExpiresAt(newCreds.expiresAt) || newCreds.expiresAt || creds.expiresAt,
        providerSpecificData: newCreds.providerSpecificData
          ? { ...creds.providerSpecificData, ...newCreds.providerSpecificData }
          : creds.providerSpecificData,
      };

      // Non-blocking: refresh projectId with the new access token
      _refreshProjectId(provider, creds.connectionId, creds.accessToken);
    }
  }

  // ── 2. GitHub Copilot token expiry ────────────────────────────────────────
  if (provider === "github") {
    const copilotToken = creds.providerSpecificData?.copilotToken;
    const copilotExpiresAt = creds.providerSpecificData?.copilotTokenExpiresAt
      ? creds.providerSpecificData.copilotTokenExpiresAt * 1000
      : 0;
    const now              = Date.now();
    const remaining        = copilotExpiresAt - now;

    if (!copilotToken || remaining < TOKEN_EXPIRY_BUFFER_MS) {
      log.info("TOKEN_REFRESH", "Copilot token expiring soon or missing, refreshing proactively", {
        provider,
        expiresIn: copilotToken ? Math.round(remaining / 1000) : "missing",
      });

      const copilotPromise = refreshCopilotToken(creds.accessToken);
      const { timedOut, value: copilotTokenResult } = await withBoundedWait(copilotPromise, waitTimeoutMs);

      // Timed out: keep the existing copilot token and persist the late result
      // once the in-flight refresh resolves (the refresh does not persist itself).
      if (timedOut) {
        log.warn("TOKEN_REFRESH", "Timed out waiting for Copilot token refresh, using existing token", {
          provider,
          connectionId: creds.connectionId,
          waitTimeoutMs,
        });

        copilotPromise
          .then(async (lateCopilot) => {
            if (!lateCopilot) return;
            const updatedSpecific = {
              ...creds.providerSpecificData,
              copilotToken: lateCopilot.token,
              copilotTokenExpiresAt: lateCopilot.expiresAt,
            };
            await updateProviderCredentials(creds.connectionId, { providerSpecificData: updatedSpecific });
          })
          .catch((err) => {
            log.debug("TOKEN_REFRESH", "Late Copilot refresh failed to persist", {
              provider, connectionId: creds.connectionId, error: err?.message ?? String(err),
            });
          });
      } else if (copilotTokenResult) {
        const updatedSpecific = {
          ...creds.providerSpecificData,
          copilotToken:          copilotTokenResult.token,
          copilotTokenExpiresAt: copilotTokenResult.expiresAt,
        };

        await updateProviderCredentials(creds.connectionId, {
          providerSpecificData: updatedSpecific,
        });

        creds.providerSpecificData = updatedSpecific;
        creds.copilotToken = copilotTokenResult.token;
      }
    }
  }

  return creds;
}

// ─── Local-specific: combined GitHub + Copilot refresh ───────────────────────

/**
 * Refresh the GitHub OAuth token and immediately exchange it for a fresh
 * Copilot token.
 *
 * @param {object} credentials  – must contain `refreshToken`
 * @returns {Promise<object|null>} merged credentials or the raw GitHub credentials on Copilot failure
 */
export async function refreshGitHubAndCopilotTokens(credentials) {
  const newGitHubCreds = await refreshGitHubToken(credentials.refreshToken);
  if (!newGitHubCreds?.accessToken) return newGitHubCreds;

  const copilotToken = await refreshCopilotToken(newGitHubCreds.accessToken);
  if (!copilotToken) return newGitHubCreds;

  return {
    ...newGitHubCreds,
    providerSpecificData: {
      copilotToken:          copilotToken.token,
      copilotTokenExpiresAt: copilotToken.expiresAt,
    },
  };
}
