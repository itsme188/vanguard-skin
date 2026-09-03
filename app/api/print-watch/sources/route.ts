import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validatePublicUrl } from "@/lib/print-watch/ssrf";
import { upsertPrintWatchSource, deletePrintWatchSource } from "@/lib/print-watch/store";

export const dynamic = "force-dynamic";

/**
 * PUT /api/print-watch/sources — the desk's stored IR newsroom page for one
 * symbol (slice B, spec §4.2 "Stored IR page").
 *
 * Body: `{ symbol, irPageUrl, linkMustContain? }`. An EMPTY `irPageUrl`
 * clears the stored page — one control, two directions, so the Hub row never
 * needs a separate delete verb (and `data.cleared` says honestly whether a
 * row was actually removed).
 *
 * A HUMAN route by the proxy's default classification (session + CSRF +
 * trusted Origin on unsafe methods): it takes no cron secret and no Electron
 * credential, so it deliberately has no `lib/auth/route-policy.ts` entry —
 * `classifyRoute()` returns "human" for anything not carved out.
 *
 * Thin, per the API pattern: validate → SSRF contract → store. `irPageUrl` is
 * fetched later by the `ir_baseline` step and the watcher, both of which
 * re-validate on every hop; validating HERE is what makes a bad paste a
 * visible 400 at the desk instead of a silent lane failure at 16:05.
 */
export async function PUT(request: NextRequest) {
  try {
    let body: { symbol?: unknown; irPageUrl?: unknown; linkMustContain?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ success: false, error: "Body must be valid JSON." }, { status: 400 });
    }
    if (typeof body?.symbol !== "string" || !body.symbol.trim()) {
      return NextResponse.json(
        { success: false, error: "Body field 'symbol' is required." },
        { status: 400 },
      );
    }
    if (typeof body.irPageUrl !== "string") {
      return NextResponse.json(
        { success: false, error: "Body field 'irPageUrl' is required (empty string clears it)." },
        { status: 400 },
      );
    }
    const symbol = body.symbol.trim().toUpperCase();
    if (body.irPageUrl.trim() === "") {
      return NextResponse.json({
        success: true,
        data: { symbol, cleared: deletePrintWatchSource(db, symbol) },
      });
    }
    const irPageUrl = body.irPageUrl.trim();
    const verdict = validatePublicUrl(irPageUrl);
    if (!verdict.ok) {
      return NextResponse.json({ success: false, error: `IR page: ${verdict.reason}` }, { status: 400 });
    }
    const linkMustContain =
      typeof body.linkMustContain === "string" && body.linkMustContain.trim()
        ? body.linkMustContain.trim()
        : null;
    const row = upsertPrintWatchSource(db, { symbol, irPageUrl, linkMustContain });
    return NextResponse.json({ success: true, data: row });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
