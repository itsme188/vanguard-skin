import { db } from "@/lib/db";
import { refreshVanguardHoldingsFromPlaid } from "@/lib/plaid/refresh";

export async function POST() {
  try {
    const result = await refreshVanguardHoldingsFromPlaid(db, { force: true });
    if (result === null) {
      return Response.json({
        success: false,
        error:
          "Plaid is not connected — open Settings → Vanguard Live (Plaid) to connect, or a sync is already running.",
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
