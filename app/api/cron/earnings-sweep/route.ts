import { db } from "@/lib/db";
import { runEarningsEmailSweep } from "@/lib/calendar/email-sweep";
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
 */
export async function POST(request: Request) {
  return withCronAuth(request, async () => runEarningsEmailSweep(db));
}
