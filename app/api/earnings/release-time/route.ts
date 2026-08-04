import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  resolveSymbolReleaseTime,
  upsertSymbolReleaseTime,
  clearUserReleaseTime,
  getSymbolReleaseTimeRow,
  getObservationsForFamily,
  applyResolvedReleaseTimeToUpcomingEvents,
  EARLIEST_PLAUSIBLE_ET,
  LATEST_PLAUSIBLE_ET,
  OBSERVATION_LOOKBACK_DAYS,
} from "@/lib/earnings/wire-times";

export const dynamic = "force-dynamic";

/**
 * GET /api/earnings/release-time?symbol=XMTR&slot=bmo|amc — read the wire-time
 * resolution cascade state for a symbol: the resolved time+source, any
 * standing override row, and its observation history.
 *
 * POST /api/earnings/release-time — body { symbol, releaseTime: "HH:MM" | null }.
 * A non-null releaseTime writes a 'user' override (source='user' always wins
 * the PK-row precedence in upsertSymbolReleaseTime); null clears a 'user' row
 * only (clearUserReleaseTime never touches a 'web_verified' row). Both paths
 * re-resolve release_time on the symbol's untouched upcoming earnings rows via
 * applyResolvedReleaseTimeToUpcomingEvents so the chip's own event reflects
 * the change without waiting for the next enrichment tick.
 *
 * Thin — validation + composition only; the cascade semantics live in
 * lib/earnings/wire-times.ts. In-app only (no cron auth — same family as
 * confirm-date/correct-date).
 */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol")?.trim().toUpperCase();
  const slotRaw = req.nextUrl.searchParams.get("slot");
  const slot = slotRaw === "bmo" || slotRaw === "amc" ? slotRaw : null;
  if (!symbol) {
    return NextResponse.json({ success: false, error: "symbol is required" }, { status: 400 });
  }
  const since = new Date(Date.now() - OBSERVATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return NextResponse.json({
    success: true,
    data: {
      symbol,
      resolved: resolveSymbolReleaseTime(db, symbol, slot),
      override: getSymbolReleaseTimeRow(db, symbol),
      observations: getObservationsForFamily(db, symbol, since),
    },
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { symbol?: string; releaseTime?: string | null }
    | null;
  const symbol = body?.symbol?.trim().toUpperCase();
  if (!symbol) {
    return NextResponse.json({ success: false, error: "symbol is required" }, { status: 400 });
  }
  if (body?.releaseTime == null) {
    const cleared = clearUserReleaseTime(db, symbol);
    const updatedEvents = cleared ? applyResolvedReleaseTimeToUpcomingEvents(db, symbol) : 0;
    return NextResponse.json({ success: true, data: { cleared, updatedEvents } });
  }
  const t = body.releaseTime;
  // Shape + clock-value validation BEFORE the plausible-window range check:
  // the regex alone only confirms "two digits, colon, two digits" — it
  // admits "10:99" (99 is not a valid minute). A plain string compare
  // against EARLIEST/LATEST_PLAUSIBLE_ET does NOT catch that either, because
  // "10:99" sorts between "04:00" and "20:00" lexicographically despite
  // being an invalid time. Parse and bound hours [0,23] / minutes [0,59]
  // first — only THEN is a zero-padded "HH:MM" guaranteed to sort correctly
  // as a real time-of-day, which is what makes the subsequent string
  // range-compare against EARLIEST_PLAUSIBLE_ET/LATEST_PLAUSIBLE_ET valid.
  const match = /^(\d{2}):(\d{2})$/.exec(t);
  const hh = match ? Number(match[1]) : NaN;
  const mm = match ? Number(match[2]) : NaN;
  const isValidClockTime = match !== null && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
  if (!isValidClockTime) {
    return NextResponse.json(
      { success: false, error: "releaseTime must be a valid 24-hour HH:MM time (e.g. 07:30)" },
      { status: 400 },
    );
  }
  if (t < EARLIEST_PLAUSIBLE_ET || t > LATEST_PLAUSIBLE_ET) {
    return NextResponse.json(
      {
        success: false,
        error: `releaseTime must be HH:MM ET between ${EARLIEST_PLAUSIBLE_ET} and ${LATEST_PLAUSIBLE_ET}`,
      },
      { status: 400 },
    );
  }
  upsertSymbolReleaseTime(db, { symbol, releaseTime: t, source: "user", note: "set in app" });
  const updatedEvents = applyResolvedReleaseTimeToUpcomingEvents(db, symbol);
  return NextResponse.json({ success: true, data: { updatedEvents } });
}
