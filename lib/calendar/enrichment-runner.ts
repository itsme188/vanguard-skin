/**
 * Orchestrates post-release enrichment for calendar events.
 *
 * Shared between the launchd-driven cron script and the on-demand
 * `POST /api/calendar/enrich` route. Keeps all scheduling semantics
 * (window, TWS detection, sector-gap logging) in one place.
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
  symbol: string | null;
  title: string;
  consensus_estimate: string | null;
  raw_json: string | null;
  security_id: number | null;
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

export interface EnrichmentResult {
  eventId: number;
  source_key: string;
  actual: string | null;
  reaction: ReactionSnapshot | null;
  enriched: boolean;
  reason?: string;
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
        `SELECT id, source, source_key, event_type, event_date, release_time,
                symbol, title, consensus_estimate, raw_json, security_id
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
      `SELECT id, source, source_key, event_type, event_date, release_time,
              symbol, title, consensus_estimate, raw_json, security_id
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

const updateEnrichment = (db: Database.Database) =>
  db.prepare(
    `UPDATE calendar_events
     SET actual_value = ?,
         consensus_value = COALESCE(?, consensus_value),
         reaction_snapshot = ?,
         enriched_at = datetime('now')
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

  const candidates = findCandidates(db, opts);
  if (candidates.length === 0) return [];

  const update = updateEnrichment(db);
  const results: EnrichmentResult[] = [];

  for (const event of candidates) {
    try {
      const actualResult = await fetchActualForEvent(db, event);

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

          // Prefer TWS — superior intraday TRADES bars, no upstream rate limit.
          if (opts.tws) {
            reaction = await captureReactionFromTws(
              opts.tws,
              releaseInstant,
              sectorEtf,
              { pacingMs: opts.pacingMs, eventSymbol },
            );
          }

          // Fall back to Yahoo when TWS is unavailable OR returned null
          // (TWS contractDetails timeout, no matching bars, etc.). Same
          // module the Worker cloud-fallback uses, so the resulting JSON
          // shape is identical (source: "yahoo"). Best-effort — never
          // let a Yahoo failure abort enrichment.
          if (!reaction) {
            try {
              reaction = await captureReactionFromYahoo(
                releaseInstant,
                sectorEtf,
                { pacingMs: opts.pacingMs, eventSymbol },
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

      update.run(
        actualResult.actual,
        actualResult.consensus,
        reaction ? JSON.stringify(reaction) : null,
        event.id,
      );

      results.push({
        eventId: event.id,
        source_key: event.source_key,
        actual: actualResult.actual,
        reaction,
        enriched: true,
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
      `SELECT id, source, source_key, event_type, event_date, release_time,
              symbol, title, consensus_estimate, raw_json, security_id
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

  const reaction = await captureReactionFromTws(
    opts.tws,
    releaseInstant,
    sectorEtf,
    {
      pacingMs: opts.pacingMs,
      eventSymbol: row.event_type === "earnings" ? row.symbol : null,
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

import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import {
  getEarningsSettings,
  shouldSendEarningsEmail,
} from "@/lib/queries/earnings-settings";

const PREVIEW_WINDOW_MIN_MS = 105 * 60 * 1000;
const PREVIEW_WINDOW_MAX_MS = 135 * 60 * 1000;
const RECAP_WINDOW_MAX_MS   = 4 * 60 * 60 * 1000;

export interface EmailCandidate {
  eventId: number;
  symbol: string;
  phase: "preview" | "recap";
  reason?: string;
}

interface PreviewCandidateRow {
  id: number;
  symbol: string | null;
  event_date: string;
  release_time: string;
}

interface RecapCandidateRow {
  id: number;
  symbol: string | null;
  enriched_at: string;
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
      `SELECT ce.id, ce.symbol, ce.event_date, ce.release_time
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

  const previewCandidates: PreviewCandidateRow[] = [];
  for (const row of previewRows) {
    const releaseInstant = composeReleaseInstant(row.event_date, row.release_time);
    if (!releaseInstant) continue;
    const msUntilRelease = releaseInstant.getTime() - nowMs;
    if (msUntilRelease >= PREVIEW_WINDOW_MIN_MS && msUntilRelease <= PREVIEW_WINDOW_MAX_MS) {
      previewCandidates.push(row);
    }
  }

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
      `SELECT ce.id, ce.symbol, ce.enriched_at
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

  // ── Held|watchlist filter ───────────────────────────────────────
  const allSymbols = Array.from(
    new Set(
      [...previewCandidates, ...recapRows]
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
  for (const row of recapRows) {
    if (!row.symbol || !isCovered(row.symbol) || !isAllowed(row.symbol)) continue;
    out.push({ eventId: row.id, symbol: row.symbol, phase: "recap" });
    if (out.length >= limit) return out;
  }
  return out;
}

export interface EmailSweepResult {
  candidate: EmailCandidate;
  ok: boolean;
  status: number;
  body: string;
  durationMs: number;
}

/**
 * Run one email-sweep pass. Posts each candidate to its respective
 * cron-authenticated endpoint. The endpoints in turn invoke the composer,
 * which writes the audit row on success — that single source of truth
 * dedups across this sweep + manual fires + (Phase 4) Worker fallback.
 *
 * Caller passes `baseUrl` (e.g. `http://localhost:3000` or `:3099`) and
 * the cron secret. Returns per-candidate results for log emission.
 */
export async function runEmailSweep(
  db: Database.Database,
  opts: EmailSweepOpts & { baseUrl: string; cronSecret: string },
): Promise<EmailSweepResult[]> {
  const candidates = findEmailCandidates(db, opts);
  const results: EmailSweepResult[] = [];

  for (const cand of candidates) {
    const t0 = Date.now();
    const path = cand.phase === "preview"
      ? "/api/cron/earnings-preview"
      : "/api/cron/earnings-recap";
    try {
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cron-Secret": opts.cronSecret,
        },
        body: JSON.stringify({ eventId: cand.eventId }),
      });
      const body = await res.text();
      results.push({
        candidate: cand,
        ok: res.ok,
        status: res.status,
        body: body.slice(0, 500),
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      results.push({
        candidate: cand,
        ok: false,
        status: 0,
        body: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
    }
  }
  return results;
}
