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

/**
 * A leg is only usable when both prices are real (finite AND positive) —
 * a 0/0 division (dead quote on both sides) still produces a finite
 * `delta_pct` of 0, which is indistinguishable from a genuine flat move
 * unless the underlying prices are checked too. Guards BOTH the write side
 * (captureReactionFromTws / captureReactionFromYahoo omit an unusable leg
 * rather than storing a zero-filled sentinel) and the read side (every
 * renderer must treat an unusable leg as absent, never as "+0.00%").
 *
 * Real incident (2026-09, synthetic reproduction): a stored snapshot's qqq
 * leg was `{t_pre:0,t_post:0,delta_pct:0}` — the recap email rendered
 * "QQQ @ T+2h | +0.00%" as if the market had actually been flat. This
 * predicate cannot catch every bad leg — a leg whose prices are both real
 * but merely IDENTICAL (a stale/echoed quote, e.g. t_pre 100 → t_post
 * 100.002) still passes as "usable" because both sides are finite and
 * positive. It only rules out the zero/negative/non-finite sentinel class.
 *
 * THIS FILE IS THE SOURCE. Three hand copies exist because the Worker
 * can't import from lib/ (no Next path alias across the Cloudflare Workers
 * boundary) and because two push composers are deliberately dependency-free:
 *
 *   - workers/cron/src/reaction-leg.ts — the Worker's shared copy, imported
 *     by fallback-earnings.ts (scoreboard + recap gate) and yahoo.ts (the
 *     Worker's own capture path). Parity-pinned by
 *     workers/cron/test/reaction-leg-parity.test.ts, which runs a behavior
 *     table against this implementation AND that one.
 *   - lib/alerts/print-push-message.ts — inlined in the Mac push composer.
 *   - workers/cron/src/print-push-message.ts — inlined in its Worker twin.
 *
 * Change all four together. (Earlier revisions of this comment named
 * fallback-earnings.ts, which has imported the predicate from
 * reaction-leg.ts since that module was extracted — it holds no copy.)
 */
export function isUsableReactionLeg(
  leg: BenchmarkReaction | null | undefined,
): leg is BenchmarkReaction {
  return (
    leg != null &&
    Number.isFinite(leg.t_pre) &&
    leg.t_pre > 0 &&
    Number.isFinite(leg.t_post) &&
    leg.t_post > 0 &&
    Number.isFinite(leg.delta_pct)
  );
}

export interface ReactionSnapshot {
  t0_utc: string;
  window_min: 120;
  source: "tws" | "polygon" | "yahoo";
  // Optional (2026-09-10 qa fix): a benchmark whose bars produced no usable
  // leg (see isUsableReactionLeg) is OMITTED from the snapshot, never
  // zero-filled — every reader already treats these defensively
  // (`rs.spy?.delta_pct`), so omission is the safe direction.
  spy?: BenchmarkReaction;
  qqq?: BenchmarkReaction;
  tlt?: BenchmarkReaction;
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
