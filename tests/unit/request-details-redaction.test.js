import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The route redacts conversation payloads unless the caller presents a valid
// dashboard session (or the install explicitly runs with requireLogin=false).
// These tests exercise the REAL route handler against a temp DB.
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-redact-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });

  await db.saveRequestDetail({
    id: "redact-1",
    provider: "openai",
    model: "gpt-4",
    status: "success",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    request: { messages: [{ role: "user", content: "secret prompt" }] },
    providerRequest: { messages: [{ role: "user", content: "secret prompt" }] },
    providerResponse: { choices: [{ message: { content: "secret answer" } }] },
    response: { content: "secret answer" },
  });
  await new Promise((r) => setTimeout(r, 150));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function loadRoute() {
  return import("@/app/api/usage/request-details/route.js");
}

describe("request-details redaction (real route)", () => {
  it("unauthenticated caller → payloads redacted, metadata kept", async () => {
    const { GET } = await loadRoute();
    const res = await GET(new Request("http://localhost/api/usage/request-details?page=1&pageSize=20"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redacted).toBe(true);
    const d = body.details.find((x) => x.id === "redact-1");
    expect(d).toBeDefined();
    expect(d.model).toBe("gpt-4");
    expect(d.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(d.request).toEqual({ redacted: true });
    expect(d.providerRequest).toEqual({ redacted: true });
    expect(d.providerResponse).toEqual({ redacted: true });
    expect(d.response).toEqual({ redacted: true });
  });

  it("requireLogin=false → payloads returned in full", async () => {
    await db.updateSettings({ requireLogin: false });
    const { GET } = await loadRoute();
    const res = await GET(new Request("http://localhost/api/usage/request-details?page=1&pageSize=20"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redacted).toBeUndefined();
    const d = body.details.find((x) => x.id === "redact-1");
    expect(d.request).toEqual({ messages: [{ role: "user", content: "secret prompt" }] });
    expect(d.response).toEqual({ content: "secret answer" });
    await db.updateSettings({ requireLogin: true });
  });
});
