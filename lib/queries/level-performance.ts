/**
 * Theme D — Level source performance attribution v1.
 *
 * Groups all fired level alerts by `security_levels.source_author`, then
 * scores each source on hit-rate and forward P&L. The scoring is imperfect
 * by design (see below) — the scaffolding exists so scores fill in as
 * alerts accumulate. Early in a user's alert history the view will be
 * mostly empty-state copy.
 *
 * P&L attribution rule (documented on the page):
 *   For each alert, lookForwardPnl = (close_at_window_end - triggered_price)
 *                                     / triggered_price.
 *   window_end = min(today, triggered_at + N days).
 *   We don't adjust for position state at trigger time — if the user was
 *   already long, "acting" on a resistance signal to trim would show an
 *   opposite-sign P&L. This is a known limitation.
 */

import type Database from "better-sqlite3";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { lastFiredDateET } from "@/lib/levels/last-fired-date";
import { SECTOR_TO_ETF } from "@/lib/calendar/reaction-snapshot";
import { normalizeSector } from "@/lib/securities/normalize-sector";

export interface SourcePerformance {
  source_author: string;
  alerts_fired: number;
  levels_created: number;
  hit_rate: number;
  responses: {
    acted: number;
    ignored: number;
    dismissed: number;
    pending: number;
  };
  pnl_acted_30d: number | null;
  pnl_acted_60d: number | null;
  pnl_acted_90d: number | null;
  pnl_ignored_30d: number | null;
  /**
   * Null when either side (acted or ignored) has fewer than 3 samples.
   * Otherwise: pnl_acted_30d - pnl_ignored_30d. Positive means following
   * the source outperformed ignoring it.
   */
  pnl_acted_vs_ignored_30d: number | null;
}

interface LevelRow {
  id: number;
  security_id: number;
  source_author: string;
  is_active: number;
  triggered_at: string | null;
  triggered_price: number | null;
}

interface AlertRow {
  id: number;
  level_id: number;
  security_id: number;
  triggered_at: string;
  triggered_price: number;
  user_response: string;
  source_author: string;
}

function fetchForwardReturn(
  db: Database.Database,
  securityId: number,
  fromDate: string,
  daysOut: number,
): number | null {
  // `fromDate` is the alert's stored fire instant (UTC). The window counts
  // from the EASTERN day it fired on: a bare `new Date(...)` reads the
  // space-separated SQLite shape as local time, and a UTC slice puts an
  // evening fire on the next day.
  const firedDay = lastFiredDateET(fromDate) ?? fromDate.slice(0, 10);
  const targetIso = addDays(firedDay, daysOut);
  // ET day: a UTC slice reads tomorrow from 20:00 ET and widens the window.
  const todayIso = todayET();
  const windowEnd = targetIso < todayIso ? targetIso : todayIso;

  const row = db
    .prepare(
      `SELECT close_price FROM prices
       WHERE security_id = ?
         AND date <= ?
       ORDER BY date DESC
       LIMIT 1`,
    )
    .get(securityId, windowEnd) as { close_price: number } | undefined;
  return row ? row.close_price : null;
}

function pnlPct(startPrice: number, endPrice: number): number {
  if (startPrice === 0) return 0;
  return ((endPrice - startPrice) / startPrice) * 100;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2));
}

/**
 * Main entry: one row per source_author, sorted by alerts_fired desc.
 *
 * A source with at least one ARMED (auto_approved) level is always listed,
 * fired or not: a source whose levels have never been reached is a 0% hit
 * rate, and leaving it out made the leaderboard read as if it did not exist.
 * `minAlerts` (default 1) only gates a source with NO armed level — one known
 * solely through alerts on levels outside the denominator.
 */
