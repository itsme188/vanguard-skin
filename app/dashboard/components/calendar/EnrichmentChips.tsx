"use client";

import type { ReactionSnapshot } from "@/lib/calendar/reaction-snapshot";

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

/**
 * Inline summary for the collapsed event row.
 *
 * Example:  actual 3.2% · SPY -0.41% / QQQ -0.57%
 */
export function EnrichmentRowSummary({
  actual,
  snapshot,
}: {
  actual: string | null;
  snapshot: ReactionSnapshot | null;
}) {
  if (!actual && !snapshot) return null;
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-mono">
      {actual && (
        <>
          <span className="text-ink-faint">actual</span>
          <span className="text-gold font-semibold">{actual}</span>
        </>
      )}
      {snapshot && (
        <>
          {actual && <span className="text-ink-faint">·</span>}
          <span className={deltaClass(snapshot.spy?.delta_pct)}>
            SPY {fmtDelta(snapshot.spy?.delta_pct)}
          </span>
          <span className="text-ink-faint">/</span>
          <span className={deltaClass(snapshot.qqq?.delta_pct)}>
            QQQ {fmtDelta(snapshot.qqq?.delta_pct)}
          </span>
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
      <div className="text-sm font-mono font-semibold text-gold mt-0.5">
        {actual ?? "—"}
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
          Enriched {new Date(enrichedAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}
