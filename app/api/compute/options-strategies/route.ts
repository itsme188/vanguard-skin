import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  detectStrategiesPerAccount,
  getOptionPositions,
  getStockLegsForStrategyDetection,
} from "@/lib/queries/options";
import { resolveScope } from "@/lib/queries/accounts";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const scope = searchParams.get("scope");
    // An explicit accountId is one account. A named scope is its WHOLE id
    // list (resolveScope), never the first account alone. "all" or no scope
    // resolves to undefined: every account.
    const accountScope = accountIdParam ? Number(accountIdParam) : resolveScope(db, scope);

    const optionPositions = getOptionPositions(db, accountScope);

    if (optionPositions.length === 0) {
      return NextResponse.json({ success: true, data: [] });
    }

    // Stock legs via the shared per-(account,security) helper — see lib/queries/options.ts.
    const stockHoldings = getStockLegsForStrategyDetection(db, accountScope);

    // Strategies are detected account by account, never across the scope:
    // shares in one account do not cover a call written in another.
    const strategies = detectStrategiesPerAccount(stockHoldings, optionPositions);

    return NextResponse.json({ success: true, data: strategies });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
