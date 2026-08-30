import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOptionPositions, getStockLegsForStrategyDetection } from "@/lib/queries/options";
import { detectStrategies, type PositionLeg } from "@/lib/compute/options-strategy";
import { resolveScopeToSingleId } from "@/lib/queries/accounts";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const scope = searchParams.get("scope");
    const accountId = accountIdParam ? Number(accountIdParam) : resolveScopeToSingleId(db, scope);

    const optionPositions = getOptionPositions(db, accountId);

    if (optionPositions.length === 0) {
      return NextResponse.json({ success: true, data: [] });
    }

    // Stock legs via the shared per-(account,security) helper — see lib/queries/options.ts.
    const stockHoldings = getStockLegsForStrategyDetection(db, accountId);

    // detectStrategies assumes account-local positions
    // (lib/compute/options-strategy.ts) — group legs by account and
    // concatenate the per-account results.
    const legsByAccount = new Map<number, PositionLeg[]>();
    const pushLeg = (acct: number, leg: PositionLeg) => {
      const legs = legsByAccount.get(acct);
      if (legs) legs.push(leg);
      else legsByAccount.set(acct, [leg]);
    };
    for (const s of stockHoldings) {
      pushLeg(s.account_id, {
        symbol: s.symbol,
        underlying: s.symbol,
        securityType: "stock" as const,
        quantity: s.quantity,
        multiplier: 1,
        currentPrice: s.current_price,
      });
    }
    for (const o of optionPositions) {
      pushLeg(o.accountId, {
        symbol: o.symbol,
        underlying: o.underlying,
        securityType: "option" as const,
        optionType: o.optionType,
        strike: o.strike,
        expiration: o.expiration,
        quantity: o.quantity,
        multiplier: o.multiplier,
        currentPrice: o.currentPrice,
      });
    }

    const strategies = Array.from(legsByAccount.values()).flatMap((legs) =>
      detectStrategies(legs)
    );

    return NextResponse.json({ success: true, data: strategies });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
