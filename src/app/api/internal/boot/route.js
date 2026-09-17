// Internal boot trigger — lets the CJS custom-server.js kick off the Next app
// bootstrap (which starts background schedulers: quotaAutoToggle,
// backgroundTokenRefresh, plus tunnel auto-resume / MITM auto-start) at server
// start, without waiting for the first dynamic page render. This module graph is
// bundled by webpack, so `@/` and `open-sse` aliases resolve — unlike a raw
// dynamic import() from custom-server.js.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request) {
  // The custom-server wrapper stamps x-9r-peer-token on every request, so it
  // cannot authenticate the self-fetch. Use a dedicated per-process secret that
  // the wrapper never touches. If unset (bare `next start`), refuse everything.
  const expected = process.env.NINEROUTER_BOOT_TOKEN;
  const provided = request.headers.get("x-9r-boot-token");
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    // bootstrap.js is idempotent (guards on global.__appBootstrapped) and
    // initializeApp() defers the heavy work internally, so this returns fast.
    await import("@/shared/services/bootstrap");
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[InternalBoot] bootstrap failed:", error?.message || error);
    return NextResponse.json(
      { error: error?.message || "bootstrap failed" },
      { status: 500 },
    );
  }
}
