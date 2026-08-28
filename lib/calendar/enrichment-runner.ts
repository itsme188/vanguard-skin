/**
 * Orchestrates post-release enrichment for calendar events.
 *
 * Shared between the launchd-driven cron script and both calendar-enrich
 * routes (`POST /api/calendar/enrich` — service/cron — and
 * `POST /api/calendar/enrich-manual` — human, no cron secret) via
 * `lib/calendar/enrich-request.ts::runCalendarEnrichRequest`, which wraps
 * this function with the cloud-reconcile pre-step and response shaping.
 * Keeps all scheduling semantics (window, TWS detection, sector-gap
 * logging) in one place.
 */

import type Database from "better-sqlite3";
import type { IBApiNext } from "@stoqey/ib";
import { fetchActualForEvent } from "./enrich-actuals";
import {
  captureReactionFromTws,
  composeReleaseInstant,
  resolveSectorEtf,
  type ReactionSnapshot,
} from "./reaction-snapshot";
import { captureReactionFromYahoo } from "../../workers/cron/src/yahoo";
import { sendEarningsPrintPush } from "@/lib/alerts/print-push";
import { getLiveReadThroughsForReporter } from "@/lib/alerts/read-through-push";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import {
  getEarningsSettings,
  shouldSendEarningsEmail,
} from "@/lib/queries/earnings-settings";
import { runWireProbePass } from "./wire-probe";
import {
  checkPrePrintFloor,
  type PrePrintFloorResult,
} from "@/lib/earnings/pre-print-floor";
import { recordWireObservation } from "@/lib/earnings/wire-times";

// Macro releases (FRED/FOMC/nonfred): data is typically published within
// minutes of release, and the reaction window is the immediate 2-hour
// market response. 2h is the right budget.
const MAX_AGE_MS_MACRO = 2 * 60 * 60 * 1000;
// Earnings releases: a Before Market Open earnings call at 08:00 ET can't
// produce a meaningful reaction snapshot before 09:30 (market open). Pre-fix
// the 2h window expired 30 min after market opened. Widen to 12h so a
// single afternoon catch-up captures the full-day reaction.
const MAX_AGE_MS_EARNINGS = 12 * 60 * 60 * 1000;
const MIN_AGE_MS = 5 * 60 * 1000;      // 5 minutes

// Earnings rows retry across ticks until complete. Pace retries so
// overlapping invocations (route + script) don't hammer Finnhub/Yahoo.
const RETRY_PACING_MS = 10 * 60 * 1000;
// After this long past release, an actual-bearing earnings row counts as
// complete even without a reaction snapshot (bars target T+120; +30 slack).
const REACTION_SETTLE_MS = 150 * 60 * 1000;

// Reaction bars target t_post = release+120m (TWS fetch window ends at
// +125m) — any capture attempt before ~T+115m is a guaranteed-empty
// TWS/Yahoo round. Earnings rows retry every tick (migration 062) so they
// come back; macro rows are single-shot and are NEVER gated (their
// immediate partial capture is by design).
export const REACTION_READY_MS = 115 * 60 * 1000;

function maxAgeFor(event: { source: string; event_type: string }): number {
  if (event.source === "finnhub" || event.event_type === "earnings") {
    return MAX_AGE_MS_EARNINGS;
  }
  return MAX_AGE_MS_MACRO;
}

interface EnrichmentCandidate {
  id: number;
  source: string;
  source_key: string;
  event_type: string;
  event_date: string;
  release_time: string | null;
  /** 'BMO' | 'AMC' | 'TAS' | 'HH:MM' — slot evidence for the pre-print floor. */
  event_time: string | null;
  symbol: string | null;
  title: string;
  consensus_estimate: string | null;
  raw_json: string | null;
  security_id: number | null;
  actual_value: string | null;
  reaction_snapshot: string | null;
  enrichment_attempted_at: string | null;
  wire_probe_empty_at: string | null;
}

