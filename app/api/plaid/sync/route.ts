import { db } from "@/lib/db";
import {
  refreshVanguardHoldingsFromPlaid,
  plaidRefreshBlocker,
  plaidSyncUnavailableMessage,
} from "@/lib/plaid/refresh";

export async function POST() {
  try {
    const result = await refreshVanguardHoldingsFromPlaid(db, { force: true });
    if (result === null) {
      // The refresh returns null for four different causes; name the one
      // that applies instead of listing two guesses.
      return Response.json({
        success: false,
        error: plaidSyncUnavailableMessage(plaidRefreshBlocker(db)),
      });
    }
    return Response.json({ success: true, ...result });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Plaid sync failed" },
      { status: 500 },
    );
  }
}
