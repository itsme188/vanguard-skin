import type Database from "better-sqlite3";
import { getBriefingByWeek, isBriefingStale } from "@/lib/queries/calendar";
import { generateWeeklyBriefing } from "@/lib/calendar/briefing";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { sendEmail } from "@/lib/email";
import { addDays, getCurrentMonday, mondayOf } from "@/lib/calendar/date-utils";
import { syncPortfolio } from "@/lib/tws/positions";
import { runAutoRefresh } from "@/lib/tws/auto-refresh";
import { setLastBriefingSentAt } from "@/lib/digest/daily-digest";
import { syncCalendarForWeek } from "@/lib/calendar/sync";
import { getRecipientsFor } from "@/lib/queries/email-recipients";
import { generateNarrative, NARRATIVE_SURFACES } from "@/lib/compute/analysis-narratives";
import { refreshModelCatalog } from "@/lib/ai/model-catalog";
import { invalidateModelCatalogCache } from "@/lib/ai/catalog-source";
import { findEarningsCoverageGaps, renderCoverageGapsBlock } from "@/lib/calendar/coverage-guard";
import { sendPushover } from "@/lib/alerts/notify-pushover";

export class BriefingSendError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "BriefingSendError";
  }
}

export interface SendBriefingOpts {
  weekOf?: string;
  recipient?: string;
  force?: boolean;
  footerNote?: string;
}

export interface SendBriefingResult {
  success: true;
  weekOf: string;
  sentTo: string;
  generated: boolean;
  eventCount: number;
  twsSynced: boolean;
}