export interface EnrichOptions {
  /** Override "now" for testing; defaults to Date.now(). */
  now?: Date;
  /** Enrich just one event by id. Bypasses the time-window filter. */
  eventId?: number;
  /** Optional TWS client for reaction snapshots. */
  tws?: IBApiNext | null;
  /** Max events to enrich per invocation. Defaults to 20. */
  limit?: number;
  /** Pacing override for the TWS path (useful for tests). */
  pacingMs?: number;
  /**
   * Phase 9b: re-run TWS reaction capture for an already-enriched event and
   * overwrite reaction_snapshot even if it's present. Only meaningful with
   * `eventId` + `tws` set. Used by the "Upgrade to TWS" action on calendar
   * rows that were initially enriched via the Worker's Polygon fallback.
   */
  upgradeReactionToTws?: boolean;
}

/**
 * Diagnostic payload attached to a `reason: "pre_print"` result — the floor
 * that refused the row, so a caller can explain the refusal in the user's
 * terms (see describePrePrintFloor) instead of restating the condition.
 */
export interface EnrichmentPrePrintSkip extends PrePrintFloorResult {
  /** The row's event_date — needed to word the refusal (same-day or not). */
  eventDate: string;
}

export interface EnrichmentResult {
  eventId: number;
  source_key: string;
  actual: string | null;
  reaction: ReactionSnapshot | null;
  enriched: boolean;
  reason?: string;
  /** Present exactly when `reason === "pre_print"`. */
  prePrint?: EnrichmentPrePrintSkip;
}

/**
 * Find events whose release window has opened but which haven't been
 * enriched yet. Window: `event_date || ' ' || release_time` must be in
 * [now - 2 hours, now - 5 minutes].
 *
 * The lower bound (-2h) gives macro releases enough time for FRED to
 * publish, and gives earnings-after-close a window wide enough to capture
 * the 16:15 → 18:15 reaction.
 *
 * The upper bound (-5min) avoids racing the releasing agency.
 */
