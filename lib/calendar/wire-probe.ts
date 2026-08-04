/**
 * Pre-release Finnhub probe (wire-time spec 2026-08-04): earnings reporters
 * become probe-eligible from T−90m before their resolved release_time. An
 * empty probe stamps calendar_events.wire_probe_empty_at (observation
 * bounding); the first positive probe pulls the event's release_time
 * earlier (earlier-only — evidence wins) and hands the event to the normal
 * enrichment road, which fetches actuals + fires push-at-print this tick.
 *
 * Macro rows are never candidates. Probe attempts deliberately do NOT
 * stamp enrichment_attempted_at (that would interfere with post-release
 * retry pacing); the 15-min enrichment tick is the probe's pacing.
 */
import type Database from "better-sqlite3";
import { probeFinnhubActualExists } from "./enrich-actuals";
import { composeReleaseInstant } from "./reaction-snapshot";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import { getReadThroughReporterSymbols } from "@/lib/queries/read-through-pairs";
import { stampEmptyProbe, etTimeOfInstant } from "@/lib/earnings/wire-times";

export const PROBE_WINDOW_MS = 90 * 60 * 1000;
export const MAX_PROBES_PER_TICK = 6;

export interface ProbeCandidate {
  id: number;
  symbol: string;
  event_date: string;
  release_time: string;
  wire_probe_empty_at: string | null;
}

export function findProbeCandidates(
  db: Database.Database,
  now: Date,
): ProbeCandidate[] {
  const nowMs = now.getTime();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const yesterday = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let rows: Array<ProbeCandidate & { source: string; event_type: string }>;
  try {
    rows = db
      .prepare(
        `SELECT id, symbol, event_date, release_time, wire_probe_empty_at, source, event_type
         FROM calendar_events
         WHERE (source = 'finnhub' OR event_type = 'earnings')
           AND event_type = 'earnings'
           AND symbol IS NOT NULL
           AND actual_value IS NULL
           AND enriched_at IS NULL
           AND release_time IS NOT NULL
           AND COALESCE(superseded, 0) = 0
           AND event_date BETWEEN ? AND ?`,
      )
      .all(yesterday, today) as typeof rows;
  } catch {
    return [];
  }

  const inWindow = rows.filter((r) => {
    const release = composeReleaseInstant(r.event_date, r.release_time);
    if (!release) return false;
    const delta = release.getTime() - nowMs; // >0 = pre-release
    return delta > 0 && delta <= PROBE_WINDOW_MS;
  });
  if (inWindow.length === 0) return [];

  // Held / watchlist / read-through-reporter gate (the enrichment universe).
  const status = getSymbolStatus(db, inWindow.map((r) => r.symbol));
  let reporters: Set<string>;
  try {
    reporters = new Set(
      getReadThroughReporterSymbols(db).map((s: string) => s.toUpperCase()),
    );
  } catch {
    reporters = new Set();
  }
  const gated = inWindow.filter((r) => {
    const st = status[r.symbol.toUpperCase()];
    return st === "held" || st === "watchlist" || reporters.has(r.symbol.toUpperCase());
  });

  gated.sort((a, b) => a.release_time.localeCompare(b.release_time));
  return gated.slice(0, MAX_PROBES_PER_TICK).map((r) => ({
    id: r.id,
    symbol: r.symbol,
    event_date: r.event_date,
    release_time: r.release_time,
    wire_probe_empty_at: r.wire_probe_empty_at,
  }));
}

export async function runWireProbePass(
  db: Database.Database,
  opts: {
    now?: Date;
    /** DI seam for tests; defaults to the real Finnhub probe. */
    probe?: (symbol: string, eventDate: string) => Promise<boolean>;
  } = {},
): Promise<{ printedEventIds: number[] }> {
  const now = opts.now ?? new Date();
  const probe = opts.probe ?? probeFinnhubActualExists;
  const printedEventIds: number[] = [];

  for (const cand of findProbeCandidates(db, now)) {
    let exists = false;
    try {
      exists = await probe(cand.symbol, cand.event_date);
    } catch (err) {
      console.warn(`[wire-probe] ${cand.symbol} probe failed:`, err);
      continue; // best-effort — no stamp on failure (not an empty result)
    }
    if (!exists) {
      stampEmptyProbe(db, cand.id, now);
      continue;
    }
    // Print is out early: pull release_time to the observed instant
    // (earlier-only — evidence wins over any recorded slot).
    const observed = etTimeOfInstant(now.toISOString());
    if (observed && observed < cand.release_time) {
      db.prepare(`UPDATE calendar_events SET release_time = ? WHERE id = ?`).run(
        observed,
        cand.id,
      );
      console.log(
        `[wire-probe] ${cand.symbol} printed early — release_time ${cand.release_time} → ${observed}`,
      );
    }
    printedEventIds.push(cand.id);
  }
  return { printedEventIds };
}
