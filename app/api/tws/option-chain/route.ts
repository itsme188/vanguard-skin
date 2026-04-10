import { NextRequest, NextResponse } from "next/server";
import { getIbApi } from "@/lib/tws/client";
import { db } from "@/lib/db";
import { SecType } from "@stoqey/ib";

/**
 * GET /api/tws/option-chain?symbol=AAPL
 *
 * Fetches available option expirations and strikes for a symbol via TWS.
 * Returns chain structure only (not live prices — avoids rate limits).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol");

    if (!symbol) {
      return NextResponse.json(
        { success: false, error: "symbol parameter required" },
        { status: 400 }
      );
    }

    const api = getIbApi();
    if (!api) {
      return NextResponse.json(
        { success: false, error: "TWS not connected" },
        { status: 503 }
      );
    }

    // Look up conId from securities table, or resolve via contract details
    const sec = db
      .prepare(
        "SELECT ib_con_id FROM securities WHERE symbol = ? AND LOWER(security_type) != 'option' LIMIT 1"
      )
      .get(symbol) as { ib_con_id: number | null } | undefined;

    let conId = sec?.ib_con_id;

    if (!conId) {
      // Try to resolve via contract details
      try {
        const details = await api.getContractDetails({
          symbol: symbol.toUpperCase(),
          secType: SecType.STK,
          exchange: "SMART",
          currency: "USD",
        });

        if (details && details.length > 0) {
          conId = details[0].contract.conId;
        }
      } catch {
        // Fall through with null conId
      }
    }

    if (!conId) {
      return NextResponse.json(
        { success: false, error: `Could not resolve contract for ${symbol}` },
        { status: 404 }
      );
    }

    // Fetch option chain definition
    const chainDefs = await api.getSecDefOptParams(
      symbol.toUpperCase(),
      "",
      SecType.STK,
      conId
    );

    if (!chainDefs || chainDefs.length === 0) {
      return NextResponse.json({
        success: true,
        data: { symbol, expirations: [], strikes: [], exchanges: [] },
      });
    }

    // Merge results from all exchanges
    const allExpirations = new Set<string>();
    const allStrikes = new Set<number>();
    const exchanges: string[] = [];

    for (const def of chainDefs) {
      exchanges.push(def.exchange);
      if (def.expirations) {
        for (const exp of def.expirations) {
          // Convert YYYYMMDD to YYYY-MM-DD
          const formatted =
            exp.length === 8
              ? `${exp.slice(0, 4)}-${exp.slice(4, 6)}-${exp.slice(6, 8)}`
              : exp;
          allExpirations.add(formatted);
        }
      }
      if (def.strikes) {
        for (const strike of def.strikes) {
          allStrikes.add(strike);
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        symbol,
        conId,
        expirations: Array.from(allExpirations).sort(),
        strikes: Array.from(allStrikes).sort((a, b) => a - b),
        exchanges: [...new Set(exchanges)],
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
