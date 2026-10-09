"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  isUsableReactionLeg,
  parseReactionSnapshot,
  type BenchmarkReaction,
  type ReactionSnapshot,
} from "@/lib/calendar/reaction-snapshot-core";
import { reactionLegState } from "@/lib/calendar/reaction-validity";
import { formatFinnhubFigureCompact } from "@/lib/format/finnhub-figure";
import { parseStoredTimestamp } from "@/lib/format";
import { Chip } from "../Chip";
import { usePreReleaseActive } from "../../today/use-pre-release-clear";

/**
 * Compact post-release result chips for the Calendar page event row.
 *
 * Rendering is defensive: callers pass raw `actual_value` (string) and
 * `reaction_snapshot` (JSON text). This component parses the snapshot on
 * the client so server components don't have to re-serialize.
 *
 * parseReactionSnapshot/snapshotCoversEventDate + the ReactionSnapshot type
 * live in lib/calendar/reaction-snapshot-core.ts — a dependency-free leaf
 * module, NOT lib/calendar/reaction-snapshot.ts (that file imports real
 * values from @stoqey/ib and would drag Node's `net` module into this
 * client bundle). Never import a value from reaction-snapshot.ts here.
 */

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
  /** The event's own stock, shown as a dash because its move was not captured. */
  notCaptured?: boolean;
  /**
   * A figure is stored but it is not a measurement (read before the window
   * elapsed, or pre and post are the same quote) — shown as "pending", never
   * as a percent. The rule is lib/calendar/reaction-validity.ts.
   */
  pending?: boolean;
}

/** Shown in place of a percent for a leg that is not a measurement yet. */
const PENDING_TEXT = "pending";
const PENDING_TITLE =
  "Reaction not measured yet: this figure was read before the two-hour window after the release had passed";

/** One summary slot: the percent, or `pending` when the leg is not a measurement. */
function summaryPair(
  snapshot: ReactionSnapshot,
  label: string,
  leg: BenchmarkReaction | undefined,
  enrichedAt: string | null | undefined,
): ReactionPair {
  if (reactionLegState(snapshot, leg, { rowEnrichedAt: enrichedAt }) === "pending") {
    return { label, pct: null, pending: true };
  }
  return { label, pct: leg?.delta_pct ?? null };
}

/**
 * Which two deltas the collapsed summary line shows. Default is the
 * Calendar-row treatment (SPY / QQQ). `preferEventSymbol` leads with the
 * event's own stock when the snapshot captured one (earnings rows), so a
 * week-view card can read "AMZN +9.09% / SPY +0.11%"; macro snapshots have
 * no symbol reaction and degrade to SPY / QQQ.
 *
 * `eventSymbol` is the ticker of an earnings row. When the snapshot holds no
 * leg for it, the stock's own slot is still shown, as a dash, ahead of SPY
 * ("AAA — / SPY +0.19%") — otherwise SPY's move sits where every sibling card
 * shows the stock's and reads as the stock's own.
 */