export async function sendBriefingEmail(
  db: Database.Database,
  opts: SendBriefingOpts = {}
): Promise<SendBriefingResult> {
  const weekOf = opts.weekOf || getCurrentMonday();
  const overrides = getRecipientsFor(db, "briefing");
  const recipient =
    opts.recipient ??
    (overrides ? overrides.join(", ") : null) ??
    process.env.BRIEFING_EMAIL_TO;

  if (!recipient) {
    throw new BriefingSendError(
      "No recipient. Set BRIEFING_EMAIL_TO env var or pass 'recipient'.",
      400
    );
  }

  // Step 1: positions sync — quick TWS call to refresh intra-day quantities.
  // Doesn't refresh prices (that's Step 2 below).
  let twsSynced = false;
  try {
    await syncPortfolio(db);
    twsSynced = true;
  } catch {
    console.log("[send-briefing] TWS sync skipped (not connected or no IBKR account)");
  }

  // Step 2: price + valuation refresh. Pre-2026-05-12 the briefing path
  // skipped this and Sunday 5/11 went out with Thursday close prices because
  // the prices table hadn't been touched since Friday close (TWS not
  // connected when no auto-refresh ran). runAutoRefresh(db, "quick") runs
  // snapshot prices + valuations recompute (~2-3 min). Best-effort — on
  // failure we proceed with whatever prices are already in the table and
  // log how stale they are.
  if (twsSynced) {
    try {
      const refresh = await runAutoRefresh(db, "quick");
      if (refresh === null) {
        console.log(
          "[send-briefing] price/valuation refresh skipped — another sync was already in progress",
        );
      } else if (refresh.errors.length > 0) {
        console.warn(
          `[send-briefing] price/valuation refresh had errors: ${refresh.errors.join("; ")}`,
        );
      } else {
        console.log(
          `[send-briefing] price/valuation refresh: ${refresh.pricesUpdated} prices, valuations=${refresh.valuationsRecomputed}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[send-briefing] price/valuation refresh failed: ${msg}`);
    }
  }

  // Price-freshness breadcrumb: surfaces in launchd logs so future "stale
  // briefing prices" investigations don't need to instrument from scratch.
  // Reads the most-recent prices.date across the holdings universe — a
  // single timestamp summary, not per-symbol.
  try {
    const row = db
      .prepare(
        `SELECT MAX(p.date) AS latest_date,
                CAST(julianday('now') - julianday(MAX(p.date)) AS INTEGER) AS days_old
           FROM prices p
           JOIN securities s ON s.id = p.security_id
          WHERE s.id IN (
            SELECT DISTINCT security_id FROM holdings WHERE quantity != 0
          )`,
      )
      .get() as { latest_date: string | null; days_old: number | null } | undefined;
    if (row?.latest_date) {
      console.log(
        `[send-briefing] Latest price as_of_date: ${row.latest_date} (${row.days_old ?? "?"}d old)`,
      );
    } else {
      console.log("[send-briefing] No prices in DB for current holdings");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[send-briefing] price-freshness probe failed: ${msg}`);
  }

  // Model catalog refresh. Sunday cadence is appropriate — the catalog only
  // drives new-model discovery and weekly is plenty. Best-effort — failures
  // MUST NOT block the briefing.
  try {
    await refreshModelCatalog(db);
    invalidateModelCatalogCache(); // pick up the new list immediately
  } catch (e) {
    console.warn(`[send-briefing] model catalog refresh skipped: ${String(e)}`);
  }

  // Calendar sync. Until 2026-04-27 the briefing path skipped this,
  // and Sunday 4/26's briefing missed PCE + Q1 GDP (both released the
  // following Thursday) because no one had run /api/calendar/sync for
  // week_of=2026-04-27. Errors here are logged but never block — partial
  // calendar data is still better than no briefing.
  //
  // Sync the current week AND the following weeks. The +1 sweep catches
  // Finnhub-newly-published earnings dates that landed in the past week
  // (the Sunday TER-shaped scenario), so the EarningsHub UI on /today
  // surfaces them automatically rather than waiting for the user to
  // click "Refresh from Finnhub" themselves.
  //
  // 4 weeks of reach: earnings dates confirm 2-4+ weeks out, and the July
  // 2026 bank week was structurally unreachable at [week, +1] (audit
  // 2026-07-04). Idempotent; ~+2 min of Finnhub pacing on Sundays.
  for (const w of [weekOf, addDays(weekOf, 7), addDays(weekOf, 14), addDays(weekOf, 21)]) {
    try {
      const result = await syncCalendarForWeek(db, w);
      if (result.errors.length > 0) {
        console.warn(`[send-briefing] calendar sync (${w}) had errors: ${result.errors.join("; ")}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[send-briefing] calendar sync (${w}) failed: ${msg}`);
    }
  }

  // Coverage guard (Wave 1 §1): with 4 weeks of sync reach, a name that
  // STILL has no scheduled event when a report is due means no source has
  // it — surface it rather than fail silently. Best-effort: a guard failure
  // must never block the briefing.
  let coverageGapsBlock = "";
  try {
    const gaps = findEarningsCoverageGaps(db);
    coverageGapsBlock = renderCoverageGapsBlock(gaps);
    if (gaps.length > 0) {
      const symbols = gaps.map((g) => g.symbol).join(", ");
      void sendPushover({
        title: "Earnings coverage gaps",
        message: `${gaps.length} name(s) with a report due and nothing scheduled: ${symbols}`,
        url: `${process.env.PUSHOVER_LINK_BASE ?? "http://localhost:3099"}/dashboard/today`,
        urlTitle: "Open Earnings Hub",
      });
    }
  } catch (err) {
    console.warn(`[coverage-guard] skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Narrative pre-generation. 4 scopes × 4 surfaces = 16 Sonnet calls,
  // run in parallel. Cached per (scope, surface, week_of) so the next
  // briefing-pipeline invocation is a no-op. Failures here MUST NOT block
  // the briefing — narratives are nice-to-have, the email is the critical
  // path. Cost: ~$0.32/month at Sunday cadence.
  try {
    const SCOPES_FOR_NARRATIVES = ["all", "vanguard", "ibkr", "roth"] as const;
    const narrativeWeek = mondayOf(weekOf);
    const results = await Promise.allSettled(
      SCOPES_FOR_NARRATIVES.flatMap((scope) =>
        NARRATIVE_SURFACES.map((surface) =>
          generateNarrative(db, { scope, surfaceKey: surface, weekOf: narrativeWeek })
        )
      )
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      console.warn(
        `[send-briefing] ${failed} of ${results.length} narrative pre-generations failed (cached entries from prior weeks remain available)`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[send-briefing] narrative pre-generation skipped: ${msg}`);
  }

  // Macro themes pre-generation. 4 scopes × 1/wk = 4 Sonnet calls, run in
  // parallel. Cached per (scope, week_of). Failures here MUST NOT block the
  // briefing. Cost: ~$0.85/month at Sunday cadence.
  try {
    const { generateMacroThemes } = await import("@/lib/compute/macro-themes");
    const SCOPES_FOR_MACRO = ["all", "vanguard", "ibkr", "roth"] as const;
    const macroWeek = mondayOf(weekOf);
    const macroResults = await Promise.allSettled(
      SCOPES_FOR_MACRO.map((scope) =>
        generateMacroThemes(db, { scope, weekOf: macroWeek })
      )
    );
    const macroFailed = macroResults.filter((r) => r.status === "rejected").length;
    if (macroFailed > 0) {
      console.warn(
        `[send-briefing] ${macroFailed} of ${macroResults.length} macro-theme pre-generations failed`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[send-briefing] macro-themes pre-generation skipped: ${msg}`);
  }

  // Per-security regression cache backfill. Sunday cadence is appropriate;
  // daily TWS auto-refresh would burn 180+ OLS computes per run with little
  // benefit (price data only changes once a day for most names).
  // Best-effort — failures must NOT block the email.
  try {
    const { backfillSecurityRegressions } = await import(
      "@/lib/compute/security-regression-backfill"
    );
    const summary = backfillSecurityRegressions(db);
    console.log(
      `[send-briefing] regression backfill: processed=${summary.processed} succeeded=${summary.succeeded} skipped=${summary.skipped} failed=${summary.failed}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[send-briefing] regression backfill skipped: ${msg}`);
  }

  let briefing = getBriefingByWeek(db, weekOf);
  let generated = false;
  const stale = briefing ? isBriefingStale(db, weekOf) : false;

  if (!briefing || !briefing.content || opts.force || stale) {
    const result = await generateWeeklyBriefing(db, weekOf);
    briefing = getBriefingByWeek(db, weekOf);
    generated = true;

    if (!briefing || result.eventCount === 0) {
      throw new BriefingSendError(
        `No events found for this week. Run a calendar sync first. (weekOf=${weekOf})`,
        404
      );
    }
  }

  if (!briefing) {
    throw new BriefingSendError(
      `Briefing generation succeeded but failed to save. (weekOf=${weekOf})`,
      500
    );
  }

  const title = briefing.title || `Week of ${weekOf}`;
  // Coverage block is appended at SEND time so it's always fresh — the
  // cached calendar_briefings.content row stays pure AI output.
  const contentForEmail = coverageGapsBlock
    ? `${briefing.content}\n\n---\n\n${coverageGapsBlock}`
    : briefing.content;
  const html = briefingToHtml(contentForEmail, title, opts.footerNote);

  try {
    await sendEmail({
      to: recipient,
      subject: `📊 ${title} — Weekly Portfolio Briefing`,
      html,
      fromLocalPart: "briefing",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BriefingSendError(`Send failed: ${msg}`, 500);
  }

  setLastBriefingSentAt(db, new Date().toISOString());

  return {
    success: true,
    weekOf,
    sentTo: recipient,
    generated,
    eventCount: briefing.event_count,
    twsSynced,
  };
}
