/**
 * Single shared earnings email sweep — used by BOTH the cron route
 * (/api/cron/earnings-sweep) and the launchd tsx fallback
 * (scripts/sweep-earnings-emails.ts).
 *
 * Carries the Phase-4 Mac↔cloud KV marker dance that previously lived only
 * in the (uncalled) per-event routes /api/cron/earnings-{preview,recap} —
 * without it, the Worker fallback and the Mac sweep double-sent every
 * preview whenever the Mac was awake (audit 2026-07-04, bug B1). Marker
 * helpers no-op gracefully when WORKER_MARKER_URL is unset.
 */

import type Database from "better-sqlite3";
import {
  findEmailCandidates,
  type EmailSweepOpts,
} from "./enrichment-runner";
import {
  sendEarningsPreview,
  sendEarningsRecap,
  EarningsEmailError,
  reapStaleEarningsEmailClaims,
} from "@/lib/digest/send-earnings-email";
import {
  checkEarningsCloudMarker,
  setEarningsRunningMarker,
  clearEarningsRunningMarker,
  writeMacSentEarningsMarker,
} from "@/lib/cron/earnings-marker-check";
import { composeReleaseInstant } from "./reaction-snapshot";
import { sendPushover } from "@/lib/alerts/notify-pushover";

export interface SweepCandidateResult {
  eventId: number;
  symbol: string;
  phase: "preview" | "recap";
  ok: boolean;
  skipped?: "cloud-already-sent";
  status?: number;
  message?: string;
  durationMs: number;
}

export interface SweepSummary {
  swept: number;
  sent: number;
  skipped: number;
  failed: number;
  recapAlerts: number;
  results: SweepCandidateResult[];
}

/**
 * When the Worker fallback already delivered an email, mirror that fact into
 * the local audit table so (a) findEmailCandidates stops re-selecting the
 * event every tick and (b) the EarningsHub chips show it as sent.
 * ai_output_md stays NULL — the viewer knows there's no local copy.
 */
function recordCloudSentAudit(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
): void {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
     VALUES (?, ?, 'cloud-fallback', NULL, 'sent-by-cloud')
     ON CONFLICT(event_id, phase) DO NOTHING`,
  ).run(eventId, phase);
}

export async function runEarningsEmailSweep(
  db: Database.Database,
  opts: EmailSweepOpts = {},
): Promise<SweepSummary> {
  // Reap stale (>30 min) 'in_progress' claim rows BEFORE candidate selection
  // — a stale claim from a dead process otherwise hides its event from
  // findEmailCandidates forever (the claim row satisfies the "already
  // audited" exclusion but no email was ever sent). See B3.
  const reaped = reapStaleEarningsEmailClaims(db);
  if (reaped > 0) {
    console.warn(
      `[earnings-sweep] reaped ${reaped} stale in-progress claim(s) from a dead process`,
    );
  }

  const candidates = findEmailCandidates(db, opts);
  const results: SweepCandidateResult[] = [];

  for (const cand of candidates) {
    const t0 = Date.now();

    const cloudMarker = await checkEarningsCloudMarker(cand.phase, cand.eventId);
    if (cloudMarker?.sentBy === "cloud") {
      recordCloudSentAudit(db, cand.eventId, cand.phase);
      results.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        ok: true,
        skipped: "cloud-already-sent",
        durationMs: Date.now() - t0,
      });
      continue;
    }

    void setEarningsRunningMarker(cand.phase, cand.eventId);
    try {
      if (cand.phase === "preview") {
        await sendEarningsPreview(db, cand.eventId);
      } else {
        await sendEarningsRecap(db, cand.eventId);
      }
      void writeMacSentEarningsMarker(cand.phase, cand.eventId);
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
    } finally {
      void clearEarningsRunningMarker(cand.phase, cand.eventId);
    }
  }

  let recapAlerts = 0;
  try {
    recapAlerts = await alertBlockedRecaps(db, { now: opts.now });
  } catch (err) {
    console.warn("[earnings-sweep] blocked-recap alert pass failed:", err);
    recapAlerts = 0;
  }

  return {
    swept: candidates.length,
    sent: results.filter((r) => r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok).length,
    recapAlerts,
    results,
  };
}

// A previewed print with no actual after this long is "blocked" — the recap
// gate (actual_value IS NOT NULL) will never open on its own. 2h floor gives
// Finnhub + the retry loop (Task 6) a fair chance first.
const BLOCKED_RECAP_MIN_AGE_MS = 2 * 60 * 60 * 1000;
// Ceiling is NOT about a launchd gate closing — the tick runs 24/7 every 15
// min with no time-of-day window (see scripts/enrich-calendar-events.sh).
// 18h instead bounds how stale an event can be before a Pushover alert about
// it stops being useful — it exists to cover multi-hour Mac-asleep gaps
// (overnight, travel) without alerting about arbitrarily ancient events that
// slipped through the `event_date >= now-2days` guard above.
const BLOCKED_RECAP_MAX_AGE_MS = 18 * 60 * 60 * 1000;

interface BlockedRecapRow {
  id: number;
  symbol: string;
  event_date: string;
  release_time: string;
}

/**
 * Pushover once per event when a PREVIEWED earnings print has been out >2h
 * with no actual captured — last season 10 previews died silently this way
 * (audit 2026-07-04 §2). The push deep-links to the Today page where the
 * BogeysEditModal actuals override lives; entering an actual re-opens the
 * recap path (the sweep picks it up next tick).
 */
export async function alertBlockedRecaps(
  db: Database.Database,
  opts: { now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const rows = db
    .prepare(
      `SELECT ce.id, ce.symbol, ce.event_date, ce.release_time
         FROM calendar_events ce
         JOIN earnings_emails ep
           ON ep.event_id = ce.id AND ep.phase = 'preview'
          AND (ep.error IS NULL OR ep.error NOT IN ('in_progress'))
         LEFT JOIN earnings_emails er
           ON er.event_id = ce.id AND er.phase = 'recap'
         LEFT JOIN earnings_email_skips es
           ON es.event_id = ce.id AND es.phase = 'recap'
        WHERE ce.event_type = 'earnings'
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.actual_value IS NULL
          AND ce.actual_missing_alerted_at IS NULL
          AND ce.release_time IS NOT NULL
          AND ce.symbol IS NOT NULL
          AND ce.event_date >= date('now', '-2 days')
          AND er.id IS NULL
          AND es.id IS NULL`,
    )
    .all() as BlockedRecapRow[];

  const stampAlerted = db.prepare(
    `UPDATE calendar_events SET actual_missing_alerted_at = datetime('now') WHERE id = ?`,
  );

  let alerted = 0;
  for (const row of rows) {
    const release = composeReleaseInstant(row.event_date, row.release_time);
    if (!release) continue;
    const ageMs = nowMs - release.getTime();
    if (ageMs < BLOCKED_RECAP_MIN_AGE_MS || ageMs > BLOCKED_RECAP_MAX_AGE_MS) continue;

    // Stamp BEFORE pushing — one alert per event even if Pushover errors.
    stampAlerted.run(row.id);

    const hours = Math.round(ageMs / (60 * 60 * 1000));
    await sendPushover({
      title: `${row.symbol} recap blocked — no actuals`,
      message:
        `${row.symbol} reported ~${hours}h ago but no actual EPS/Rev has arrived, ` +
        `so the recap email is blocked. Enter actuals manually to unblock it.`,
      url: `${process.env.PUSHOVER_LINK_BASE ?? "http://localhost:3099"}/dashboard/today`,
      urlTitle: "Open Earnings Hub",
    });
    alerted += 1;
  }
  return alerted;
}