export function reactionSummaryPairs(
  snapshot: ReactionSnapshot | null,
  opts: {
    preferEventSymbol?: boolean;
    eventSymbol?: string | null;
    /** The row's enriched_at — evidence for an older snapshot with no capture stamp. */
    enrichedAt?: string | null;
  } = {},
): ReactionPair[] {
  if (!snapshot) return [];
  const pair = (label: string, leg: BenchmarkReaction | undefined) =>
    summaryPair(snapshot, label, leg, opts.enrichedAt);
  if (opts.preferEventSymbol && snapshot.symbol) {
    return [pair(snapshot.symbol.symbol, snapshot.symbol), pair("SPY", snapshot.spy)];
  }
  if (opts.preferEventSymbol && opts.eventSymbol) {
    return [{ label: opts.eventSymbol, pct: null, notCaptured: true }, pair("SPY", snapshot.spy)];
  }
  return [pair("SPY", snapshot.spy), pair("QQQ", snapshot.qqq)];
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
  eventSymbol = null,
  enrichedAt = null,
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
  /** Ticker of an earnings row — see reactionSummaryPairs. */
  eventSymbol?: string | null;
  /** The row's enriched_at — see reactionSummaryPairs. */
  enrichedAt?: string | null;
}) {
  const snap = snapshot ?? parseReactionSnapshot(snapshotRaw);
  // `actual` can be a Finnhub-shaped string whose only recognizable token
  // parses to nothing usable (the "Rev 0" placeholder, or an unparseable
  // "Rev abc") — formatFinnhubFigureCompact returns "" for those (gap #2 of
  // the PR #68 landing review). Gate on `formatted`, not the raw `actual`
  // string, so a placeholder-only actual with no reaction data renders
  // nothing (never an empty chip) and never leaves a stray "·" separator
  // dangling with no figure in front of it.
  const formatted = actual ? formatFinnhubFigureCompact(actual) : null;
  const pairs = reactionSummaryPairs(snap, { preferEventSymbol, eventSymbol, enrichedAt });
  if (!formatted && pairs.length === 0) return null;
  return (
    // Wraps (never one fixed line): week-ahead day columns get as narrow as
    // ~96px with the chat rail open, where "SPY +0.02% / QQQ +0.05%" on one
    // line ran past the card edge into the next column.
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0 max-w-full text-[11px] font-mono">
      {formatted && (
        <>
          <span className="text-ink-faint">actual</span>
          <span className="text-gold-ink font-semibold">{formatted}</span>
        </>
      )}
      {pairs.length > 0 && (
        <>
          {formatted && <span className="text-ink-faint">·</span>}
          {pairs.map((p, i) => (
            <span key={p.label} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-ink-faint">/</span>}
              {p.pending ? (
                <span className="text-ink-dim" title={PENDING_TITLE}>
                  {p.label} {PENDING_TEXT}
                  <span className="sr-only"> (reaction not measured yet)</span>
                </span>
              ) : (
                <span
                  className={deltaClass(p.pct)}
                  title={p.notCaptured ? `${p.label}'s own move was not captured` : undefined}
                >
                  {p.label} {fmtDelta(p.pct)}
                </span>
              )}
            </span>
          ))}
        </>
      )}
    </span>
  );
}

export interface ReactionDetailRow {
  label: string;
  data: BenchmarkReaction;
  /** Stored but not a measurement — the row shows "pending", not its figures. */
  pending?: boolean;
}

/**
 * Every usable leg of a snapshot, in display order: the event's own stock
 * (when captured), SPY, QQQ, TLT, then the sector ETF. An unusable leg
 * (isUsableReactionLeg — dead or missing quote) is left out, never shown as
 * a flat "+0.00%". A leg that is not a measurement yet
 * (lib/calendar/reaction-validity.ts) keeps its row, flagged `pending`.
 */
export function reactionDetailRows(
  snapshot: ReactionSnapshot | null,
  opts: { enrichedAt?: string | null } = {},
): ReactionDetailRow[] {
  if (!snapshot) return [];
  const legs: Array<{ label: string; data: BenchmarkReaction | undefined }> = [
    { label: snapshot.symbol?.symbol ?? "", data: snapshot.symbol },
    { label: "SPY", data: snapshot.spy },
    { label: "QQQ", data: snapshot.qqq },
    { label: "TLT", data: snapshot.tlt },
    { label: snapshot.sector?.symbol ?? "", data: snapshot.sector },
  ];
  const rows: ReactionDetailRow[] = [];
  for (const leg of legs) {
    if (!leg.label || !isUsableReactionLeg(leg.data)) continue;
    const pending =
      reactionLegState(snapshot, leg.data, { rowEnrichedAt: opts.enrichedAt }) === "pending";
    rows.push(pending ? { label: leg.label, data: leg.data, pending: true } : { label: leg.label, data: leg.data });
  }
  return rows;
}

