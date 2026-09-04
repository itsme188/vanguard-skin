import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { validatePublicUrl } from "@/lib/print-watch/ssrf";
import { upsertPrintWatchSource, deletePrintWatchSource, getPrintWatchSource } from "@/lib/print-watch/store";

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
 *
 * `symbol` is validated the same way and for the same reason: it is the
 * PRIMARY KEY of `print_watch_sources` and the key every lane re-reads the row
 * by (`getPrintWatchSource(db, print.symbol)`), so a stored "AC ME" is a row
 * nothing will ever look up again — a configuration the desk believes it made
 * and that silently does nothing at 16:05.
 */

/** Ticker shape after trim/uppercase: letters, digits, dot, hyphen (BRK.B,
 *  RDS-A), 1–12 characters. Deliberately narrower than "any string" and wider
 *  than plain A–Z. */
const SYMBOL_RE = /^[A-Z0-9.\-]{1,12}$/;

/**
 * GET /api/print-watch/sources?symbol=XMPL1 — what is stored for one symbol.
 *
 * A PURE read (`getPrintWatchSource` is a single SELECT), so the
 * no-state-changing-GET guard stays satisfied. It exists because the PUT below
 * treats an empty `irPageUrl` as CLEAR: without a read, the first UI for this
 * route (slice F's IrPageField) would open with an empty box over a configured
 * row and erase it on the first Save. Returns `null` — not a 404 — for a symbol
 * with nothing stored: "nothing configured" is an ordinary answer, not a
 * missing resource.
 */
export async function GET(request: NextRequest) {
  try {
    const raw = new URL(request.url).searchParams.get("symbol");
    if (typeof raw !== "string" || !raw.trim()) {
      return NextResponse.json({ success: false, error: "Query param 'symbol' is required." }, { status: 400 });
    }
    const symbol = raw.trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) {
      return NextResponse.json(
        {
          success: false,
          error: "Query param 'symbol' must be a ticker (letters, digits, '.' or '-', up to 12 characters).",
        },
        { status: 400 },
      );
    }
    const row = getPrintWatchSource(db, symbol);
    return NextResponse.json({
      success: true,
      data: row
        ? { symbol: row.symbol, irPageUrl: row.ir_page_url, linkMustContain: row.link_must_contain }
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

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
    if (!SYMBOL_RE.test(symbol)) {
      return NextResponse.json(
        {
          success: false,
          error: "Body field 'symbol' must be a ticker (letters, digits, '.' or '-', up to 12 characters).",
        },
        { status: 400 },
      );
    }
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
