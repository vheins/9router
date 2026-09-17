import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// Spy on fetchPublic (the SSRF-hardened fetch) while keeping the REAL
// assertPublicUrl/assertPublicUrlResolved so the client-override rejection path
// is exercised for real.
const { fetchPublicMock } = vi.hoisted(() => ({ fetchPublicMock: vi.fn() }));

vi.mock("../../src/shared/utils/ssrfGuard.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchPublic: fetchPublicMock };
});

import { resolveBaseUrl, buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";

const CONFIG = { id: "searxng", baseUrl: "https://searxng.example.com" };

const SEARXNG_CONFIG = {
  id: "searxng",
  baseUrl: "http://searxng:8080/search",
  method: "GET",
  authType: "none",
  searchTypes: ["web", "news"],
  defaultMaxResults: 5,
  maxMaxResults: 50,
  timeoutMs: 10000,
  costPerQuery: 0,
};

const SEARXNG_RESPONSE = { results: [{ title: "t", url: "https://result.example.com", content: "c" }] };

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("resolveBaseUrl SSRF guard", () => {
  it("uses provider default when no override", () => {
    expect(resolveBaseUrl(CONFIG, {})).toEqual({
      baseUrl: "https://searxng.example.com",
      clientControlled: false,
    });
  });

  it("allows public https override", () => {
    const params = { providerOptions: { baseUrl: "https://my-searxng.example.com" } };
    expect(resolveBaseUrl(CONFIG, params)).toEqual({
      baseUrl: "https://my-searxng.example.com",
      clientControlled: true,
    });
  });

  it("allows public http override", () => {
    const params = { providerOptions: { baseUrl: "http://searxng.example.net" } };
    expect(resolveBaseUrl(CONFIG, params)).toEqual({
      baseUrl: "http://searxng.example.net",
      clientControlled: true,
    });
  });

  it("rejects loopback override", () => {
    const params = { providerOptions: { baseUrl: "http://127.0.0.1:18999" } };
    expect(() => resolveBaseUrl(CONFIG, params)).toThrow();
  });

  it("rejects private IP override", () => {
    for (const ip of ["10.0.0.1", "192.168.1.1", "172.16.0.1"]) {
      const params = { providerOptions: { baseUrl: `http://${ip}` } };
      expect(() => resolveBaseUrl(CONFIG, params), `should reject ${ip}`).toThrow();
    }
  });

  it("rejects localhost hostname override", () => {
    const params = { providerOptions: { baseUrl: "http://localhost:8080" } };
    expect(() => resolveBaseUrl(CONFIG, params)).toThrow();
  });

  it("rejects cloud metadata override", () => {
    const params = { providerOptions: { baseUrl: "http://169.254.169.254/latest/meta-data" } };
    expect(() => resolveBaseUrl(CONFIG, params)).toThrow();
  });

  it("rejects non-http protocols", () => {
    for (const proto of ["file:///etc/passwd", "gopher://127.0.0.1:70", "ftp://10.0.0.1"]) {
      const params = { providerOptions: { baseUrl: proto } };
      expect(() => resolveBaseUrl(CONFIG, params), `should reject ${proto}`).toThrow();
    }
  });

  it("does NOT reject an admin/env internal baseUrl (no override)", () => {
    // The provider's own baseUrl is admin-controlled and may be an internal
    // Docker host — resolveBaseUrl must not SSRF-block it.
    expect(resolveBaseUrl({ id: "searxng", baseUrl: "http://searxng:8080/search" }, {})).toEqual({
      baseUrl: "http://searxng:8080/search",
      clientControlled: false,
    });
  });
});

describe("buildSearchRequest trust flag", () => {
  it("marks admin/env baseUrl as trusted (no client override)", () => {
    const req = buildSearchRequest(SEARXNG_CONFIG, { query: "q", searchType: "web", maxResults: 5 });
    expect(req.trusted).toBe(true);
    expect(req.url).toBe("http://searxng:8080/search?q=q&format=json&categories=general");
  });

  it("marks a client baseUrl override as untrusted", () => {
    const req = buildSearchRequest(SEARXNG_CONFIG, {
      query: "q",
      searchType: "web",
      maxResults: 5,
      providerOptions: { baseUrl: "https://example.com/search" },
    });
    expect(req.trusted).toBe(false);
  });

  it("ignores a client-supplied `trusted` field in provider options", () => {
    // A client cannot inject a trust flag: it is derived from override presence
    // only. Here the injected `trusted:true` is irrelevant — the internal client
    // override is rejected outright by assertPublicUrl regardless.
    expect(() =>
      buildSearchRequest(SEARXNG_CONFIG, {
        query: "q",
        searchType: "web",
        maxResults: 5,
        providerOptions: { trusted: true, baseUrl: "http://localhost:8888/search" },
      })
    ).toThrow(/Blocked URL: internal host/);
  });
});

describe("handleSearchCore fetch trust routing", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchPublicMock.mockReset();
    fetchPublicMock.mockImplementation(async () => jsonResponse(SEARXNG_RESPONSE));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("(a) uses plain fetch and NOT fetchPublic for admin/env baseUrl", async () => {
    const plainFetch = vi.fn(async () => jsonResponse(SEARXNG_RESPONSE));
    global.fetch = plainFetch;

    const result = await handleSearchCore({
      body: { query: "hello" },
      provider: { id: "searxng" },
      providerConfig: SEARXNG_CONFIG,
      credentials: null,
    });

    expect(result.success).toBe(true);
    expect(plainFetch).toHaveBeenCalledTimes(1);
    expect(plainFetch.mock.calls[0][0]).toBe(
      "http://searxng:8080/search?q=hello&format=json&categories=general"
    );
    expect(fetchPublicMock).not.toHaveBeenCalled();
  });

  it("(b) rejects a client override to an internal host with the SSRF error", async () => {
    const plainFetch = vi.fn();
    global.fetch = plainFetch;

    const result = await handleSearchCore({
      body: { query: "hello", provider_options: { baseUrl: "http://localhost:8888/search" } },
      provider: { id: "searxng" },
      providerConfig: SEARXNG_CONFIG,
      credentials: null,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/Blocked URL: internal host/);
    expect(fetchPublicMock).not.toHaveBeenCalled();
    expect(plainFetch).not.toHaveBeenCalled();
  });

  it("(c) routes a client override to a PUBLIC url through fetchPublic", async () => {
    const plainFetch = vi.fn();
    global.fetch = plainFetch;

    const result = await handleSearchCore({
      body: { query: "hello", provider_options: { baseUrl: "https://example.com/search" } },
      provider: { id: "searxng" },
      providerConfig: SEARXNG_CONFIG,
      credentials: null,
    });

    expect(result.success).toBe(true);
    expect(fetchPublicMock).toHaveBeenCalledTimes(1);
    expect(fetchPublicMock.mock.calls[0][0]).toBe(
      "https://example.com/search?q=hello&format=json&categories=general"
    );
    expect(plainFetch).not.toHaveBeenCalled();
  });
});
