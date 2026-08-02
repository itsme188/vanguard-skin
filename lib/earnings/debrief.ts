/**
 * Morning-debrief candidate selection (2026-08-02 plan, Task 1).
 *
 * This replaces the same-evening earnings "wrap" email (lib/earnings/wrap.ts)
 * with a 7:45 ET morning debrief covering yesterday's late-AMC prints
 * alongside today's-so-far BMO prints — a wrap fired at 20:00 ET necessarily
 * misses anything that reports after the deadline; the morning debrief has
 * no such cutoff because "yesterday" is over by the time it runs.
 *
 * Pure candidate selection only — no prompt building, no sending (Tasks 2
 * and 3). Two outputs:
 *   - `unsent`: events with captured actuals that still need a recap —
 *     these get full sections in the email.
 *   - `alreadyRecapped`: events whose recap already went out (locally or via
 *     the Worker cloud fallback) — these get one roster line so the debrief
 *     stays a complete "what happened" record without re-narrating names
 *     the user already got a full email about.
 *
 * Semantics mirror lib/earnings/wrap.ts::getExpectedRecapCluster (held or
 * watchlisted, family-deduped, muted/toggle-respecting, superseded rows
 * excluded) with two deliberate differences:
 *   1. Window is [yesterday ET, today ET] by event_date, not a same-day
 *      (date, slot) cluster.
 *   2. A live 'in_progress' recap claim EXCLUDES the event from `unsent`
 *      (another process — the sweep, a manual send — is actively sending
 *      it right now; the debrief must not race it or duplicate the email).
 *      wrap.ts treats an in_progress claim as a cluster MEMBER because the
 *      wrap send itself often holds that very claim; the debrief is a
 *      separate, later pass with no such self-claim to reconcile.
 */

import type Database from "better-sqlite3";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import { getEarningsSettings, shouldSendEarningsEmail } from "@/lib/queries/earnings-settings";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";

export interface DebriefCandidate {
  eventId: number;
  symbol: string;
  event_date: string;
  event_time: string | null;
  release_time: string | null;
}

export interface DebriefRosterEntry {
  symbol: string;
  sentAt: string;
}

export interface DebriefCandidates {
  /** Full sections in the email — recap not yet sent, ready to compose. */
  unsent: DebriefCandidate[];
  /** One roster line each — recap already delivered (local or cloud). */
  alreadyRecapped: DebriefRosterEntry[];
}

/** A print must be at least this old before the debrief will cover it —
 * matches the earnings-intel "reaction ready" convention loosely, but the
 * real reason is simpler: a release_time known to be under an hour old
 * hasn't had time to generate actuals/reaction data worth debriefing, and
 * the sweep is still the right owner for same-morning immediacy. */
const MIN_MINUTES_SINCE_RELEASE = 60;

/**
 * Find candidates for the 7:45 ET morning debrief: held/watchlist earnings
 * events dated yesterday or today (ET) with captured actuals, no completed
 * or in-flight recap, not skipped/muted/superseded, released at least
 * `MIN_MINUTES_SINCE_RELEASE` minutes ago (or with unknown release_time,
 * which is never held back for lack of data), family-deduped.
 */
export function findDebriefCandidates(
  db: Database.Database,
  opts: { now?: Date } = {},
): DebriefCandidates {
  const now = opts.now ?? new Date();
  const today = todayET(now);
  const yesterday = addDays(today, -1);

  // Any recap row at all — including a live 'in_progress' claim — excludes
  // an event from `unsent`: someone else is (or already did) send it.
  const rawRows = db
    .prepare(
      `SELECT ce.id AS eventId, ce.symbol, ce.event_date, ce.event_time, ce.release_time
         FROM calendar_events ce
         LEFT JOIN earnings_emails ee ON ee.event_id = ce.id AND ee.phase = 'recap'
         LEFT JOIN earnings_email_skips es ON es.event_id = ce.id AND es.phase = 'recap'
        WHERE ce.event_type = 'earnings'
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.symbol IS NOT NULL
          AND ce.actual_value IS NOT NULL
          AND ce.event_date IN (?, ?)
          AND ee.id IS NULL
          AND es.id IS NULL`,
    )
    .all(yesterday, today) as DebriefCandidate[];

  const settings = getEarningsSettings(db);
  const status = getSymbolStatus(
    db,
    rawRows.map((r) => r.symbol),
  );

  let candidates = rawRows.filter((r) => {
    const st = status[r.symbol.toUpperCase()];
    if (st !== "held" && st !== "watchlist") return false;
    return shouldSendEarningsEmail(settings, r.symbol);
  });

  // Release-recency filter: a known release_time under an hour old is held
  // back for the sweep to own; unknown release_time is never held back.
  const nowMs = now.getTime();
  candidates = candidates.filter((r) => {
    if (!r.release_time) return true;
    const releaseInstant = composeReleaseInstant(r.event_date, r.release_time);
    if (!releaseInstant) return true;
    const minutesSince = (nowMs - releaseInstant.getTime()) / 60_000;
    return minutesSince >= MIN_MINUTES_SINCE_RELEASE;
  });

  // Family dedupe (GOOG/GOOGL, etc.) — keep the lowest eventId per family,
  // same tie-break convention as dedupeCrossSourceRows / dedupeByFamily.
  candidates = [...candidates].sort((a, b) => a.eventId - b.eventId);
  const seenFamilies = new Set<string>();
  const unsent: DebriefCandidate[] = [];
  for (const c of candidates) {
    const familyKey = issuerSiblings(c.symbol.toUpperCase())
      .map((s) => s.toUpperCase())
      .sort()
      .join(",");
    if (seenFamilies.has(familyKey)) continue;
    seenFamilies.add(familyKey);
    unsent.push(c);
  }

  const alreadyRecapped = db
    .prepare(
      `SELECT ce.symbol, ee.sent_at AS sentAt
         FROM earnings_emails ee
         JOIN calendar_events ce ON ce.id = ee.event_id
        WHERE ee.phase = 'recap'
          AND (ee.error IS NULL OR ee.error = 'sent-by-cloud')
          AND ce.event_date IN (?, ?)
        ORDER BY ee.sent_at`,
    )
    .all(yesterday, today) as DebriefRosterEntry[];

  return { unsent, alreadyRecapped };
}
