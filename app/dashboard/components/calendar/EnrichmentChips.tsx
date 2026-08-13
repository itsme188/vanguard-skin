"use client";

import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot";
import { formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";
import { parseStoredTimestamp } from "@/lib/format";

/**
 * Compact post-release result chips for the Calendar page event row.
 *
 * Rendering is defensive: callers pass raw `actual_value` (string) and
 * `reaction_snapshot` (JSON text). This component parses the snapshot on
 * the client so server components don't have to re-serialize.
 */

export function parseReactionSnapshot(
  raw: string | null,
): ReactionSnapshot | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReactionSnapshot;
  } catch {
    return null;
  }
}

/**
 * A stored snapshot only belongs to a print when its t0 falls on the event's
 * own date, compared in ET wall-clock (an evening AMC print rolls the UTC
 * date past midnight). composeReleaseInstant writes t0 from event_date so
 * they agree at write time — but a later date correction strands a snapshot
 * measured for a different day on this row. Missing/unparseable t0 fails
 * closed: better no reaction than a wrong one. Shared by WeekAheadView's
 * releasedFigureGates and TodayReleases — do not fork this check.
 */
export function snapshotCoversEventDate(
  eventDate: string | null | undefined,
  snap: ReactionSnapshot | null,
): boolean {
  if (!eventDate || !snap?.t0_utc) return false;
  const t0 = new Date(snap.t0_utc);
  if (isNaN(t0.getTime())) return false;
  // en-CA renders YYYY-MM-DD; timeZone anchors to ET per repo convention.
  const etDate = t0.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return etDate === eventDate;
}

function deltaClass(pct: number | null | undefined): string {
  if (pct == null) return "text-ink-faint";
  if (pct > 0.05) return "text-up";
  if (pct < -0.05) return "text-down";
  return "text-ink-dim";
}

function fmtDelta(pct: number | null | undefined): string {
  if (pct == null) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export interface ReactionPair {
  label: string;
  pct: number | null;
}

/**
 * Which two deltas the collapsed summary line shows. Default is the
 * Calendar-row treatment (SPY / QQQ). `preferEventSymbol` leads with the
 * event's own stock when the snapshot captured one (earnings rows), so a
 * week-view card can read "AMZN +9.09% / SPY +0.11%"; macro snapshots have
 * no symbol reaction and degrade to SPY / QQQ.
 */
export function reactionSummaryPairs(
  snapshot: ReactionSnapshot | null,
  opts: { preferEventSymbol?: boolean } = {},
): ReactionPair[] {
  if (!snapshot) return [];
  if (opts.preferEventSymbol && snapshot.symbol) {
    return [
      { label: snapshot.symbol.symbol, pct: snapshot.symbol.delta_pct ?? null },
      { label: "SPY", pct: snapshot.spy?.delta_pct ?? null },
    ];
  }
  return [
    { label: "SPY", pct: snapshot.spy?.delta_pct ?? null },
    { label: "QQQ", pct: snapshot.qqq?.delta_pct ?? null },
  ];
}

/**
 * Inline summary for the collapsed event row.
 *
 * Example:  actual 3.2% · SPY -0.41% / QQQ -0.57%
 */
export function EnrichmentRowSummary({
  actual,
  snapshot = null,
  snapshotRaw = null,
  preferEventSymbol = false,
}: {
  actual: string | null;
  /** Already-parsed snapshot (client callers). */
  snapshot?: ReactionSnapshot | null;
  /**
   * Raw reaction_snapshot JSON — for SERVER-component callers, which can
   * render this client component but cannot call parseReactionSnapshot()
   * themselves. Parsed here, per this module's parse-on-the-client design.
   */
  snapshotRaw?: string | null;
  preferEventSymbol?: boolean;
}) {
  const snap = snapshot ?? parseReactionSnapshot(snapshotRaw);
  if (!actual && !snap) return null;
  const formatted = actual ? formatFinnhubFigureCompact(actual) : null;
  const pairs = reactionSummaryPairs(snap, { preferEventSymbol });
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-mono">
      {formatted && (
        <>
          <span className="text-ink-faint">actual</span>
          <span className="text-gold-ink font-semibold">{formatted}</span>
        </>
      )}
      {pairs.length > 0 && (
        <>
          {actual && <span className="text-ink-faint">·</span>}
          {pairs.map((p, i) => (
            <span key={p.label} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-ink-faint">/</span>}
              <span className={deltaClass(p.pct)}>
                {p.label} {fmtDelta(p.pct)}
              </span>
            </span>
          ))}
        </>
      )}
    </span>
  );
}

/**
 * Expanded card for the full enrichment details: actual + all four
 * benchmarks with their pre/post prices.
 */
export function EnrichmentDetail({
  actual,
  snapshot,
  enrichedAt,
}: {
  actual: string | null;
  snapshot: ReactionSnapshot | null;
  enrichedAt: string | null;
}) {
  if (!actual && !snapshot) return null;

  const benchmarks: Array<{ label: string; data: { t_pre: number; t_post: number; delta_pct: number } | undefined }> = [
    { label: "SPY", data: snapshot?.spy },
    { label: "QQQ", data: snapshot?.qqq },
    { label: "TLT", data: snapshot?.tlt },
  ];
  if (snapshot?.sector) {
    benchmarks.push({ label: snapshot.sector.symbol, data: snapshot.sector });
  }

  return (
    <div className="bg-canvas/50 rounded px-2.5 py-2 border border-edge/30">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-ink-faint uppercase tracking-wider">
          Actual
        </span>
        {snapshot?.source && (
          <span className="text-[9px] text-ink-faint font-mono">
            via {snapshot.source}
          </span>
        )}
      </div>
      <div className="text-sm font-mono font-semibold text-gold-ink mt-0.5">
        {actual ? formatFinnhubFigureCompact(actual) : "—"}
      </div>

      {snapshot && (
        <div className="mt-2 pt-2 border-t border-edge/30 space-y-1">
          <div className="text-[10px] text-ink-faint uppercase tracking-wider">
            Market reaction (T+2h)
          </div>
          {benchmarks
            .filter((b) => b.data && b.data.t_pre > 0)
            .map((b) => (
              <div
                key={b.label}
                className="flex items-center justify-between text-[11px] font-mono"
              >
                <span className="text-ink-dim">{b.label}</span>
                <span className="flex items-center gap-2">
                  <span className="text-ink-faint">
                    {b.data!.t_pre.toFixed(2)} → {b.data!.t_post.toFixed(2)}
                  </span>
                  <span className={deltaClass(b.data!.delta_pct)}>
                    {fmtDelta(b.data!.delta_pct)}
                  </span>
                </span>
              </div>
            ))}
        </div>
      )}

      {enrichedAt && (
        <div className="mt-2 pt-2 border-t border-edge/30 text-[9px] text-ink-faint">
          {/* enriched_at is SQLite datetime('now') — UTC with a space, no tz
              marker. Bare new Date() reads it as local (and Safari rejects it
              outright: "Invalid Date"). Parse as UTC, render ET (B15). */}
          Enriched {formatEnrichedAt(enrichedAt)}
        </div>
      )}
    </div>
  );
}

function formatEnrichedAt(storedTs: string): string {
  const d = parseStoredTimestamp(storedTs);
  if (isNaN(d.getTime())) return storedTs;
  return (
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    }) + " ET"
  );
}