export function getSourcePerformance(
  db: Database.Database,
  opts: { minAlerts?: number } = {},
): SourcePerformance[] {
  const minAlerts = opts.minAlerts ?? 1;

  // Inclusive whitelist (scan-filter convention): only auto_approved levels
  // ever arm, so only they belong in the hit-rate denominator. Counting
  // rejected/pending extractions ranked sources by how often the user
  // REJECTED them (a 1-alert source showed a 2.1% "hit rate" off 47 levels).
  const levels = db
    .prepare(
      `SELECT id, security_id, COALESCE(source_author, source) AS source_author,
              is_active, triggered_at, triggered_price
       FROM security_levels
       WHERE (source_author IS NOT NULL OR source = 'user')
         AND review_status = 'auto_approved'`,
    )
    .all() as LevelRow[];

  const alerts = db
    .prepare(
      `SELECT la.id, la.level_id, la.security_id, la.triggered_at,
              la.triggered_price, la.user_response,
              COALESCE(sl.source_author, sl.source) AS source_author
       FROM level_alerts la
       JOIN security_levels sl ON sl.id = la.level_id`,
    )
    .all() as AlertRow[];

  const bySource = new Map<string, { levels: LevelRow[]; alerts: AlertRow[] }>();
  for (const l of levels) {
    if (!bySource.has(l.source_author)) {
      bySource.set(l.source_author, { levels: [], alerts: [] });
    }
    bySource.get(l.source_author)!.levels.push(l);
  }
  for (const a of alerts) {
    if (!bySource.has(a.source_author)) {
      bySource.set(a.source_author, { levels: [], alerts: [] });
    }
    bySource.get(a.source_author)!.alerts.push(a);
  }

  const results: SourcePerformance[] = [];
  for (const [source, group] of bySource) {
    if (group.levels.length === 0 && group.alerts.length < minAlerts) continue;

    // Hit rate = fraction of this source's armed (auto_approved) levels that
    // fired at least once. Both sides must come from the same level set:
    // alerts from levels OUTSIDE the denominator (rejected after firing,
    // pre-review era) made the ratio uncomputable (3 alerts / 1 armed level
    // rendered "300.0%"), and a re-activated level can fire twice, so the
    // numerator counts distinct fired levels, never raw alerts.
    const alertedLevelIds = new Set(group.alerts.map((a) => a.level_id));
    const firedLevels = group.levels.filter((l) =>
      alertedLevelIds.has(l.id),
    ).length;

    const responses = {
      acted:     group.alerts.filter((a) => a.user_response === "acted").length,
      ignored:   group.alerts.filter((a) => a.user_response === "ignored").length,
      dismissed: group.alerts.filter((a) => a.user_response === "dismissed").length,
      pending:   group.alerts.filter((a) => a.user_response === "pending").length,
    };

    // Forward P&L buckets — 30/60/90d windows, computed per alert.
    const pnlByWindow = (response: "acted" | "ignored") => (days: number) => {
      const vals: number[] = [];
      for (const a of group.alerts) {
        if (a.user_response !== response) continue;
        const endPrice = fetchForwardReturn(
          db,
          a.security_id,
          a.triggered_at,
          days,
        );
        if (endPrice == null) continue;
        vals.push(pnlPct(a.triggered_price, endPrice));
      }
      return vals.length >= 3 ? average(vals) : null;
    };

    const pnl_acted_30d = pnlByWindow("acted")(30);
    const pnl_acted_60d = pnlByWindow("acted")(60);
    const pnl_acted_90d = pnlByWindow("acted")(90);
    const pnl_ignored_30d = pnlByWindow("ignored")(30);

    const vs =
      pnl_acted_30d != null && pnl_ignored_30d != null
        ? Number((pnl_acted_30d - pnl_ignored_30d).toFixed(2))
        : null;

    results.push({
      source_author: source,
      alerts_fired: group.alerts.length,
      levels_created: group.levels.length,
      hit_rate:
        group.levels.length > 0
          ? Number(((firedLevels / group.levels.length) * 100).toFixed(1))
          : 0,
      responses,
      pnl_acted_30d,
      pnl_acted_60d,
      pnl_acted_90d,
      pnl_ignored_30d,
      pnl_acted_vs_ignored_30d: vs,
    });
  }

  // Ties (notably the never-fired sources, all at 0) order by armed-level
  // count, then name, so the list does not reshuffle between loads.
  results.sort(
    (a, b) =>
      b.alerts_fired - a.alerts_fired ||
      b.levels_created - a.levels_created ||
      a.source_author.localeCompare(b.source_author),
  );
  return results;
}

/**
 * Query sector_etf_gaps for the Data Health admin panel.
 */
export interface SectorEtfGap {
  symbol: string;
  /** The matching security (symbol compared case-insensitively), or null. */
  securityId: number | null;
  sector: string | null;
  first_seen_at: string;
  last_seen_at: string;
  count: number;
}

