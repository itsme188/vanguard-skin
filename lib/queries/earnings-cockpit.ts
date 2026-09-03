/**
 * Row set + assembly for the earnings-day cockpit. Read-only over the
 * pipeline: renders sweep/enrichment state, never advances it.
 * Spec: docs/superpowers/specs/2026-07-08-earnings-cockpit-design.md
 */
import type Database from "better-sqlite3";
import {
  deriveEventStages,
  type EventStages,
} from "@/lib/earnings/cockpit-stages";
import { getEmailStatesForEvents, getSentPhasesForEvents } from "@/lib/queries/earnings-emails";
import { getSkippedPhasesForEvents } from "@/lib/queries/earnings-skips";
import {
  getSymbolStatusDetailed,
  coveredForEvents,
  getSecurityIdForSymbolWithSiblings,
} from "@/lib/queries/briefing-symbols";
import { getEarningsSettings } from "@/lib/queries/earnings-settings";
import { getCallNotePresenceForEvents } from "@/lib/queries/earnings-call-notes";
import { applyClusterManualActuals } from "@/lib/queries/manual-actuals-cluster";
import { getNetExposureForSymbolFamilies } from "@/lib/compute/exposure";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";

/** Implied-move + history-summary decoration for a cockpit row. */
export interface CockpitIntel {
  impliedMovePct: number | null;
  impliedMethod: "sheet" | "straddle" | "iv_approx" | null;
  /** The winning bogey's source_label when impliedMethod === "sheet". */
  sheetSourceLabel: string | null;
  histAvgAbsMovePct: number | null;
  histBeatCount: number;
  histQuarterCount: number;
}

export interface CockpitRow {
  eventId: number;
  symbol: string;
  securityId: number | null;
  title: string;
  eventDate: string;
  eventTime: string | null;
  releaseTime: string | null;
  symbolStatus: "held" | "watchlist" | "armed";
  consensus: string;
  actual: string | null;
  stages: EventStages;
  netExposure: number;
  isTopExposure: boolean;
  hasCallNote: boolean;
  carryover: boolean;
  /** Earnings-intel decoration (implied move + history summary) — populated
   *  by decorateCockpitIntel in the route, NOT by buildCockpitPayload (this
   *  query stays network-free). */
  intel: CockpitIntel | null;
}

export interface CockpitPayload {
  generatedAt: string;
  nextRelease: { eventId: number; symbol: string; releaseInstant: string } | null;
  lanes: { bmo: CockpitRow[]; amc: CockpitRow[]; unknown: CockpitRow[] };
  carryover: CockpitRow[];
  skippedRows: number;
}

interface RawEventRow {
  id: number;
  source: string;
  event_date: string;
  event_time: string | null;
  release_time: string | null;
  title: string;
  symbol: string;
  security_id: number | null;
  consensus_estimate: string | null;
  consensus_value: string | null;
  actual_value: string | null;
  reaction_snapshot: string | null;
  manual_actuals_at: string | null;
}

function laneFor(row: RawEventRow): "bmo" | "amc" | "unknown" {
  const t = row.event_time?.toUpperCase() ?? "";
  if (t.includes("BMO")) return "bmo";
  if (t.includes("AMC")) return "amc";
  if (row.release_time) return row.release_time < "12:00" ? "bmo" : "amc";
  return "unknown";
}

