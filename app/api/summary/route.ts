import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getTwsStatus } from "@/lib/tws/client";

/**
 * Lightweight portfolio summary for the Electron tray tooltip.
 * Returns total value, data freshness dates, and TWS state.
 */
export async function GET() {
  try {
    // Latest total portfolio value from daily_valuations
    const valueRow = db
      .prepare(
        `SELECT SUM(total_value) AS total_value, valuation_date
         FROM daily_valuations
         WHERE valuation_date = (SELECT MAX(valuation_date) FROM daily_valuations)`,
      )
      .get() as { total_value: number | null; valuation_date: string | null } | undefined;

    // Data freshness
    const priceRow = db
      .prepare("SELECT MAX(date) AS latest FROM prices")
      .get() as { latest: string | null } | undefined;

    const holdingsRow = db
      .prepare("SELECT MAX(as_of_date) AS latest FROM holdings")
      .get() as { latest: string | null } | undefined;

    // TWS connection state
    const twsStatus = getTwsStatus();

    return NextResponse.json({
      totalValue: valueRow?.total_value ?? null,
      valuationDate: valueRow?.valuation_date ?? null,
      pricesAsOf: priceRow?.latest ?? null,
      holdingsAsOf: holdingsRow?.latest ?? null,
      twsState: twsStatus.state,
    });
  } catch {
    return NextResponse.json({
      totalValue: null,
      valuationDate: null,
      pricesAsOf: null,
      holdingsAsOf: null,
      twsState: "disconnected",
    });
  }
}
