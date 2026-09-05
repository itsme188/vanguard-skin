/**
 * Single shared earnings email sweep — used by BOTH the cron route
 * (/api/cron/earnings-sweep) and the launchd tsx fallback
 * (scripts/sweep-earnings-emails.ts).
 *
 * SELECTION AND BOOKKEEPING, not sending (slice E). This file decides WHICH
 * candidates to offer the canonical send service (lib/earnings/send-service.ts)
 * and turns each outcome it gets back into a SweepCandidateResult. The
 * Phase-4 Mac↔cloud KV marker dance that used to live here — the cloud
 * pre-check, the running marker, the mac-sent write — moved INTO the service
 * (R-E6/spec §4.5) so the Today nudge and the manual route get it too; without
 * that dance the Worker fallback and the Mac double-sent every preview
 * whenever the Mac was awake (audit 2026-07-04, bug B1).
 *
 * Two marker writes stay here, because neither sits on a send path: the
 * already-reported preview skip (nothing is ever offered to the service for
 * that candidate) and the reaper's delivery-unknown flips (R-E4b — any
 * earnings_emails row removes its event from findEmailCandidates, so the
 * service would never see it). Marker helpers no-op gracefully when
 * WORKER_MARKER_URL is unset.
 */

import type Database from "better-sqlite3";
import {
  findEmailCandidates,
  type EmailSweepOpts,
} from "./enrichment-runner";
import { reapStaleEarningsEmailClaims } from "@/lib/digest/send-earnings-email";
// ONE send path (slice E): the service owns the claim, the awaited markers, the
// cloud pre-check, the provider call and every state transition on the audit
// row. The sweep decides WHICH candidates to offer it and books what came back.
import { sendEarningsCandidate, type SendOutcome } from "@/lib/earnings/send-service";
import { DELIVERY_UNKNOWN, IN_PROGRESS, notLiveClaimSql } from "@/lib/earnings/email-states";
import {
  writeMacSentEarningsMarker,
  fetchCloudSentEarnings,
  postMacRecentEarningsSweepMarker,
} from "@/lib/cron/earnings-marker-check";
import { composeReleaseInstant } from "./reaction-snapshot";
import { probeFinnhubActualExists } from "./enrich-actuals";
import { sendPushover } from "@/lib/alerts/notify-pushover";
import { getEarningsSettings, shouldSendEarningsEmail } from "@/lib/queries/earnings-settings";
import { getExpectedRecapCluster, wrapSlotFor, WRAP_THRESHOLD } from "@/lib/earnings/wrap";
import { runMorningDebrief } from "@/lib/earnings/debrief-send";
import { printArmedWorksheets } from "@/lib/earnings/worksheet";
import { todayET } from "@/lib/calendar/date-utils";
import { drainCloudOutbox, writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";
import { fetchSameDayTranscripts } from "@/lib/transcripts/same-day";
import { recordEarningsEmailSkip } from "@/lib/mutations/earnings-skips";
import { ensurePrintWatch } from "@/lib/print-watch/watcher";
import { runPrepareSteps, type PrepareRunReport } from "@/lib/earnings/prepare-armed-event";
// Shared with lib/earnings/debrief-send.ts (which also drops cloud-delivered
// members) — moved out of this file 2026-08-02 so both can use it without an
// email-sweep ↔ debrief-send import cycle.
import { recordCloudSentAudit } from "@/lib/mutations/earnings-emails";

export interface SweepCandidateResult {
  eventId: number;
  symbol: string;
  phase: "preview" | "recap";
  ok: boolean;
  skipped?:
    | "cloud-already-sent"
    | "claim-held"
    | "not-ready"
    | "wrap-pending"
    | "already-reported"
    /** A completed row already exists for this (event, phase) — the Mac sent it
     *  (or the desk confirmed it) and the service refused to refire. */
    | "already-sent"
    /** Terminal: an earlier attempt never learned the provider's answer. Never
     *  resent automatically (spec §7) — reconciled by hand. */
    | "delivery-unknown";
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
  /** Audit rows backfilled from cloud-sent KV markers this sweep (2026-07-15). */
  cloudReconciled: number;
  /** armed-events outbox rows delivered to the Worker this tick (v2 slice A). */
  outboxSent: number;
  /** True when this tick's reconcile minted a new armed-events generation (R8). */
  outboxReconciled: boolean;
  /**
   * Result of the 7:45 ET morning debrief pass (2026-08-02, replaces the EOD
   * wrap — see lib/earnings/debrief-send.ts). Null when the pass threw
   * before returning (it never fails the sweep); otherwise reflects whether
   * it actually sent this tick (its own window/once-per-day gate usually
   * means most ticks report `sent: false`) and which symbols it covered.
   */
  debrief: { sent: boolean; covered: string[] } | null;
  /** Same-day transcript fetch attempts that succeeded this pass (#12 B1). */
  transcriptsFetched: number;
  /**
   * Prepare pass for armed events (v2 slice A): what this tick's registered
   * prepare steps did. Zeroed when the pass threw (it never fails the sweep).
   */
  prepared: PrepareRunReport;
  results: SweepCandidateResult[];
}

interface WrapClassifyRow {
  event_date: string;
  event_time: string | null;
  title: string | null;
  release_time: string | null;
}

/**
 * Backfill audit rows for every live cloud-sent marker, INCLUDING events
 * whose send windows have closed — findEmailCandidates can't see those, so
 * the per-candidate marker check in the sweep loop never reaches them. A
 * marker whose event was deleted (calendar sync cleanup) fails the FK and is
 * skipped without failing the sweep.
 */
async function reconcileCloudSentAudits(db: Database.Database): Promise<number> {
  const sends = await fetchCloudSentEarnings();
  let reconciled = 0;
  for (const s of sends) {
    if (s.phase !== "preview" && s.phase !== "recap") continue;
    if (!Number.isInteger(s.eventId)) continue;
    try {
      reconciled += recordCloudSentAudit(db, s.eventId, s.phase, s.sentAt);
    } catch (err) {
      console.warn(
        `[earnings-sweep] cloud-sent reconcile skipped event ${s.eventId} (${s.phase}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (reconciled > 0) {
    console.log(
      `[earnings-sweep] backfilled ${reconciled} sent-by-cloud audit row(s) from Worker markers`,
    );
  }
  return reconciled;
}

export async function runEarningsEmailSweep(
  db: Database.Database,
  opts: EmailSweepOpts & {
    /** [F3] Pass-level budget override for the prepare pass. Tests only —
     *  production uses PREPARE_PASS_BUDGET_MS. */
    prepareBudgetMs?: number;
  } = {},
): Promise<SweepSummary> {
  // Reap stale (>30 min) composing claim rows BEFORE candidate selection — a
  // stale claim from a dead process otherwise hides its event from
  // findEmailCandidates forever (the claim row satisfies the "already
  // audited" exclusion but no email was ever sent). See B3. The same call also
  // flips an orphaned in-flight send to the terminal delivery-unknown state
  // (slice E) and reports which (event, phase) pairs it actually moved.
  const reapResult = await reapStaleEarningsEmailClaims(db);
  if (reapResult.reaped > 0) {
    console.warn(
      `[earnings-sweep] reaped ${reapResult.reaped} stale in-progress claim(s) from a dead process`,
    );
  }
  if (reapResult.flippedUnknown > 0) {
    console.warn(
      `[earnings-sweep] ${reapResult.flippedUnknown} send(s) left in flight by a dead process → delivery unknown (pushed)`,
    );
  }
  // R-E4b: a flipped row must ALSO claim its (phase, event) in KV, or the
  // Worker fallback is free to send a second copy of a recap that may already
  // have gone out. The reaper itself stays DB-only (it runs on every tick from
  // a cron path that may have no Worker reachability), so the marker write
  // lives here, where every other marker call already does.
  //
  // This cannot be deferred to the next candidate pass: findEmailCandidates
  // LEFT JOINs earnings_emails and keeps only `ee.id IS NULL`, so ANY row for
  // that (event, phase) — the delivery-unknown row included — removes the
  // event from candidacy, the send path is never invoked for it, and no marker
  // would ever be written. Fail-open: the flip is already committed and a
  // marker write is idempotent, so a KV failure is a warning and nothing more.
  for (const flip of reapResult.flipped) {
    try {
      await writeMacSentEarningsMarker(flip.phase, flip.eventId);
    } catch (err) {
      console.warn(
        `[earnings-sweep] delivery-unknown marker write failed for event ${flip.eventId} (${flip.phase}):`,
        err,
      );
    }
  }

  // Drain cloud-sent markers into audit rows BEFORE candidate selection so a
  // freshly-backfilled row excludes its event from this very tick's candidates.
  const cloudReconciled = await reconcileCloudSentAudits(db);

  // ── Armed-events outbox reconcile (R8) ────────────────────────────────
  // The Worker learns about armed worksheets ONLY through cloud_outbox rows,
  // so without a periodic re-derive it would never hear about an event that
  // was armed before the outbox existed — or armed by a path whose write was
  // lost. D10 makes this a no-op on every tick where nothing changed.
  let outboxReconciled = false;
  try {
    outboxReconciled = db
      .transaction(() => writeArmedEventsOutboxRow(db))
      .immediate().written;
  } catch (err) {
    console.warn("[earnings-sweep] armed-events outbox reconcile failed:", err);
  }

  // ── Cloud outbox drain (v2 slice A): armed-events delta to the Worker ──
  // The routes attempt their own post-commit drain; this is the catch-up for
  // a Worker that was down (or a Mac that was asleep) when the row was written.
  let outboxSent = 0;
  try {
    outboxSent = (await drainCloudOutbox(db)).sent;
  } catch (err) {
    console.warn("[earnings-sweep] cloud outbox drain failed:", err);
  }

  const candidates = findEmailCandidates(db, opts);
  const results: SweepCandidateResult[] = [];

  // ── Morning debrief pass (2026-08-02, retires the EOD wrap) ───────────
  // Runs unconditionally every tick — runMorningDebrief owns its own
  // 07:45-08:20 ET window + once-per-day gate, so most ticks are a cheap
  // no-op. Deliberately BEFORE the per-candidate loop (F1b): an individual
  // send is a 60-180s Claude call, so a sweep entering at 08:10 with three
  // candidates would finish the loop past 08:20 and lose the debrief for the
  // day (the day key is only stamped on a sending pass, but the window has
  // closed by then). A debrief failure must never fail the sweep — the
  // sweep's other responsibilities (sends, cloud reconcile, blocked-recap
  // alerts) still need to complete.
  let debrief: { sent: boolean; covered: string[] } | null = null;
  try {
    const r = await runMorningDebrief(db, { now: opts.now });
    debrief = { sent: r.sent, covered: r.covered };
  } catch (err) {
    console.warn("[earnings-sweep] morning debrief pass failed:", err);
  }

  for (const cand of candidates) {
    const t0 = Date.now();

    // ── Wrap-mode suppression (#17 T3) ──────────────────────────────────
    // A recap candidate whose (date, slot) cluster has reached WRAP_THRESHOLD
    // gets stapled into ONE wrap email (below) instead of an individual
    // send. Previews are untouched. This MUST use the same raw
    // getExpectedRecapCluster(...).length >= WRAP_THRESHOLD determination
    // that runWrapPass uses internally — never a post-exclusion count, or
    // individuals get suppressed while the wrap sends nothing (Task 2
    // reviewer's coordination rule).
    //
    // Gated to TODAY's ET date (#17 final-review fix): runWrapPass only
    // evaluates today's (date, slot) clusters (`date = todayET(now)` in
    // wrap-send.ts), so a candidate whose event_date is NOT today can never
    // be matched by any wrap pass — suppressing it here strands it in
    // wrap-pending limbo forever (candidates vanish from the recap window
    // at enriched_at+4h with no email ever sent). A same-day Finnhub outage
    // where the user backfills actuals the next morning reopens recap
    // candidates dated yesterday; those must fall through to individual
    // sends, the correct degraded behavior.
    // Reporter recaps (feedback #3) are EXEMPT from wrap suppression: the
    // cluster counts held/watchlist expected recaps, the debrief's candidate
    // gate never covers a non-held reporter, and the read-through signal is
    // only valuable while it's timely.
    // BMO clusters are EXEMPT too (2026-08-04 decision): the defer-to-
    // next-morning-debrief rationale is AMC-specific — a BMO cluster's
    // individual recaps land the SAME morning the user is following the
    // prints, so suppression buys nothing and costs a full day (the 8/04
    // DOCN/XMTR/WIX cluster had to be recapped manually). Only AMC
    // clusters suppress. Worker mirror: fallback-earnings.ts.
    if (cand.phase === "recap" && !cand.reporterRecap) {
      const eventRow = db
        .prepare(
          `SELECT event_date, event_time, title, release_time FROM calendar_events WHERE id = ?`,
        )
        .get(cand.eventId) as WrapClassifyRow | undefined;
      const slot = eventRow ? wrapSlotFor(eventRow) : null;
      if (
        eventRow &&
        eventRow.event_date === todayET(opts.now) &&
        slot === "AMC" &&
        getExpectedRecapCluster(db, eventRow.event_date, slot).length >= WRAP_THRESHOLD
      ) {
        results.push({
          eventId: cand.eventId,
          symbol: cand.symbol,
          phase: cand.phase,
          ok: true,
          skipped: "wrap-pending",
          durationMs: Date.now() - t0,
        });
        continue;
      }
    }

    // Already-reported guard (2026-07-23, IMAX): a wrong AMC/BMO slot from
    // the calendar source can put a preview candidate in-window AFTER the
    // real print — the window is measured against the RECORDED release
    // instant only. A post-print "preview" prices the actuals as estimates,
    // which is worse than no preview. Two layers: the row's own
    // actual_value (manual overrides / early enrichment), then a live
    // Finnhub probe. On detection, record a permanent per-event preview
    // skip (the recap path is untouched — enrichment still delivers it).
    // Best-effort: any guard error falls through to the normal send.
    if (cand.phase === "preview") {
      let alreadyReported = false;
      try {
        const evRow = db
          .prepare(`SELECT actual_value, event_date FROM calendar_events WHERE id = ?`)
          .get(cand.eventId) as { actual_value: string | null; event_date: string } | undefined;
        if (evRow?.actual_value) {
          alreadyReported = true;
        } else if (evRow) {
          alreadyReported = await probeFinnhubActualExists(cand.symbol, evRow.event_date);
        }
      } catch (err) {
        console.warn(`[email-sweep] already-reported guard errored for ${cand.symbol}:`, err);
      }
      if (alreadyReported) {
        console.warn(
          `[email-sweep] ${cand.symbol} preview skipped — already reported (recorded release slot looks wrong for event ${cand.eventId})`
        );
        recordEarningsEmailSkip(db, cand.eventId, "preview");
        // Claim the (phase,event) in KV too: the Worker's preview fallback
        // can't see earnings_email_skips — without this marker its later
        // tick would ship the same wrong-slot preview from the cloud.
        void writeMacSentEarningsMarker(cand.phase, cand.eventId);
        results.push({
          eventId: cand.eventId,
          symbol: cand.symbol,
          phase: cand.phase,
          ok: true,
          skipped: "already-reported",
          durationMs: Date.now() - t0,
        });
        continue;
      }
    }

    // The service is handed the candidate and gives back ONE outcome; every
    // branch below is bookkeeping. Nothing in THIS block composes, claims,
    // sends or touches a marker any more — the per-candidate cloud pre-check
    // moved into the service too (R-E6), so the Today nudge gets it as well.
    // (The already-reported guard above keeps its own marker write: no send is
    // attempted there, so the service never sees that candidate.)
    let outcome: SendOutcome;
    try {
      outcome = await sendEarningsCandidate(
        db,
        {
          eventId: cand.eventId,
          symbol: cand.symbol,
          phase: cand.phase,
          reporterRecap: cand.reporterRecap,
        },
        { mode: "sweep" },
      );
    } catch (err) {
      // BACKSTOP ONLY. The service classifies every ending itself and is not
      // meant to throw; if it ever does (a bug, or a failure outside its own
      // try), one candidate must not take the whole tick down with it — the
      // blocked-recap alerts, the print-watch ensure, the aliveness marker and
      // the prepare pass all still have to run. This replaces the per-candidate
      // try/catch the old inline send path carried.
      console.error(`[email-sweep] ${cand.symbol} ${cand.phase}: the send service threw:`, err);
      results.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        ok: false,
        status: 500,
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
      continue;
    }
    const base = {
      eventId: cand.eventId,
      symbol: cand.symbol,
      phase: cand.phase,
      durationMs: Date.now() - t0,
    };
    switch (outcome.outcome) {
      case "sent":
        results.push({ ...base, ok: true });
        break;
      case IN_PROGRESS:
        // Benign cross-process coordination, not a failure — season launchd
        // logs must read clean (2026-07-04 review minor).
        results.push({ ...base, ok: true, skipped: "claim-held", status: 409 });
        break;
      case "already_sent":
        results.push({
          ...base,
          ok: true,
          skipped: outcome.sentBy === "cloud" ? "cloud-already-sent" : "already-sent",
        });
        break;
      case DELIVERY_UNKNOWN:
        // Terminal and NOT resendable automatically (spec §7). The reaper has
        // already pushed; this line is the sweep's own breadcrumb.
        console.warn(
          `[email-sweep] ${cand.symbol} ${cand.phase}: delivery unknown since ${outcome.since} (message ${outcome.providerMessageId ?? "unrecorded"}) — reconcile by hand`,
        );
        results.push({ ...base, ok: true, skipped: "delivery-unknown" });
        break;
      case "refused":
        results.push({
          ...base,
          ok: true,
          skipped: "not-ready",
          status: outcome.status,
          message: outcome.reason,
        });
        break;
      case "failed":
        results.push({ ...base, ok: false, status: outcome.status, message: outcome.reason });
        break;
    }
  }

  let recapAlerts = 0;
  try {
    recapAlerts = await alertBlockedRecaps(db, { now: opts.now });
  } catch (err) {
    console.warn("[earnings-sweep] blocked-recap alert pass failed:", err);
    recapAlerts = 0;
  }

  // ── Print-watch nudge (live print-watch v1, Task 9) ───────────────────
  // Idempotent reconciler: opens/closes windows for armed events and keeps
  // the watcher alive when nobody has the Today panel open. Lease-guarded —
  // if the always-on server already owns the watcher this is a no-op, and a
  // short-lived tick that DOES take the lease only holds it for its 60s TTL.
  try {
    ensurePrintWatch(db);
  } catch (err) {
    console.warn("[earnings-sweep] print-watch ensure failed:", err);
  }

  // ── Worksheet auto-print pass (feedback #6; rich rework 2026-08-05) ──
  // Runs AFTER the send loop: the rich worksheet is composed from the LOCAL
  // preview email's stored prose (wait-for-preview gate in
  // printArmedWorksheets), so the tick that sends a preview must print it in
  // the same pass. The auto-print window ([−30m, +135m] around release) has
  // ample slack for the loop's 60–180s sends. printArmedWorksheets never
  // throws.
  await printArmedWorksheets(db, { now: opts.now });

  // ── Mac-aliveness marker (2026-08-05, the APP/MELI preview race) ──────
  // Posted after EVERY completed tick — quiet ones included — so the
  // Worker's preview fallback (25-min KV TTL) knows the Mac is alive and
  // defers previews to the Mac's wider [105,135] window. Recaps stay
  // un-gated cloud-side. Fire-and-forget: workerFetch swallows
  // unreachability, and a missed post only re-opens the lean-preview race
  // for one tick — never blocks or fails the sweep.
  //
  // [F3] Everything below this point is preparation for FUTURE prints, and
  // both passes can legitimately run for minutes (a prepare step gets up to
  // PREPARE_STEP_TIMEOUT_MS; the transcript pass does network I/O). The
  // marker is the Mac saying "I am awake" to a Worker whose fallback window
  // is 25 minutes wide — it must never queue behind that work.
  try {
    await postMacRecentEarningsSweepMarker();
  } catch (err) {
    console.warn("[earnings-sweep] aliveness-marker post failed (ignored):", err);
  }

  // ── Prepare pass for armed events (v2 slice A) ────────────────────────
  // Re-runs every runnable step each tick until the event is past: the
  // route's post-arm kick is fire-and-forget, so this is the DURABLE path
  // for a crashed kick, a step registered after the arm, or an arm whose
  // enqueue never landed. Never fails the sweep. [F3] Bounded by
  // PREPARE_PASS_BUDGET_MS: whatever it does not reach stays pending and is
  // picked up by the next tick.
  let prepared: PrepareRunReport = { ran: 0, done: 0, pending: 0, failed: 0, skipped: 0 };
  try {
    prepared = await runPrepareSteps(db, {
      now: () => (opts.now ?? new Date()).getTime(),
      passBudgetMs: opts.prepareBudgetMs,
    });
  } catch (err) {
    console.warn("[earnings-sweep] prepare pass failed:", err);
  }

  // ── Same-day transcript orchestrator (#12 B1) ─────────────────────────
  // Best-effort, always last: kicks off fetchTranscript for held/watchlist
  // prints whose actuals landed in the last 36h so a transcript is warm in
  // cache before anyone asks for one. Never blocks the sweep — mirrors the
  // wrap pass's + alertBlockedRecaps' try/catch above.
  let transcriptsFetched = 0;
  try {
    const transcripts = await fetchSameDayTranscripts(db, { now: opts.now });
    transcriptsFetched = transcripts.fetched;
  } catch (err) {
    console.warn("[earnings-sweep] same-day transcript pass failed:", err);
    transcriptsFetched = 0;
  }

  return {
    swept: candidates.length,
    sent: results.filter((r) => r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok).length,
    recapAlerts,
    cloudReconciled,
    outboxSent,
    outboxReconciled,
    debrief,
    transcriptsFetched,
    prepared,
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
          AND ${notLiveClaimSql("ep.error")}
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

  const settings = getEarningsSettings(db);

  let alerted = 0;
  for (const row of rows) {
    // Respect the mute list (user decision 2026-07-06): a symbol muted after
    // its preview went out shouldn't push blocked-recap alerts. Deliberately
    // NO stamp — unmuting while the event is still inside the age window
    // re-enables the alert on the next tick. shouldSendEarningsEmail also
    // honors the master `earnings_emails_enabled` toggle, so this alert goes
    // silent along with the sends themselves when earnings emails are
    // globally disabled — consistent with the rest of the sweep.
    if (!shouldSendEarningsEmail(settings, row.symbol)) continue;

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
