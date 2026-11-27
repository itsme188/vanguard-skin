import { db } from "@/lib/db";
import {
  refreshVanguardHoldingsFromPlaid,
  plaidRefreshBlocker,
  plaidSyncUnavailableMessage,
} from "@/lib/plaid/refresh";

/**
 * The in-app "Sync Vanguard (Plaid)" read. Forced: it bypasses only the
 * once-a-day gate; a closed market or a read at or after 09:30 Eastern still
 * stores nothing and says why (plan v4 A2, A3).
 *
 * Answer: `{ success: true, data }` with the refresh result. Its three
 * readers (`PlaidSyncButton.tsx`, `PlaidSection.tsx`, the re-auth page
 * `app/dashboard/plaid-link/page.tsx`) all word it through
 * `lib/ui/plaid-sync-message.ts`.
 */
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
    return Response.json({ success: true, data: result });
  } catch (err) {
    return Response.json(
      { success: false, error: err instanceof Error ? err.message : "Plaid sync failed" },
      { status: 500 },
    );
  }
}
