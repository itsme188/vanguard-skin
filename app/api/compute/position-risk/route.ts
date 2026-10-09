import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computePositionRisk } from "@/lib/compute/risk";
import { resolveScope } from "@/lib/queries/accounts";
import { weekAgo, todayET } from "@/lib/calendar/date-utils";

/**
 * Position-risk W-o-W shape:
 *   { data, weekAgo, delta: null }
 *
 * Per-position rebalancing is too complex to flatten into a single top-level
 * delta object — symbols can enter/exit the top-N between snapshots, and each
 * row has its own riskContribution / weight / vol that the UI may want to diff.
 * The WeekOverWeekBadge integration in D4 computes per-row deltas client-side
 * by matching `now.positions[i].symbol` against `weekAgo.positions[].symbol`.
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

    const now = computePositionRisk(db, { accountIds, topN });
    const past = computePositionRisk(db, { accountIds, topN, asOfDate: wkAgo });

    return NextResponse.json({ success: true, data: now, weekAgo: past, delta: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
