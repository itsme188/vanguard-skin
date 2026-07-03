# Away-from-home auto-refresh (R1, scoped to auto-cadence) — design

**Date:** 2026-07-03 · **Status:** approved (user picked the auto-cadence-only
scope from a wider Approach A/B menu; broker-only pricing constraint)

## Problem

When the user is away from home, TWS isn't running. The 30-minute background
refresh (`lib/hooks/useAutoRefresh.ts`) early-returns unless `twsConnected`,
so **nothing refreshes periodically** — only a manual ↻ press reaches the
IBKR Web API fallback in `/api/tws/auto-refresh`. Portfolio Desk prices go
stale for the whole away period.

## User decisions

1. **Broker-only prices.** No Yahoo/third-party prices ever enter `prices`
   for held securities. Staleness for what the broker session can't price
   (Vanguard mutual funds, options, bonds — no conid coverage today) is
   accepted and surfaced by the existing `(est.)`/data-quality labeling.
2. **Auto cadence, market hours only.** The disconnected-path refresh fires
   on the existing 30-minute rhythm, but only Mon–Fri 9:30–16:00 ET and not
   on NYSE holidays.
3. **Minimal scope.** No quote-coverage extension (option/bond/fund conids)
   and no Mac-side alerts scan on this path in v1. Known gap: MA-based
   levels don't fire while TWS is down (the Worker cloud scan covers
   static levels only). A future session can extend coverage (the wider
   "Approach A" in the brainstorm).

## Design

### New pure gate — `lib/tws/webapi-refresh-gate.ts`

`shouldFireDisconnectedRefresh({ now, lastRefreshMs, intervalMinutes }): boolean`

- `intervalMinutes > 0`
- debounce: `now - lastRefreshMs >= intervalMinutes` (0 = never refreshed →
  allowed)
- ET wall clock (from `Intl.DateTimeFormat("America/New_York")`, never the
  local clock — the Mac travels): weekday Mon–Fri AND 9:30 ≤ time < 16:00
- `!isMarketClosed(todayET(now))` (NYSE holidays skip)

Pure and unit-tested with injected `now` dates (both DST regimes).

### Hook change — `lib/hooks/useAutoRefresh.ts`

- The `useEffect` timer runs whenever `intervalMinutes > 0` (no longer gated
  on `twsConnected`).
- `triggerRefresh` gains a disconnected branch: when `!twsConnected`, gate
  via `shouldFireDisconnectedRefresh` with `lastRefreshMs` read from
  **localStorage `vgs:lastWebApiRefresh`** (same pattern as
  `vgs:lastResearchSync`) — the Web API path never updates server-side
  sync-state and the hook's in-memory ref resets on every page mount, so
  without the localStorage gate every iPhone page-open would fire a refresh.
  On firing, write the timestamp, POST `{level:"quick"}` to
  `/api/tws/auto-refresh` (whose existing fallback branch does the IBKR Web
  API refresh: positions → equity quotes → prices → valuations), call
  `onRefresh`.
- The TWS-connected branch is unchanged.

### No route/server changes

The fallback branch in `app/api/tws/auto-refresh/route.ts` already does the
work, is awaited, and is idempotent — an overlapping manual press is
harmless. It was live-verified twice today (FX go-live sync).

## Testing

- `tests/tws/webapi-refresh-gate.test.ts`: in-window weekday fires; before
  9:30 / after 16:00 / weekend / July-4-style holiday / debounce-not-elapsed
  / interval 0 all skip; ET anchoring pinned with a UTC timestamp that is
  in-window in ET but out-of-window in UTC (and vice versa).
- Hook wiring is thin (read/write localStorage + POST); covered by the gate
  tests + existing route behavior. No browser E2E for a 30-min timer; the
  fired path is byte-identical to the manual ↻ press verified live today.

## Rollout

Ships with the next DMG rebuild (session-end). No migration, no env vars.
