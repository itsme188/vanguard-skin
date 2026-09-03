/**
 * "Today's reporters" — Mac assembly for the morning-digest block (#18).
 *
 * Deterministic table of today-ET's earnings reporters: slot + release
 * time, symbol, position chip, compact consensus, cached implied move.
 * Reuses getEarningsForWeekDeduped so the digest can never disagree with
 * the EarningsHub about who reports (superseded-filtered, family-deduped).
 * Intel is READ-ONLY from earnings_intel — the digest never computes it
 * (no IBKR/AV calls at digest time; same rule as decorateCockpitIntel).
 *
 * Never throws: any failure logs one warn and returns null — the digest
 * is never blocked by this block (the 5/20 silent-outage lesson inverted:
 * degrade loudly-in-logs, never fatally).
 *
 * Spec: docs/superpowers/specs/2026-07-16-todays-reporters-digest-block-design.md
 */

import { resolveExpectedMove } from "@/lib/earnings/expected-move";
import { getExpectedMoveBogeysForEvents } from "@/lib/queries/earnings-bogeys";
import type Database from "better-sqlite3";
import { todayET, mondayOf } from "@/lib/calendar/date-utils";
import { getEarningsForWeekDeduped } from "@/lib/queries/calendar";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import { getReadThroughReporterSymbols } from "@/lib/queries/read-through-pairs";
import { formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";
import { effectiveConsensus } from "@/lib/calendar/consensus";
import {
  renderTodaysReportersBlock,
  type ReporterRowView,
} from "@/lib/digest/todays-reporters-render";
import type { CalendarEvent } from "@/lib/types";

/**
 * Release slot: event_time slot marker → title PHRASE → release_time
 * before/after noon → TBD. The title is matched only on "BEFORE MARKET" /
 * "AFTER MARKET" phrases, never raw "BMO"/"AMC" — Bank of Montreal's
 * ticker IS "BMO" and its title "BMO earnings (After Market Close)" must
 * classify as AMC (2026-07-16 review finding on the wrap-cluster sibling).
 */
function slotFor(e: Pick<CalendarEvent, "event_time" | "title" | "release_time">): string {
  const et = (e.event_time ?? "").trim().toUpperCase();
  if (et === "BMO") return "BMO";
  if (et === "AMC") return "AMC";
  const title = (e.title ?? "").toUpperCase();
  if (title.includes("BEFORE MARKET")) return "BMO";
  if (title.includes("AFTER MARKET")) return "AMC";
  if (e.release_time) return e.release_time < "12:00" ? "BMO" : "AMC";
  return "TBD";
}

const SLOT_ORDER: Record<string, number> = { BMO: 0, AMC: 1, TBD: 2 };

export function composeTodaysReportersBlock(
  db: Database.Database,
  opts: { today?: string } = {},
): string | null {
  try {
    const today = opts.today ?? todayET();
    const events = getEarningsForWeekDeduped(db, mondayOf(today)).filter(
      (e) => e.event_date === today && e.symbol,
    );
    if (events.length === 0) return null;

    const symbols = events.map((e) => e.symbol!) ;
    const status = getSymbolStatus(db, symbols);
    const rtSet = new Set(getReadThroughReporterSymbols(db).map((s) => s.toUpperCase()));

    const intelById = new Map<
      number,
      { pct: number; method: "straddle" | "iv_approx" | null }
    >();
    const placeholders = events.map(() => "?").join(",");
    const intelRows = db
      .prepare(
        `SELECT event_id, implied_move_pct, implied_method FROM earnings_intel
          WHERE event_id IN (${placeholders}) AND implied_move_pct IS NOT NULL`,
      )
      .all(...events.map((e) => e.id)) as {
      event_id: number;
      implied_move_pct: number;
      implied_method: "straddle" | "iv_approx" | null;
    }[];
    for (const r of intelRows)
      intelById.set(r.event_id, { pct: r.implied_move_pct, method: r.implied_method });
    // Sheet > straddle > iv_approx (feedback #5) — this is the line the user
    // reads BEFORE the print, the exact surface from the AAPL ±1.5% incident.
    const bogeyMoves = getExpectedMoveBogeysForEvents(db, events.map((e) => e.id));

    const rows: ReporterRowView[] = events.map((e) => {
      const sym = e.symbol!.toUpperCase();
      const st = status[sym];
      const chip = st === "held" ? "held" : st === "watchlist" ? "wl" : st === "armed" ? "armed" : rtSet.has(sym) ? "rt" : "";
      // consensus_value (enrichment-corrected) wins over the sync-time
      // consensus_estimate — same precedence as renderHeadlineTable + the
      // Today tab (7/28 review follow-up: email-surface parity).
      const consCompact = formatFinnhubFigureCompact(effectiveConsensus(e));
      const resolved = resolveExpectedMove({
        bogeys: bogeyMoves.get(e.id) ?? [],
        impliedMovePct: intelById.get(e.id)?.pct ?? null,
        impliedMethod: intelById.get(e.id)?.method ?? null,
      });
      const impl = resolved
        ? `±${resolved.pct.toFixed(1)}%${resolved.method === "sheet" ? " (sheet)" : ""}`
        : null;
      return {
        slot: slotFor(e),
        time: e.release_time ?? null,
        symbol: sym,
        chip,
        cons: consCompact || null,
        impl,
      };
    });

    rows.sort(
      (a, b) =>
        (SLOT_ORDER[a.slot] ?? 9) - (SLOT_ORDER[b.slot] ?? 9) ||
        (a.time ?? "99:99").localeCompare(b.time ?? "99:99") ||
        a.symbol.localeCompare(b.symbol),
    );

    return renderTodaysReportersBlock(rows);
  } catch (err) {
    console.warn(
      `[todays-reporters] block failed, digest continues without it: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
