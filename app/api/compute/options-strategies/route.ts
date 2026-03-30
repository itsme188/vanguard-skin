import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOptionPositions } from "@/lib/queries/options";
import { detectStrategies, type PositionLeg } from "@/lib/compute/options-strategy";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const accountId = accountIdParam ? Number(accountIdParam) : undefined;

    const optionPositions = getOptionPositions(db, accountId);

    if (optionPositions.length === 0) {
      return NextResponse.json({ success: true, data: [] });
    }

    // Get stock holdings for strategy detection (covered calls need stock positions)
    const accountFilter = accountId ? "AND h.account_id = ?" : "";
    const params: number[] = [];
    if (accountId) params.push(accountId);

    const stockHoldings = db
      .prepare(
        `SELECT s.symbol, h.quantity, s.security_type,
                (SELECT p.close FROM prices p WHERE p.security_id = s.id
                 ORDER BY p.price_date DESC LIMIT 1) AS current_price
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
         WHERE s.security_type IN ('stock', 'etf')
           AND h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2)
           ${accountFilter}`
      )
      .all(...params) as Array<{
      symbol: string;
      quantity: number;
      security_type: string;
      current_price: number | null;
    }>;

    const positionLegs: PositionLeg[] = [
      ...stockHoldings.map((s) => ({
        symbol: s.symbol,
        underlying: s.symbol,
        securityType: "stock" as const,
        quantity: s.quantity,
        multiplier: 1,
        currentPrice: s.current_price,
      })),
      ...optionPositions.map((o) => ({
        symbol: o.symbol,
        underlying: o.underlying,
        securityType: "option" as const,
        optionType: o.optionType,
        strike: o.strike,
        expiration: o.expiration,
        quantity: o.quantity,
        multiplier: o.multiplier,
        currentPrice: o.currentPrice,
      })),
    ];

    const strategies = detectStrategies(positionLegs);

    return NextResponse.json({ success: true, data: strategies });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