/**
 * Expanded card for the full enrichment details: actual + every captured
 * leg (event stock, SPY, QQQ, TLT, sector) with its pre/post prices.
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

  const rows = reactionDetailRows(snapshot, { enrichedAt });

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
        {/* A placeholder-only actual (e.g. "Rev 0") formats to "" — coalesce
            to the em-dash rather than rendering an empty line (gap #2 of the
            PR #68 landing review). */}
        {actual ? formatFinnhubFigureCompact(actual) || "—" : "—"}
      </div>

      {rows.length > 0 && (
        <div className="mt-2 pt-2 border-t border-edge/30 space-y-1">
          <div className="text-[10px] text-ink-faint uppercase tracking-wider">
            {/* pre_anchor "prior_close": every pre price is the last regular
                close before the release, not the bar at the release. */}
            Market reaction ({snapshot?.pre_anchor === "prior_close" ? "T+2h vs prior close" : "T+2h"})
          </div>
          {rows.map((b) => (
            <div
              key={b.label}
              className="flex flex-wrap items-center justify-between gap-x-2 text-[11px] font-mono"
            >
              <span className="text-ink-dim">{b.label}</span>
              {b.pending ? (
                <span className="text-ink-dim" title={PENDING_TITLE}>
                  {PENDING_TEXT}
                  <span className="sr-only"> (reaction not measured yet)</span>
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-x-2">
                  <span className="text-ink-faint">
                    {b.data.t_pre.toFixed(2)} → {b.data.t_post.toFixed(2)}
                  </span>
                  <span className={deltaClass(b.data.delta_pct)}>
                    {fmtDelta(b.data.delta_pct)}
                  </span>
                </span>
              )}
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

/**
 * A card that opens its full enrichment detail (owner ruling 2026-08-30).
 * `children` is the card's collapsed body, rendered by the (server) caller;
 * this wraps it in a real control — focusable, Enter / Space, aria-expanded —
 * and puts the EnrichmentDetail under it. Never hover-only. The detail stays
 * in the document (hidden) so aria-controls always points at something.
 *
 * Takes the raw snapshot JSON, like EnrichmentRowSummary: a server caller
 * cannot call parseReactionSnapshot for this client module.
 */
export function EnrichmentDisclosure({
  className,
  actual,
  snapshotRaw,
  enrichedAt,
  children,
}: {
  /** Classes for the card itself (the clickable surface). */
  className: string;
  actual: string | null;
  snapshotRaw: string | null;
  enrichedAt: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const toggle = () => setOpen((o) => !o);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault(); // Space would scroll the page
      toggle();
    }
  };
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={detailId}
        title={open ? "Hide the reaction detail" : "Show the reaction detail"}
        onClick={toggle}
        onKeyDown={onKeyDown}
        className={`${className} cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold`}
      >
        {children}
      </div>
      <div id={detailId} hidden={!open} className="mt-1.5">
        <EnrichmentDetail
          actual={actual}
          snapshot={parseReactionSnapshot(snapshotRaw)}
          enrichedAt={enrichedAt}
        />
      </div>
    </>
  );
}

/**
 * The week-ahead card's "actual …" figure plus its "pre-release" chip, for a
 * row the server found pre-release. The server decides the state and the
 * instant it ends (preReleaseClearsAtMs); usePreReleaseActive flips it then,
 * so the chip clears and the figure takes its beat/miss tone without a
 * reload — the same hook the Earnings Hub row uses.
 */
export function PreReleaseActualChips({
  actualDisplay,
  preReleaseClass,
  settledClass,
  chipText,
  chipTitle,
  initiallyPreRelease,
  clearsAtMs,
}: {
  actualDisplay: string;
  /** Full class of the figure while pre-release (muted, never beat/miss). */
  preReleaseClass: string;
  /** Full class of the figure once the print window has opened. */
  settledClass: string;
  chipText: string;
  chipTitle: string;
  initiallyPreRelease: boolean;
  clearsAtMs: number | null;
}) {
  const stillPreRelease = usePreReleaseActive(initiallyPreRelease, clearsAtMs);
  return (
    <>
      <span className={stillPreRelease ? preReleaseClass : settledClass}>actual {actualDisplay}</span>
      {stillPreRelease && (
        <Chip tone="warn" size="xs" title={chipTitle} className="max-w-full">
          {chipText}
        </Chip>
      )}
    </>
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
