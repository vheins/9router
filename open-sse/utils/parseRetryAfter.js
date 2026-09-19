/**
 * Provider retry/reset time parsing — shared by every fallback path.
 *
 * Providers report "when will this be usable again" in a handful of shapes:
 *
 *   - Google/Antigravity 429: "Individual quota reached. Resets in 165h26m22s."
 *   - Kiro rate limit:       "Too many requests, please wait before trying again."
 *   - Codex usage_limit:     "usage_limit_reached ... resets_at 2026-09-20T10:00:00Z"
 *   - Generic:               "rate limit exceeded, retry after 30s"
 *   - HTTP header:           Retry-After: 120  |  Retry-After: Wed, 21 Oct 2026 07:28:00 GMT
 *
 * When a concrete, future reset moment is present the caller should keep the
 * account/model OFF until then instead of re-probing on a short generic
 * cooldown. This module centralizes that extraction so the chat path, the
 * account-fallback engine, and the Antigravity quota handler all agree.
 *
 * Every function is pure and defensive: unparseable input yields null, never a
 * throw — a malformed upstream message must not break the request path.
 */

// Hard bounds so a bogus upstream value can neither disable a credential
// forever nor be mistaken for "no data".
export const MIN_RESET_COOLDOWN_MS = 5_000;             // 5s
export const MAX_RESET_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Parse a human duration like "165h26m22s", "2m 30s", "45s", "1h" into ms.
 *
 * Accepts optional spaces and any subset/order of h/m/s units. Returns null
 * when no unit is present (a bare number is NOT treated as seconds here — that
 * shape is handled by the Retry-After header parser).
 *
 * @param {string} text
 * @returns {number|null} duration in ms, or null
 */
export function parseDurationToMs(text) {
  if (!text || typeof text !== "string") return null;
  // Unit must not be followed by another letter (so "26m22s" splits at "m"
  // before the digit of the next segment). Using a lookahead instead of \b
  // because \b fails between two word chars ("m" → "2").
  const re = /(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s|days|day|d)(?![a-z])/gi;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = Number(m[1]);
    if (!Number.isFinite(value)) continue;
    const unit = m[2].toLowerCase();
    let factor;
    if (unit.startsWith("d")) factor = 24 * 60 * 60 * 1000;
    else if (unit.startsWith("h")) factor = 60 * 60 * 1000;
    else if (unit.startsWith("m")) factor = 60 * 1000;
    else factor = 1000; // seconds
    total += value * factor;
    matched = true;
  }
  return matched ? total : null;
}

/**
 * Extract an absolute reset moment (epoch ms) from an error message.
 *
 * Recognized shapes (case-insensitive):
 *   - "resets in 165h26m22s"          → now + duration
 *   - "reset after 2m"                → now + duration
 *   - "retry after 30s"               → now + duration
 *   - "resets_at 2026-09-20T10:00:00Z"→ absolute
 *   - "available at 2026-09-20 10:00:00 UTC" → absolute
 *   - "until 2026-09-20T10:00:00Z"    → absolute
 *
 * Returns null when nothing usable is found. Absolute timestamps must be in the
 * future (small clock-skew allowance) to be accepted.
 *
 * @param {string} errorText
 * @param {number} [nowMs]
 * @returns {number|null} epoch ms
 */
export function parseResetTimeFromMessage(errorText, nowMs = Date.now()) {
  if (!errorText || typeof errorText !== "string") return null;
  const text = errorText.toLowerCase();
  const minMs = nowMs - 60 * 1000;
  const maxMs = nowMs + MAX_RESET_COOLDOWN_MS;

  // 1) Relative durations: "resets in X", "reset after X", "retry after X".
  const relative = [
    /(?:resets?|reset|retry|try)\s+(?:in|after)\s+([0-9hms.\s]+?)(?:[.,;)]|$)/i,
    /(?:resets?|reset|retry|try)\s+in\s+([0-9hms.\s]+?)(?:[.,;)]|$)/i,
  ];
  for (const re of relative) {
    const m = text.match(re);
    if (m && m[1]) {
      const dur = parseDurationToMs(m[1]);
      if (dur !== null && dur > 0) {
        const at = nowMs + dur;
        if (at > minMs && at < maxMs) return at;
      }
    }
  }

  // 2) Absolute timestamps after a keyword.
  const absolute = [
    /(?:resets?_?at|available|until|at)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(?:z|utc|gmt)?/i,
    /(?:resets?_?at|available|until|at)\s*[:=]?\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s*(?:z|utc|gmt)?/i,
    /(?:resets?_?at|available|until)\s*[:=]?\s*(\d{10,13})/i,
  ];
  for (const re of absolute) {
    const m = text.match(re);
    if (!m || !m[1]) continue;
    const raw = m[1];
    if (/^\d{10,13}$/.test(raw)) {
      const n = Number(raw);
      const ms = raw.length === 10 ? n * 1000 : n;
      if (ms > minMs && ms < maxMs) return ms;
      continue;
    }
    const iso = raw.replace(/\//g, "-").replace(/\s+/, "T").replace(/t/, "T").replace(/z$/i, "");
    const parsed = new Date(`${iso}Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > minMs && parsed.getTime() < maxMs) {
      return parsed.getTime();
    }
  }

  return null;
}

/**
 * Parse an HTTP `Retry-After` header value into an absolute epoch ms.
 * Accepts a delta-seconds integer or an HTTP-date.
 *
 * @param {string|number|null} value
 * @param {number} [nowMs]
 * @returns {number|null} epoch ms, or null
 */
export function parseRetryAfterHeader(value, nowMs = Date.now()) {
  if (value === null || value === undefined || value === "") return null;

  // Delta seconds (integer or float).
  const asNum = Number(value);
  if (Number.isFinite(asNum) && asNum >= 0) {
    const at = nowMs + asNum * 1000;
    if (at > nowMs - 60_000 && at < nowMs + MAX_RESET_COOLDOWN_MS) return at;
    return null;
  }

  // HTTP-date.
  const parsed = new Date(String(value));
  if (!Number.isNaN(parsed.getTime())) {
    const at = parsed.getTime();
    if (at > nowMs - 60_000 && at < nowMs + MAX_RESET_COOLDOWN_MS) return at;
  }
  return null;
}

/**
 * Combine every available signal into a single "usable again at" epoch ms.
 * Message text wins over the Retry-After header (it is usually more specific),
 * then the header, then an explicit resetsAtMs supplied by the caller.
 *
 * @param {{ errorText?: string, retryAfter?: string|number|null, resetsAtMs?: number|null, nowMs?: number }} args
 * @returns {number|null}
 */
export function resolveResetAt({ errorText, retryAfter, resetsAtMs, nowMs = Date.now() } = {}) {
  const fromMessage = parseResetTimeFromMessage(errorText, nowMs);
  if (fromMessage) return fromMessage;

  const fromHeader = parseRetryAfterHeader(retryAfter, nowMs);
  if (fromHeader) return fromHeader;

  if (Number.isFinite(resetsAtMs) && resetsAtMs > nowMs) return resetsAtMs;
  return null;
}

/**
 * Clamp a computed cooldown to the shared bounds.
 *
 * @param {number} ms
 * @returns {number}
 */
export function clampCooldownMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return MIN_RESET_COOLDOWN_MS;
  return Math.max(MIN_RESET_COOLDOWN_MS, Math.min(ms, MAX_RESET_COOLDOWN_MS));
}