export function getSectorEtfGaps(db: Database.Database): SectorEtfGap[] {
  // The write-side upsert keys on PRIMARY KEY (symbol, sector), and SQLite
  // treats NULLs as DISTINCT there — a NULL-sector symbol gains a fresh
  // count=1 row per enrichment tick instead of incrementing. Aggregate at
  // read time (GROUP BY treats NULLs as EQUAL) so duplicates collapse and
  // the most common unmapped symbols actually rise to the top.
  const rows = db
    .prepare(
      // securityId is a scalar lookup, not a join: securities.symbol is
      // unique only case-sensitively, so a join could repeat a gap row and
      // double its SUM. An exact-case match wins, then the lowest id.
      `SELECT g.symbol, g.sector,
              (SELECT s.id FROM securities s
                WHERE UPPER(s.symbol) = UPPER(g.symbol)
                ORDER BY (s.symbol = g.symbol) DESC, s.id
                LIMIT 1) AS securityId,
              MIN(g.first_seen_at) AS first_seen_at,
              MAX(g.last_seen_at) AS last_seen_at,
              SUM(g.count) AS count
       FROM sector_etf_gaps g
       GROUP BY g.symbol, g.sector
       ORDER BY count DESC, last_seen_at DESC`,
    )
    .all() as SectorEtfGap[];

  // Read-time resolution (ruled 2026-10-05): a gap row is a stale capture once
  // its security now carries a sector that maps to a sector ETF. Nothing stored
  // is deleted or rewritten. Share-class forms (BRK.B / BRK/B / BRK-B) match.
  const mappable = new Set<string>();
  const secs = db
    .prepare(`SELECT symbol, sector FROM securities WHERE sector IS NOT NULL`)
    .all() as { symbol: string; sector: string }[];
  for (const s of secs) {
    const canonical = normalizeSector(s.sector) ?? s.sector;
    if (SECTOR_TO_ETF[canonical]) mappable.add(shareClassKey(s.symbol));
  }
  return rows.filter((r) => !mappable.has(shareClassKey(r.symbol)));
}

/** Tolerant share-class key: BRK.B = BRK/B = BRK-B = "BRK B". */
function shareClassKey(symbol: string): string {
  return symbol.toUpperCase().replace(/[./\s-]+/g, "");
}

/**
 * Query the last N release/reaction pairs for a given event type — used
 * by the `query_release_reactions` chat tool.
 */
export interface ReleaseReactionRow {
  event_id: number;
  title: string;
  event_date: string;
  event_type: string;
  symbol: string | null;
  actual_value: string | null;
  consensus_value: string | null;
  reaction_snapshot: string | null;
  /**
   * When the row was enriched (SQLite UTC). Evidence for the reaction
   * validity rule (lib/calendar/reaction-validity.ts): an older snapshot's
   * 0.00% leg on a row enriched before the window ended is not a measurement.
   */
  enriched_at: string | null;
}

export function getRecentReleaseReactions(
  db: Database.Database,
  opts: { eventType?: string; symbol?: string; sinceDate?: string; limit?: number } = {},
): ReleaseReactionRow[] {
  const conds: string[] = ["enriched_at IS NOT NULL"];
  const params: (string | number)[] = [];

  if (opts.eventType) {
    if (opts.eventType.startsWith("earnings_")) {
      conds.push("event_type = 'earnings'");
      conds.push("symbol = ?");
      params.push(opts.eventType.slice("earnings_".length));
    } else {
      conds.push("event_type = ?");
      params.push(opts.eventType);
    }
  }
  if (opts.symbol) {
    conds.push("symbol = ?");
    params.push(opts.symbol);
  }
  if (opts.sinceDate) {
    conds.push("event_date >= ?");
    params.push(opts.sinceDate);
  }

  const limit = opts.limit ?? 10;
  return db
    .prepare(
      `SELECT id AS event_id, title, event_date, event_type, symbol,
              actual_value, consensus_value, reaction_snapshot, enriched_at
       FROM calendar_events
       WHERE ${conds.join(" AND ")}
       ORDER BY event_date DESC
       LIMIT ?`,
    )
    .all(...params, limit) as ReleaseReactionRow[];
}