export function buildCockpitPayload(
  db: Database.Database,
  now: Date = new Date()
): CockpitPayload {
  const today = todayET(now);
  const yesterday = addDays(today, -1);

  // Finnhub-preferred dedup, same PARTITION as getEarningsForWeekDeduped.
  const raw = db
    .prepare(
      `WITH ranked AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY UPPER(symbol), event_date, event_type
                  ORDER BY CASE WHEN source = 'finnhub' THEN 0 ELSE 1 END ASC,
                           datetime(created_at) DESC
                ) AS rn
           FROM calendar_events
          WHERE event_date IN (?, ?)
            AND event_type = 'earnings'
            AND COALESCE(superseded, 0) = 0
            AND symbol IS NOT NULL
       )
       SELECT id, source, event_date, event_time, release_time, title, symbol,
              security_id, consensus_estimate, consensus_value, actual_value,
              reaction_snapshot, manual_actuals_at
         FROM ranked
        WHERE rn = 1
        ORDER BY event_date ASC, release_time ASC NULLS LAST, symbol ASC`
    )
    .all(today, yesterday) as RawEventRow[];

  // deriveEventStages runs the plausibility guard on manual_actuals_at, and
  // the dedup above keeps only one twin per print — resolve the acceptance
  // across the whole cluster so a canonical flip can't re-hide an actual the
  // desk accepted (lib/queries/manual-actuals-cluster.ts).
  applyClusterManualActuals(db, raw);

  if (raw.length === 0) {
    return {
      generatedAt: now.toISOString(),
      nextRelease: null,
      lanes: { bmo: [], amc: [], unknown: [] },
      carryover: [],
      skippedRows: 0,
    };
  }

  const rawById = new Map<number, RawEventRow>(raw.map((r) => [r.id, r]));
  const eventIds = raw.map((r) => r.id);
  // [M1] Chip inputs. `held` / `watchlist` are family-aware SYMBOL facts and
  // come straight from the reasons; `armed` is NOT taken from the reasons here,
  // because that reason is a symbol fact over [todayET(), +14] and this surface
  // keeps rows by EVENT coverage — yesterday's armed carryover, and a
  // cluster-covered twin, both sit outside it and used to come back "neither"
  // for the row to cast away. Below, armed is what is LEFT once held and
  // watchlist are false, which is true by construction because `kept` is
  // exactly `coveredIds`. Display-only either way (spec §4.1).
  const statusReasons = getSymbolStatusDetailed(db, raw.map((r) => r.symbol));
  const coveredIds = coveredForEvents(db, raw.map((r) => ({ symbol: r.symbol, eventId: r.id })));
  const emailStates = getEmailStatesForEvents(db, eventIds);
  const sentPhases = getSentPhasesForEvents(db, eventIds);
  const skipMap = getSkippedPhasesForEvents(db, eventIds);
  const notePresence = getCallNotePresenceForEvents(db, eventIds);
  const settings = getEarningsSettings(db);
  const mutedSet = new Set(settings.mutedSymbols.map((s) => s.toUpperCase()));

  // Family-aware mute (mirrors the sweep + push-at-print gates).
  const isMuted = (symbol: string) =>
    issuerSiblings(symbol).some((s) => mutedSet.has(s.toUpperCase()));

  // Keep held + watchlist + armed (event-scoped).
  const kept = raw.filter((r) => coveredIds.has(r.id));

  const exposureMap = getNetExposureForSymbolFamilies(
    db,
    kept.map((r) => r.symbol)
  );

  let skippedRows = 0;
  const rows: CockpitRow[] = [];
  for (const r of kept) {
    try {
      const stages = deriveEventStages(
        r,
        emailStates[r.id] ?? { preview: null, recap: null },
        skipMap[r.id] ?? { preview: false, recap: false },
        isMuted(r.symbol),
        now,
        today
      );
      const isCarryover = r.event_date === yesterday;
      if (isCarryover) {
        // Only unfinished yesterday rows stay: recap neither sent nor skipped.
        const sent = sentPhases[r.id]?.recap ?? false;
        const skipped = skipMap[r.id]?.recap ?? false;
        if (sent || skipped || isMuted(r.symbol)) continue;
      }
      const reasons = statusReasons[r.symbol.toUpperCase()]?.reasons;
      rows.push({
        eventId: r.id,
        symbol: r.symbol,
        securityId:
          r.security_id ?? getSecurityIdForSymbolWithSiblings(db, r.symbol),
        title: r.title,
        eventDate: r.event_date,
        eventTime: r.event_time,
        releaseTime: r.release_time,
        // `kept` is already restricted to coveredIds (held/watchlist/armed,
        // R10), so a row that is neither held nor on the watchlist is here
        // BECAUSE it is armed — no cast, and no dependence on the symbol-level
        // armed horizon.
        symbolStatus: reasons?.held ? "held" : reasons?.watchlist ? "watchlist" : "armed",
        consensus: formatFinnhubFigureCompact(r.consensus_value ?? r.consensus_estimate),
        // An implausible Finnhub actual is withheld from the cons→actual
        // figures line (the "act ⚠" stage chip carries the flag) — same
        // guard-at-the-consumer treatment as the EarningsHub's blanked cells.
        actual:
          r.actual_value && stages.actual !== "implausible"
            ? formatFinnhubFigureCompact(r.actual_value)
            : null,
        stages,
        netExposure: exposureMap[r.symbol] ?? 0,
        isTopExposure: false, // set per-lane below
        hasCallNote: notePresence.has(r.id),
        carryover: isCarryover,
        intel: null, // decorated by decorateCockpitIntel in the route
      });
    } catch (err) {
      skippedRows += 1;
      console.warn(`[cockpit] Skipped event ${r.id} (${r.symbol}):`, err);
    }
  }

  const carryover = rows.filter((r) => r.carryover);
  const todayRows = rows.filter((r) => !r.carryover);
  const lanes = {
    bmo: todayRows.filter((r) => laneFor(rawById.get(r.eventId)!) === "bmo"),
    amc: todayRows.filter((r) => laneFor(rawById.get(r.eventId)!) === "amc"),
    unknown: todayRows.filter((r) => laneFor(rawById.get(r.eventId)!) === "unknown"),
  };

  // Weight marker: largest |netExposure| per lane (and for the carryover strip).
  for (const group of [lanes.bmo, lanes.amc, lanes.unknown, carryover]) {
    let top: CockpitRow | null = null;
    for (const row of group) {
      if (row.netExposure !== 0 && (!top || Math.abs(row.netExposure) > Math.abs(top.netExposure))) {
        top = row;
      }
    }
    if (top) top.isTopExposure = true;
  }

  // Countdown target: earliest not-yet-released instant among today's rows.
  let nextRelease: CockpitPayload["nextRelease"] = null;
  for (const row of todayRows) {
    const inst = row.stages.released;
    if (inst.state === "upcoming" && inst.releaseInstant) {
      if (!nextRelease || inst.releaseInstant < nextRelease.releaseInstant) {
        nextRelease = {
          eventId: row.eventId,
          symbol: row.symbol,
          releaseInstant: inst.releaseInstant,
        };
      }
    }
  }

  return {
    generatedAt: now.toISOString(),
    nextRelease,
    lanes,
    carryover,
    skippedRows,
  };
}
