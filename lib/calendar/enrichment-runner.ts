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
      if (opts.tws && event.release_time) {
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
          reaction = await captureReactionFromTws(
            opts.tws,
            releaseInstant,
            sectorEtf,
            {
              pacingMs: opts.pacingMs,
              eventSymbol: event.event_type === "earnings" ? event.symbol : null,
            },
          );
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
