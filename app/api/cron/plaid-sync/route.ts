import { db } from "@/lib/db";
import {
  refreshVanguardHoldingsFromPlaid,
  plaidRefreshBlocker,
  plaidSyncUnavailableMessage,
} from "@/lib/plaid/refresh";
import { withCronAuth } from "@/lib/cron/wrappers";

/**
 * The scheduled Plaid read (launchd `scripts/run-plaid-sync.sh`, 07:30
 * Eastern on weekdays). The request body is ignored: there is no retry flag
 * and no option a caller can set.
 *
 * Answer: `{ success: true, data }` where `data` is the refresh result
 * (`skippedReason`, `session`, `datingState`, `storedAccounts`,
 * `skippedAccounts`, `pricesHeldLegacyAfter`, `valuationsRecomputed`,
 * `valuationError`, the counts). The script logs a one-line summary parsed
 * from it.
 */
export async function POST(request: Request) {
  return withCronAuth(request, async () => {
    const result = await refreshVanguardHoldingsFromPlaid(db);
    if (result === null) {
      // The refresh returns null for four different causes (credentials not
      // set, not connected, no account mapped, another sync running).
      // {success:true, data:null} alone reads as "OK" in the launchd log
      // for what is a skipped run, so name the one that applies. Same gate
      // and same wording as the in-app route (app/api/plaid/sync/route.ts).
      // A null blocker means the cause cleared between the attempt and this
      // read (another sync finished in between). `result: null` is kept for
      // readers of the older answer shape.
      const blocker = plaidRefreshBlocker(db);
      return {
        success: true,
        data: null,
        result: null,
        cause: blocker ?? "cleared_before_read",
        note: `skipped: ${plaidSyncUnavailableMessage(blocker)}`,
      };
    }
    return { success: true, data: result };
  });
}
