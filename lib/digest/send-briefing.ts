import type Database from "better-sqlite3";
import { getBriefingByWeek, isBriefingStale } from "@/lib/queries/calendar";
import { generateWeeklyBriefing } from "@/lib/calendar/briefing";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { sendEmail } from "@/lib/email";
import { addDays, getCurrentMonday } from "@/lib/calendar/date-utils";
import { syncPortfolio } from "@/lib/tws/positions";
import { setLastBriefingSentAt } from "@/lib/digest/daily-digest";
import { syncCalendarForWeek } from "@/lib/calendar/sync";
import { getRecipientsFor } from "@/lib/queries/email-recipients";

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

  let twsSynced = false;
  try {
    await syncPortfolio(db);
    twsSynced = true;
  } catch {
    console.log("[send-briefing] TWS sync skipped (not connected or no IBKR account)");
  }

  // Calendar sync. Until 2026-04-27 the briefing path skipped this,
  // and Sunday 4/26's briefing missed PCE + Q1 GDP (both released the
  // following Thursday) because no one had run /api/calendar/sync for
  // week_of=2026-04-27. Errors here are logged but never block — partial
  // calendar data is still better than no briefing.
  //
  // Sync the current week AND the following week. The +1 sweep catches
  // Finnhub-newly-published earnings dates that landed in the past week
  // (the Sunday TER-shaped scenario), so the EarningsHub UI on /today
  // surfaces them automatically rather than waiting for the user to
  // click "Refresh from Finnhub" themselves.
  for (const w of [weekOf, addDays(weekOf, 7)]) {
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
  const html = briefingToHtml(briefing.content, title, opts.footerNote);

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
