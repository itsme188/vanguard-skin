import { db } from "@/lib/db";
import { findEmailCandidates } from "@/lib/calendar/enrichment-runner";
import {
  sendEarningsPreview,
  sendEarningsRecap,
  EarningsEmailError,
} from "@/lib/digest/send-earnings-email";
import { withCronAuth } from "@/lib/cron/wrappers";

export const dynamic = "force-dynamic";

interface SweepCandidateResult {
  eventId: number;
  symbol: string;
  phase: "preview" | "recap";
  ok: boolean;
  status?: number;
  message?: string;
  durationMs: number;
}

/**
 * POST /api/cron/earnings-sweep — Top-level Phase-3 driver.
 *
 * Auth: X-Cron-Secret. No body. Called every 15 min by
 * scripts/enrich-calendar-events.sh after the enrich call.
 *
 * Finds preview candidates (release window opening in 105-135 min) and
 * recap candidates (enriched_at within last 4h) for held-or-watchlist
 * symbols, dispatches each to the composer in-process. Composer writes
 * the audit row on success — that's the dedup floor that prevents the
 * next 15-min tick from re-firing.
 *
 * Returns a per-candidate report so the shell-script log shows what
 * fired, what was skipped, and timing.
 */
export async function POST(request: Request) {
  return withCronAuth(request, async () => {
    const candidates = findEmailCandidates(db);
    const results: SweepCandidateResult[] = [];

    for (const cand of candidates) {
      const t0 = Date.now();
      try {
        if (cand.phase === "preview") {
          await sendEarningsPreview(db, cand.eventId);
        } else {
          await sendEarningsRecap(db, cand.eventId);
        }
        results.push({
          eventId: cand.eventId,
          symbol: cand.symbol,
          phase: cand.phase,
          ok: true,
          durationMs: Date.now() - t0,
        });
      } catch (err) {
        const status = err instanceof EarningsEmailError ? err.status : 500;
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          eventId: cand.eventId,
          symbol: cand.symbol,
          phase: cand.phase,
          ok: false,
          status,
          message,
          durationMs: Date.now() - t0,
        });
      }
    }

    return {
      swept: candidates.length,
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  });
}
