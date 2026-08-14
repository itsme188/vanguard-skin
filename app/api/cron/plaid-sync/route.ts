import { db } from "@/lib/db";
import { refreshVanguardHoldingsFromPlaid } from "@/lib/plaid/refresh";
import { withCronAuth } from "@/lib/cron/wrappers";

export async function POST(request: Request) {
  return withCronAuth(request, async () => {
    const result = await refreshVanguardHoldingsFromPlaid(db);
    if (result === null) {
      // refreshVanguardHoldingsFromPlaid null-gates for three distinct
      // reasons (not connected, credentials not configured, or a sync
      // already in progress) — {success:true, result:null} alone reads as
      // "OK" in the launchd log for what's actually a skipped run. Carry
      // the cause class so the log line is honest about why nothing ran.
      return {
        success: true,
        result: null,
        note: "skipped: not connected, not configured, or another sync in progress",
      };
    }
    return { success: true, result };
  });
}
