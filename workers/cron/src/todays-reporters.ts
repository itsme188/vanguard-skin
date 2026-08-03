/**
 * "Today's reporters" — Worker assembly for the cloud fallback digest (#18).
 *
 * Builds the same deterministic block the Mac's
 * lib/digest/todays-reporters.ts composes, but from the R2 state snapshot:
 * calendarEvents (today's earnings, superseded skipped, finnhub-preferred
 * dedup), heldSymbols/watchlistSymbols (v8) for position chips, and
 * earningsIntel (v9) for the implied-move column. ZERO subrequests — all
 * snapshot data. Pre-v8/v9 snapshots degrade (chips/impl render "—"),
 * never throw.
 *
 * Accepted divergence from the Mac: no read-through table in the snapshot,
 * so an `rt` name renders "—" in a cloud digest (documented in the spec).
 *
 * Spec: docs/superpowers/specs/2026-07-16-todays-reporters-digest-block-design.md
 */

import { resolveExpectedMove } from "./expected-move";
import type { Snapshot, CalendarEventRow } from "./state";
import { issuerSiblings } from "./fallback-earnings";
import {
  renderTodaysReportersBlock,
  type ReporterRowView,
} from "./todays-reporters-render";

/**
 * Mirrors the Mac slotFor precedence (lib/digest/todays-reporters.ts).
 * Title matched only on phrases, never raw "BMO"/"AMC" — Bank of
 * Montreal's ticker collides (2026-07-16 review finding).
 */
function slotFor(e: {
  event_time: string | null;
  title: string | null;
  release_time: string | null;
}): string {
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

/**
 * Compact "$3.80 · $12.84B" consensus — same output shape as the Mac's
 * formatFinnhubFigureCompact for Finnhub-shaped strings ("EPS X · Rev N").
 */
function formatCompactConsensus(raw: string | null): string | null {
  if (!raw) return null;
  const parts: string[] = [];
  const epsMatch = /EPS\s+(-?\d+(?:\.\d+)?)/i.exec(raw);
  if (epsMatch) parts.push(`$${Number(epsMatch[1]).toFixed(2)}`);
  const revMatch = /Rev\s+([\d.,]+)/i.exec(raw);
  if (revMatch) {
    const n = Number(revMatch[1].replace(/,/g, ""));
    if (Number.isFinite(n)) {
      if (n >= 1_000_000_000) parts.push(`$${(n / 1_000_000_000).toFixed(2)}B`);
      else if (n >= 1_000_000) parts.push(`$${(n / 1_000_000).toFixed(1)}M`);
      else parts.push(`$${n.toLocaleString("en-US")}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function buildTodaysReportersBlock(
  snapshot: Snapshot,
  today: string,
): string | null {
  try {
    const candidates = snapshot.calendarEvents.filter(
      (e) =>
        e.event_type === "earnings" &&
        e.event_date === today &&
        e.symbol &&
        !(e as { superseded?: number }).superseded,
    );
    if (candidates.length === 0) return null;

    // Finnhub-preferred dedup per print — the Hub's ROW_NUMBER rule.
    const byKey = new Map<string, CalendarEventRow>();
    for (const e of candidates) {
      const key = `${e.symbol!.toUpperCase()}|${e.event_date}`;
      const prev = byKey.get(key);
      if (!prev || (prev.source !== "finnhub" && e.source === "finnhub")) {
        byKey.set(key, e);
      }
    }

    // Family-aware position sets (B20 rule: never symbol-string-equal).
    const held = new Set((snapshot.heldSymbols ?? []).map((s) => s.toUpperCase()));
    const watch = new Set((snapshot.watchlistSymbols ?? []).map((s) => s.toUpperCase()));
    const inFamily = (sym: string, set: Set<string>) =>
      issuerSiblings(sym).some((s) => set.has(s.toUpperCase()));

    const intelById = new Map<
      number,
      { pct: number; method: "straddle" | "iv_approx" | null }
    >();
    for (const r of snapshot.earningsIntel ?? []) {
      if (r.impliedMovePct != null)
        intelById.set(r.eventId, { pct: r.impliedMovePct, method: r.impliedMethod });
    }
    // Sheet > straddle > iv_approx (feedback #5) — mirrored resolver over the
    // snapshot's bogey rows (pure, no extra subrequests). Pre-8/03 snapshots
    // lack expected_move_pct → degrades to the market-derived number.
    const bogeysByEvent = new Map<
      number,
      Array<{ expectedMovePct: number | null; sourceLabel: string | null; uploadedAt: string | null }>
    >();
    for (const b of snapshot.earningsBogeys ?? []) {
      if ((b.expected_move_pct ?? null) == null) continue;
      const list = bogeysByEvent.get(b.event_id) ?? [];
      list.push({
        expectedMovePct: b.expected_move_pct ?? null,
        sourceLabel: b.source_label,
        uploadedAt: b.uploaded_at,
      });
      bogeysByEvent.set(b.event_id, list);
    }

    const rows: ReporterRowView[] = [...byKey.values()].map((e) => {
      const sym = e.symbol!.toUpperCase();
      const releaseTime = (e as { release_time?: string | null }).release_time ?? null;
      const chip = inFamily(sym, held) ? "held" : inFamily(sym, watch) ? "wl" : "";
      const resolved = resolveExpectedMove({
        bogeys: bogeysByEvent.get(e.id) ?? [],
        impliedMovePct: intelById.get(e.id)?.pct ?? null,
        impliedMethod: intelById.get(e.id)?.method ?? null,
      });
      const impl = resolved
        ? `±${resolved.pct.toFixed(1)}%${resolved.method === "sheet" ? " (sheet)" : ""}`
        : null;
      return {
        slot: slotFor({ event_time: e.event_time, title: e.title, release_time: releaseTime }),
        time: releaseTime,
        symbol: sym,
        chip,
        cons: formatCompactConsensus(e.consensus_estimate),
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
      `[todays-reporters] cloud block failed, digest continues without it: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
