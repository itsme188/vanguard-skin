import { NextRequest, NextResponse } from "next/server";
import type Database from "better-sqlite3";
import { db } from "@/lib/db";
import { computePositionRisk, type PositionRiskResult } from "@/lib/compute/risk";
import { resolveScope } from "@/lib/queries/accounts";
import { weekAgo, todayET } from "@/lib/calendar/date-utils";

/**
 * The card's result: the positions with every cash-equivalent fund left out
 * BEFORE the top N is taken, plus how many were left out.
 */
type CashFreePositionRiskResult = PositionRiskResult & { cashEquivalentsLeftOut: number };

/**
 * Owner ruling (2026-11-16): cash is never ranked as a position. A
 * cash-equivalent fund (computePositionRisk's `cashEquivalent`, which is
 * isCashEquivalentSecurity, the one rule) is left out BEFORE the top N is
 * taken, the same way the "top N by risk" drawer does it
 * (cashFreeTopPositions, lib/queries/drill-down.ts; a test pins that the two
 * list the same rows). computePositionRisk takes its N in SQL, so the ask
 * grows by the funds met until N non-cash positions are in hand or the book
 * runs out. Every figure comes from that one computation's own output; a
 * pairwise correlation that names a cash fund is dropped with it.
 */
function cashFreePositionRisk(
  database: Database.Database,
  opts: { accountIds: number[] | undefined; topN: number; asOfDate?: string }
): CashFreePositionRiskResult {
  const MAX_ASK = 1000;
  let ask = opts.topN;
  for (;;) {
    const result = computePositionRisk(database, { accountIds: opts.accountIds, topN: ask, asOfDate: opts.asOfDate });
    const nonCash = result.positions.filter((p) => !p.cashEquivalent);
    if (nonCash.length >= opts.topN || result.positions.length < ask || ask >= MAX_ASK) {
      const cashSymbols = new Set(result.positions.filter((p) => p.cashEquivalent).map((p) => p.symbol));
      return {
        positions: nonCash.slice(0, opts.topN),
        correlations: result.correlations.filter((c) => !cashSymbols.has(c.symbolA) && !cashSymbols.has(c.symbolB)),
        portfolioVol: result.portfolioVol,
        cashEquivalentsLeftOut: cashSymbols.size,
      };
    }
    ask = Math.min(MAX_ASK, ask + (opts.topN - nonCash.length));
  }
}

/**
 * Position-risk W-o-W shape:
 *   { data, weekAgo, delta: null }
 *
 * Per-position rebalancing is too complex to flatten into a single top-level
 * delta object — symbols can enter/exit the top-N between snapshots, and each
 * row has its own riskContribution / weight / vol that the UI may want to diff.
 * The WeekOverWeekBadge integration in D4 computes per-row deltas client-side
 * by matching `now.positions[i].symbol` against `weekAgo.positions[].symbol`.
 * Both `data` and `weekAgo` leave cash-equivalent funds out (see above).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const scope = searchParams.get("scope");
    // resolveScope, never a first-id collapse: a scope is a SET of accounts.
    const accountIds = accountIdParam ? [Number(accountIdParam)] : resolveScope(db, scope);
    const topNParam = searchParams.get("topN");
    const topN = topNParam ? Number(topNParam) : 10;

    const today = todayET();
    const wkAgo = weekAgo(today);

    const now = cashFreePositionRisk(db, { accountIds, topN });
    const past = cashFreePositionRisk(db, { accountIds, topN, asOfDate: wkAgo });

    return NextResponse.json({ success: true, data: now, weekAgo: past, delta: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