function findCandidates(
  db: Database.Database,
  opts: EnrichOptions,
): EnrichmentCandidate[] {
  const limit = opts.limit ?? 20;
  if (opts.eventId != null) {
    const row = db
      .prepare(
        `SELECT id, source, source_key, event_type, event_date, release_time, event_time,
                symbol, title, consensus_estimate, raw_json, security_id,
                actual_value, reaction_snapshot, enrichment_attempted_at,
                wire_probe_empty_at
         FROM calendar_events
         WHERE id = ?`,
      )
      .get(opts.eventId) as EnrichmentCandidate | undefined;
    return row ? [row] : [];
  }

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  // Cheap pre-filter in SQL: any row with an event_date within the last 3
  // days and release_time set. The final window check happens in JS because
  // release_time is ET wall-clock — `datetime()` comparisons against UTC
  // `now` would silently be off by 4–5 hours across DST.
  const threeDaysAgo = new Date(nowMs - 3 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const today = new Date(nowMs).toISOString().slice(0, 10);

  const rows = db
    .prepare(
      `SELECT id, source, source_key, event_type, event_date, release_time, event_time,
              symbol, title, consensus_estimate, raw_json, security_id,
              actual_value, reaction_snapshot, enrichment_attempted_at,
              wire_probe_empty_at
       FROM calendar_events
       WHERE enriched_at IS NULL
         AND release_time IS NOT NULL
         AND event_date BETWEEN ? AND ?
       ORDER BY event_date DESC, release_time DESC`,
    )
    .all(threeDaysAgo, today) as EnrichmentCandidate[];

  const filtered: EnrichmentCandidate[] = [];
  for (const row of rows) {
    if (!row.release_time) continue;
    const releaseInstant = composeReleaseInstant(row.event_date, row.release_time);
    if (!releaseInstant) continue;
    const ageMs = nowMs - releaseInstant.getTime();
    const maxAge = maxAgeFor(row);
    if (ageMs >= MIN_AGE_MS && ageMs <= maxAge) {
      if (row.enrichment_attempted_at) {
        // datetime('now') format: "YYYY-MM-DD HH:MM:SS" (UTC).
        const attemptedMs = Date.parse(row.enrichment_attempted_at.replace(" ", "T") + "Z");
        if (Number.isFinite(attemptedMs) && nowMs - attemptedMs < RETRY_PACING_MS) continue;
      }
      filtered.push(row);
      if (filtered.length >= limit) break;
    }
  }
  return filtered;
}

function resolveSectorForEarnings(
  db: Database.Database,
  securityId: number | null,
): { sector: string | null; etf: string | null } {
  if (!securityId) return { sector: null, etf: null };
  const row = db
    .prepare("SELECT sector FROM securities WHERE id = ?")
    .get(securityId) as { sector: string | null } | undefined;
  if (!row) return { sector: null, etf: null };
  const etf = resolveSectorEtf("earnings", row.sector);
  return { sector: row.sector, etf };
}

function logSectorGap(
  db: Database.Database,
  symbol: string,
  sector: string | null,
) {
  db.prepare(
    `INSERT INTO sector_etf_gaps (symbol, sector, last_seen_at, count)
     VALUES (?, ?, datetime('now'), 1)
     ON CONFLICT(symbol, sector) DO UPDATE SET
       last_seen_at = datetime('now'),
       count = count + 1`,
  ).run(symbol, sector);
}

// COALESCE on all three payload columns: an enrichment pass may only ADD
// data, never clear it. fetchActualForEvent returns { actual: null }
// gracefully for source_keys it can't dispatch (e.g. 'manual:' events) —
// an unconditional SET here destroyed manually-saved actuals when the
// EarningsHub "gen" button re-ran enrichment before composing, then 409'd
// telling the user to use the override it had just wiped (deep-QA finding
// 2026-06-10). A fresh non-null fetch still overwrites.
//
// enriched_at is stamped only when the pass is COMPLETE (bound ?4 = 1);
// earnings rows retry across ticks until then. enrichment_attempted_at is
// stamped every pass — it drives retry pacing in findCandidates.
const updateEnrichment = (db: Database.Database) =>
  db.prepare(
    `UPDATE calendar_events
     SET actual_value = COALESCE(?, actual_value),
         consensus_value = COALESCE(?, consensus_value),
         reaction_snapshot = COALESCE(?, reaction_snapshot),
         enrichment_attempted_at = datetime('now'),
         enriched_at = CASE WHEN ? THEN COALESCE(enriched_at, datetime('now'))
                            ELSE enriched_at END
     WHERE id = ?`,
  );

/**
 * Reaction-only upgrade path (Phase 9b): overwrite reaction_snapshot but
 * leave actual_value/consensus_value intact. Used when a cloud-enriched
 * row gets re-captured via TWS post-facto.
 */
const updateReactionOnly = (db: Database.Database) =>
  db.prepare(
    `UPDATE calendar_events
     SET reaction_snapshot = ?
     WHERE id = ?`,
  );

/**
 * Run one enrichment pass. Returns per-event results for logging.
 */
export async function runEnrichment(
  db: Database.Database,
  opts: EnrichOptions = {},
): Promise<EnrichmentResult[]> {
  // Phase 9b upgrade path: re-capture reaction for a single event and return.
  if (opts.upgradeReactionToTws && opts.eventId && opts.tws) {
    return runTwsReactionUpgrade(db, opts);
  }

  // Wire-time probe (spec 2026-08-04): pre-release Finnhub check for
  // held/watchlist/reporter earnings inside T−90m. Early prints get their
  // release_time pulled to now and enter THIS tick's candidate list (the
  // normal window filter would make them wait for the next tick).
  let probePrinted: number[] = [];
  if (opts.eventId == null) {
    try {
      probePrinted = (await runWireProbePass(db, { now: opts.now })).printedEventIds;
    } catch (err) {
      console.warn("[enrichment] wire-probe pass failed:", err);
    }
  }

  const limit = opts.limit ?? 20;
  const candidates = findCandidates(db, opts);

  // ── Pre-print floor: the EXPLICIT-EVENT road only (2026-08-28) ──────
  //
  // findCandidates returns an explicitly-requested row WITHOUT the release
  // window filter — that is the whole point of `eventId` (re-enrich an old
  // row, compose a recap on demand). But it also means a human click BEFORE
  // the print reaches the vendor fetch, and one erroneous early vendor
  // actual then writes actual_value, stamps enriched_at (arming the recap
  // send gate) and fires the print push — for a print that has not happened.
  // The windowed sweep cannot do that: its filter already requires
  // releaseInstant <= now - 5 min.
  //
  // Same condition as the manual-actuals save road, from the same helper
  // (lib/earnings/pre-print-floor.ts) — never fork it. Earnings rows use the
  // SLOT floor (16:00 ET after-close / 07:00 ET before-open): for an AMC name
  // the stored release_time is very often the CALL time, not the print (the
  // CRWD/RBRK trap), so the only knowable question is whether the window has
  // opened at all. Non-earnings rows (FRED/FOMC/...) publish at a scheduled
  // instant with no BMO/AMC notion, so they keep the release_time basis.
  if (opts.eventId != null && candidates.length > 0) {
    const event = candidates[0];
    const isEarningsRow =
      event.source === "finnhub" || event.event_type === "earnings";
    const prePrint = checkPrePrintFloor(event, opts.now ?? new Date(), {
      useSlotFloor: isEarningsRow,
    });
    if (prePrint.isPrePrint) {
      return [
        {
          eventId: event.id,
          source_key: event.source_key,
          actual: null,
          reaction: null,
          enriched: false,
          reason: "pre_print",
          prePrint: { ...prePrint, eventDate: event.event_date },
        },
      ];
    }
  }

  for (const id of probePrinted) {
    if (candidates.some((c) => c.id === id)) continue;
    const row = findCandidates(db, { ...opts, eventId: id })[0];
    if (row) candidates.unshift(row);
  }
  // Re-cap to opts.limit: findCandidates already applied it internally, but
  // the probe-printed unshifts above can push the combined list past it.
  // Probe-printed rows stay FIRST (unshifted) — they're the most
  // time-sensitive (an early print, captured this tick) — so the trim drops
  // from the tail; any dropped normal candidate re-enters on the next
  // 15-min tick via the ordinary window filter.
  if (candidates.length > limit) candidates.splice(limit);
  if (candidates.length === 0) return [];

  const update = updateEnrichment(db);
  const results: EnrichmentResult[] = [];

  for (const event of candidates) {
    try {
      const isEarnings =
        event.source === "finnhub" || event.event_type === "earnings";

      const actualResult = event.actual_value
        ? { actual: null, consensus: null } // already captured on a prior attempt
        : await fetchActualForEvent(db, event);

      // Reaction snapshot — only attempt when TWS is available.
      let reaction: ReactionSnapshot | null = null;
      if (event.release_time) {
        const releaseInstant = composeReleaseInstant(
          event.event_date,
          event.release_time,
        );
        if (releaseInstant) {
          let sectorEtf: string | null = null;
          if (event.event_type === "earnings") {
            const resolved = resolveSectorForEarnings(db, event.security_id);
            sectorEtf = resolved.etf;
            // Log gap when an earnings symbol has no mappable sector.
            if (!sectorEtf && event.symbol) {
              logSectorGap(db, event.symbol, resolved.sector);
            }
          } else {
            sectorEtf = resolveSectorEtf(event.event_type, null);
          }
          const eventSymbol =
            event.event_type === "earnings" ? event.symbol : null;

          // Earnings rows retry every tick, so a capture attempt before bars
          // can plausibly exist is a guaranteed-empty TWS/Yahoo round —
          // skip it and let a later tick (past T+115m) do the work. Macro
          // rows are single-shot and are NEVER gated (see REACTION_READY_MS).
          const captureAgeMs =
            (opts.now ?? new Date()).getTime() - releaseInstant.getTime();
          const reactionReady =
            !isEarnings || captureAgeMs >= REACTION_READY_MS;

          // Earnings rows anchor t_pre to the prior regular-session close
          // (2026-08-04) — see captureReactionFromTws. Macro rows keep pure
          // release-window semantics (earnings stays null).
          const earningsAnchor =
            isEarnings
              ? (() => {
                  const closeInstant = composeReleaseInstant(event.event_date, "16:00");
                  return closeInstant
                    ? { closeMs: closeInstant.getTime(), eventDate: event.event_date }
                    : null;
                })()
              : null;

          // Prefer TWS — superior intraday TRADES bars, no upstream rate limit.
          if (opts.tws && reactionReady) {
            reaction = await captureReactionFromTws(
              opts.tws,
              releaseInstant,
              sectorEtf,
              { pacingMs: opts.pacingMs, eventSymbol, earnings: earningsAnchor },
            );
          }

          // Fall back to Yahoo when TWS is unavailable OR returned null
          // (TWS contractDetails timeout, no matching bars, etc.). Same
          // module the Worker cloud-fallback uses, so the resulting JSON
          // shape is identical (source: "yahoo"). Best-effort — never
          // let a Yahoo failure abort enrichment.
          if (!reaction && reactionReady) {
            try {
              reaction = await captureReactionFromYahoo(
                releaseInstant,
                sectorEtf,
                {
                  pacingMs: opts.pacingMs,
                  eventSymbol,
                  earningsCloseMs: earningsAnchor?.closeMs ?? null,
                },
              );
            } catch (err) {
              console.warn(
                `[enrichment] Yahoo fallback failed for event ${event.id}:`,
                err,
              );
            }
          }
        }
      }

      const releaseInstantForAge =
        event.release_time
          ? composeReleaseInstant(event.event_date, event.release_time)
          : null;
      const ageMs = releaseInstantForAge
        ? (opts.now ?? new Date()).getTime() - releaseInstantForAge.getTime()
        : Number.POSITIVE_INFINITY;
      const hasActual = actualResult.actual != null || event.actual_value != null;
      const hasReaction = reaction != null || event.reaction_snapshot != null;
      // Macro rows keep single-shot semantics (complete on first attempt);
      // earnings rows complete only when the actual landed AND the reaction
      // either landed or its capture window has settled.
      const complete = !isEarnings
        ? true
        : hasActual && (hasReaction || ageMs >= REACTION_SETTLE_MS);

      update.run(
        actualResult.actual,
        actualResult.consensus,
        reaction ? JSON.stringify(reaction) : null,
        complete ? 1 : 0,
        event.id,
      );

      // Wire-time observation (spec 2026-08-04): record the first-seen
      // instant on the null→non-null actual transition — covers both the
      // probe road (bounded via wire_probe_empty_at) and the plain
      // post-release road (typically unbounded). Best-effort.
      if (
        isEarnings &&
        event.symbol &&
        event.actual_value == null &&
        actualResult.actual != null
      ) {
        try {
          recordWireObservation(db, {
            symbol: event.symbol,
            eventDate: event.event_date,
            eventId: event.id,
            firstSeenAt: (opts.now ?? new Date()).toISOString(),
            lastEmptyProbeAt: event.wire_probe_empty_at ?? null,
          });
        } catch (err) {
          console.warn(`[wire-probe] observation record failed for ${event.id}:`, err);
        }
      }

      // Push-at-print (Wave 1 §2): fire exactly on the null→non-null actual
      // transition for a covered, unmuted earnings name. Since #13 the gate
      // also opens for a NON-held reporter with ≥1 live read-through pair
      // (target currently held/watchlist) — the push then carries the
      // read-through lines and a "— read-through" title. Best-effort — a
      // push failure never affects enrichment.
      if (
        isEarnings &&
        event.symbol &&
        event.actual_value == null &&
        actualResult.actual != null
      ) {
        try {
          const sym = event.symbol.toUpperCase();
          const status = getSymbolStatus(db, [sym])[sym];
          const settings = getEarningsSettings(db);
          const covered = status === "held" || status === "watchlist";
          const readThroughs = getLiveReadThroughsForReporter(db, sym);
          if (
            (covered || readThroughs.length > 0) &&
            shouldSendEarningsEmail(settings, sym)
          ) {
            await sendEarningsPrintPush({
              eventId: event.id,
              symbol: sym,
              actualValue: actualResult.actual,
              consensusValue: actualResult.consensus ?? event.consensus_estimate,
              reactionJson: reaction
                ? JSON.stringify(reaction)
                : event.reaction_snapshot,
              readThroughs,
              readThroughOnly: !covered,
            });
          }
        } catch (err) {
          console.warn(`[print-push] event ${event.id} failed:`, err);
        }
      }

      results.push({
        eventId: event.id,
        source_key: event.source_key,
        actual: actualResult.actual,
        reaction,
        enriched: complete,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      results.push({
        eventId: event.id,
        source_key: event.source_key,
        actual: null,
        reaction: null,
        enriched: false,
        reason,
      });
    }
  }

  return results;
}

async function runTwsReactionUpgrade(
  db: Database.Database,
  opts: EnrichOptions,
): Promise<EnrichmentResult[]> {
  if (!opts.eventId || !opts.tws) return [];

  const row = db
    .prepare(
      `SELECT id, source, source_key, event_type, event_date, release_time, event_time,
              symbol, title, consensus_estimate, raw_json, security_id,
              actual_value, reaction_snapshot, enrichment_attempted_at
       FROM calendar_events
       WHERE id = ?`,
    )
    .get(opts.eventId) as EnrichmentCandidate | undefined;
  if (!row || !row.release_time) return [];

  const releaseInstant = composeReleaseInstant(row.event_date, row.release_time);
  if (!releaseInstant) {
    return [
      {
        eventId: row.id,
        source_key: row.source_key,
        actual: null,
        reaction: null,
        enriched: false,
        reason: "malformed_release_time",
      },
    ];
  }

  let sectorEtf: string | null = null;
  if (row.event_type === "earnings") {
    const resolved = resolveSectorForEarnings(db, row.security_id);
    sectorEtf = resolved.etf;
    if (!sectorEtf && row.symbol) logSectorGap(db, row.symbol, resolved.sector);
  } else {
    sectorEtf = resolveSectorEtf(row.event_type, null);
  }

  // Same prior-close anchor as the main path — a TWS re-capture must not
  // silently revert an earnings row to window semantics.
  const upgradeAnchor =
    row.event_type === "earnings"
      ? (() => {
          const closeInstant = composeReleaseInstant(row.event_date, "16:00");
          return closeInstant
            ? { closeMs: closeInstant.getTime(), eventDate: row.event_date }
            : null;
        })()
      : null;

  const reaction = await captureReactionFromTws(
    opts.tws,
    releaseInstant,
    sectorEtf,
    {
      pacingMs: opts.pacingMs,
      eventSymbol: row.event_type === "earnings" ? row.symbol : null,
      earnings: upgradeAnchor,
    },
  );

  if (!reaction) {
    return [
      {
        eventId: row.id,
        source_key: row.source_key,
        actual: null,
        reaction: null,
        enriched: false,
        reason: "tws_reaction_unavailable",
      },
    ];
  }

  updateReactionOnly(db).run(JSON.stringify(reaction), row.id);

  return [
    {
      eventId: row.id,
      source_key: row.source_key,
      actual: null,
      reaction,
      enriched: true,
    },
  ];
}

// ── Phase 3: earnings preview/recap sweep ──────────────────────────
//
// Runs alongside the post-release enrichment on the same 15-min launchd
// cadence (scripts/enrich-calendar-events.sh dispatches both per tick).
// Two candidate windows:
//
//   Preview: release_time IS NOT NULL AND
//            now+105min ≤ release_instant ≤ now+135min AND
//            no preview audit row AND
//            symbol in held|watchlist set
//
//   Recap:   enriched_at IS NOT NULL AND
//            now ≤ enriched_at + 4h AND
//            no recap audit row AND
//            symbol in held|watchlist set
//
// The held|watchlist filter prevents emailing about every random earnings
// the user doesn't own. The audit-row filter is the dedup floor — when
// the email lands, the composer's UNIQUE-protected INSERT prevents a
// second tick from re-firing the same event/phase pair.

const PREVIEW_WINDOW_MIN_MS = 105 * 60 * 1000;
const PREVIEW_WINDOW_MAX_MS = 135 * 60 * 1000;
const RECAP_WINDOW_MAX_MS   = 4 * 60 * 60 * 1000;

export interface EmailCandidate {
  eventId: number;
  symbol: string;
  phase: "preview" | "recap";
  /**
   * Read-through reporter recap (feedback #3): the symbol is NOT
   * held/watchlist but has ≥1 live read-through pair — the sweep sends the
   * lean deterministic reporter recap instead of the AI recap, and the wrap
   * suppression must NOT defer it (the debrief never covers non-held names).
   */
  reporterRecap?: boolean;
  reason?: string;
}

interface PreviewCandidateRow {
  id: number;
  symbol: string | null;
  event_date: string;
  release_time: string;
  source: string;
}

interface RecapCandidateRow {
  id: number;
  symbol: string | null;
  event_date: string;
  enriched_at: string;
  source: string;
}

/**
 * Collapse cross-source duplicate rows for the same print. One earnings
 * release can carry TWO calendar_events rows (finnhub + nasdaq scans write
 * distinct source_keys). reconcileEarningsDates marks the non-canonical row
 * superseded=1, but it only runs inside syncCalendarForWeek — in the window
 * between row creation and the next sync BOTH rows are live, and the sweep
 * sent one email per row (2026-06-30 NKE preview ×2). Key on issuer family +
 * event_date so dual-class rows (GOOGL/GOOG) collapse too; prefer the
 * finnhub row, then the lowest id (deterministic across sweep ticks).
 */
function dedupeCrossSourceRows<
  T extends { id: number; symbol: string | null; event_date: string; source: string },
>(rows: T[]): T[] {
  const rank = (r: T) => (r.source === "finnhub" ? 0 : 1);
  const keyOf = (r: T) =>
    `${[...issuerSiblings(r.symbol ?? "")].sort().join(",")}|${r.event_date}`;
  const winners = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    const cur = winners.get(key);
    if (!cur || rank(row) < rank(cur) || (rank(row) === rank(cur) && row.id < cur.id)) {
      winners.set(key, row);
    }
  }
  return rows.filter((row) => winners.get(keyOf(row)) === row);
}

export interface EmailSweepOpts {
  /** Override "now" for testing. */
  now?: Date;
  /** Cap candidates to fire per pass. */
  limit?: number;
}

export function findEmailCandidates(
  db: Database.Database,
  opts: EmailSweepOpts = {},
): EmailCandidate[] {
  const settings = getEarningsSettings(db);
  if (!settings.enabled) return []; // master toggle off → never fire

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const limit = opts.limit ?? 10;

  // ── Preview candidates ──────────────────────────────────────────
  // Pre-filter SQL by event_date proximity to today; final window check is
  // in JS because release_time is ET wall-clock and SQL `datetime()` would
  // silently shift across DST. Same pattern as findCandidates above.
  const todayStr = new Date(nowMs).toISOString().slice(0, 10);
  const tomorrowStr = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const previewRows = db
    .prepare(
      `SELECT ce.id, ce.symbol, ce.event_date, ce.release_time, ce.source
         FROM calendar_events ce
         LEFT JOIN earnings_emails ee
           ON ee.event_id = ce.id AND ee.phase = 'preview'
         LEFT JOIN earnings_email_skips es
           ON es.event_id = ce.id AND es.phase = 'preview'
        WHERE ce.event_type = 'earnings'
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.release_time IS NOT NULL
          AND ce.symbol IS NOT NULL
          AND ce.event_date BETWEEN ? AND ?
          AND ee.id IS NULL
          AND es.id IS NULL`,
    )
    .all(todayStr, tomorrowStr) as PreviewCandidateRow[];

  const inWindowPreviews: PreviewCandidateRow[] = [];
  for (const row of previewRows) {
    const releaseInstant = composeReleaseInstant(row.event_date, row.release_time);
    if (!releaseInstant) continue;
    const msUntilRelease = releaseInstant.getTime() - nowMs;
    if (msUntilRelease >= PREVIEW_WINDOW_MIN_MS && msUntilRelease <= PREVIEW_WINDOW_MAX_MS) {
      inWindowPreviews.push(row);
    }
  }
  const previewCandidates = dedupeCrossSourceRows(inWindowPreviews);

  // ── Recap candidates ────────────────────────────────────────────
  // Gate: actual_value MUST be populated. enriched_at gets set the moment
  // the enrichment runner *attempts* a row — which can succeed for the
  // reaction snapshot while the actual_value capture (FRED / Finnhub /
  // Claude) returns null. Pre-fix the recap fired on enriched_at alone
  // and the AI had no actuals to report; the recap prompt's web_search
  // fallback isn't reliable enough to fill that gap, so the email landed
  // with estimates dressed up as actuals. Now: defer until actuals land.
  // The 4h window starts at enriched_at, so a late actual (Finnhub backfill,
  // manual override) still gets a recap on the next sweep tick.
  const recapCutoff = new Date(nowMs - RECAP_WINDOW_MAX_MS).toISOString().replace("T", " ").slice(0, 19);
  const recapRows = db
    .prepare(
      `SELECT ce.id, ce.symbol, ce.event_date, ce.enriched_at, ce.source
         FROM calendar_events ce
         LEFT JOIN earnings_emails ee
           ON ee.event_id = ce.id AND ee.phase = 'recap'
         LEFT JOIN earnings_email_skips es
           ON es.event_id = ce.id AND es.phase = 'recap'
        WHERE ce.event_type = 'earnings'
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.enriched_at IS NOT NULL
          AND ce.actual_value IS NOT NULL
          AND datetime(ce.enriched_at) >= datetime(?)
          AND ce.symbol IS NOT NULL
          AND ee.id IS NULL
          AND es.id IS NULL`,
    )
    .all(recapCutoff) as RecapCandidateRow[];
  const recapCandidates = dedupeCrossSourceRows(recapRows);

  // ── Read-through reporter recap scan (feedback #3) ──────────────
  // Pure read-through reporters (NOT held/watchlist — those take the AI
  // recap road below) whose print has FIRST ACTUALS captured. Deliberately
  // no enriched_at requirement: the whole point is landing before the open
  // (~T+15–30 min), hours before the reaction snapshot exists. Window is
  // [yesterday, today] — self-healing for an asleep morning; older prints
  // have decayed read-through value and are skipped silently. Scanned HERE
  // so reporter symbols join the status map below — coverage must be
  // resolved for them too (a held symbol whose recap was already audited is
  // absent from recapCandidates, and an unresolved lookup would misread it
  // as a pure reporter).
  const yesterdayStr = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const reporterScanRows = db
    .prepare(
      `SELECT ce.id, ce.symbol, ce.event_date, ce.enriched_at, ce.source
         FROM calendar_events ce
         LEFT JOIN earnings_emails ee
           ON ee.event_id = ce.id AND ee.phase = 'recap'
         LEFT JOIN earnings_email_skips es
           ON es.event_id = ce.id AND es.phase = 'recap'
        WHERE ce.event_type = 'earnings'
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.actual_value IS NOT NULL
          AND ce.event_date BETWEEN ? AND ?
          AND ce.symbol IS NOT NULL
          AND ee.id IS NULL
          AND es.id IS NULL`,
    )
    .all(yesterdayStr, todayStr) as RecapCandidateRow[];
  const reporterCandidates = dedupeCrossSourceRows(reporterScanRows);

  // ── Held|watchlist filter ───────────────────────────────────────
  const allSymbols = Array.from(
    new Set(
      [...previewCandidates, ...recapCandidates, ...reporterCandidates]
        .map((r) => r.symbol)
        .filter((s): s is string => !!s),
    ),
  );
  if (allSymbols.length === 0) return [];

  const status = getSymbolStatus(db, allSymbols);
  const isCovered = (sym: string | null): boolean =>
    !!sym && (status[sym.toUpperCase()] === "held" || status[sym.toUpperCase()] === "watchlist");

  const isAllowed = (sym: string | null): boolean =>
    !!sym && shouldSendEarningsEmail(settings, sym);

  const out: EmailCandidate[] = [];
  for (const row of previewCandidates) {
    if (!row.symbol || !isCovered(row.symbol) || !isAllowed(row.symbol)) continue;
    out.push({ eventId: row.id, symbol: row.symbol, phase: "preview" });
    if (out.length >= limit) return out;
  }
  for (const row of recapCandidates) {
    if (!row.symbol || !isCovered(row.symbol) || !isAllowed(row.symbol)) continue;
    out.push({ eventId: row.id, symbol: row.symbol, phase: "recap" });
    if (out.length >= limit) return out;
  }

  // ── Read-through reporter recaps (feedback #3) ──────────────────
  // NOT covered (pure read-through), reporter not muted, ≥1 live pair
  // (target currently held/watchlist — the same self-narrowing rule as
  // push-at-print).
  for (const row of reporterCandidates) {
    if (!row.symbol || isCovered(row.symbol) || !isAllowed(row.symbol)) continue;
    if (getLiveReadThroughsForReporter(db, row.symbol).length === 0) continue;
    out.push({ eventId: row.id, symbol: row.symbol, phase: "recap", reporterRecap: true });
    if (out.length >= limit) return out;
  }
  return out;
}

