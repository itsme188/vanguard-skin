/**
 * Client-safe leaf module for ReactionSnapshot: the type + pure
 * parse/date-matching helpers, and NOTHING else.
 *
 * ZERO runtime imports, on purpose. lib/calendar/reaction-snapshot.ts (the
 * full TWS/Polygon bar-capture pipeline) imports real VALUES from
 * "@stoqey/ib" (BarSizeSetting, SecType) at module scope, and that package
 * touches Node's `net` module to talk to TWS. Any browser bundle that pulls
 * in even one runtime export from that file drags the whole @stoqey/ib
 * module graph along, and webpack fails with "Module not found: Can't
 * resolve 'net'".
 *
 * History (2026-08-14, qa fix, round 2): round 1 moved
 * parseReactionSnapshot/snapshotCoversEventDate out of the 'use client'
 * EnrichmentChips.tsx into lib/calendar/reaction-snapshot.ts, to fix
 * WeekAheadView.tsx (a Server Component) crashing with "Attempted to call
 * parseReactionSnapshot() from the server but parseReactionSnapshot is on
 * the client." — RSC forbids calling a plain function export of a 'use
 * client' module from server code. But reaction-snapshot.ts itself was
 * never client-safe (see above), so the two CLIENT callers of these helpers
 * (EnrichmentChips.tsx, TodayReleases.tsx) broke the browser bundle
 * instead. This module is the actual fix: a dependency-free leaf that both
 * server (WeekAheadView.tsx) and client (EnrichmentChips.tsx,
 * TodayReleases.tsx) code can import safely. lib/calendar/reaction-snapshot.ts
 * re-exports the type (and, for any lingering server-only importers, the
 * helpers) from here for backward compatibility — but never import a VALUE
 * from reaction-snapshot.ts into a 'use client' module.
 */

export interface BenchmarkReaction {
  t_pre: number;
  t_post: number;
  delta_pct: number;
}

export interface ReactionSnapshot {
  t0_utc: string;
  window_min: 120;
  source: "tws" | "polygon" | "yahoo";
  spy: BenchmarkReaction;
  qqq: BenchmarkReaction;
  tlt: BenchmarkReaction;
  sector?: BenchmarkReaction & { symbol: string };
  // The event's own stock — populated for earnings (and any future event type
  // that passes `eventSymbol`). Lets the recap email say "GLW closed +4.2% vs
  // SPY +0.1%" instead of just the benchmark deltas. Optional because it
  // gracefully degrades if bars for the event symbol aren't available.
  symbol?: BenchmarkReaction & { symbol: string };
  // Present (as "prior_close") when every t_pre in this snapshot is the last
  // regular-session close before the release instead of the near-release bar
  // (earnings rows, 2026-08-04). Absent on macro rows and pre-fix snapshots —
  // renderers use it to label deltas honestly ("vs prior close").
  pre_anchor?: "prior_close";
}

// ── Snapshot parsing & date matching (RSC-safe, client-safe) ─────────
// WeekAheadView.tsx is a Server Component (no "use client") and calls these
// directly — React Server Components forbid calling a plain (non-component)
// export of a 'use client' module from server code; only JSX rendering of
// client COMPONENTS may cross that boundary. EnrichmentChips.tsx and
// TodayReleases.tsx are 'use client' and call these too. This file is the
// only home safe for both: no "use client" directive, no heavy deps.

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
