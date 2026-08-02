import { db } from "@/lib/db";
import { runEarningsEmailSweep } from "@/lib/calendar/email-sweep";
import { maybeRunDailyDateVerification } from "@/lib/calendar/verify-earnings-dates";
import { withCronAuth } from "@/lib/cron/wrappers";

export const dynamic = "force-dynamic";

/**
 * POST /api/cron/earnings-sweep — Top-level Phase-3 driver.
 *
 * Auth: X-Cron-Secret. No body. Called every 15 min by
 * scripts/enrich-calendar-events.sh after the enrich call.
 *
 * Delegates to runEarningsEmailSweep (lib/calendar/email-sweep.ts), which
 * carries the Mac↔cloud marker dance + candidate windows. The composer's
 * audit row remains the local dedup floor.
 *
 * After the sweep, best-effort runs the once-per-ET-day date-verification
 * pass (maybeRunDailyDateVerification) — its own try/catch so a verification
 * failure never fails the sweep response the caller depends on.
 */
export async function POST(request: Request) {
  return withCronAuth(request, async () => {
    const result = await runEarningsEmailSweep(db);
    try {
      await maybeRunDailyDateVerification(db);
    } catch (err) {
      console.warn("[earnings-sweep] date verification pass failed:", err);
    }
    return result;
  });
}
