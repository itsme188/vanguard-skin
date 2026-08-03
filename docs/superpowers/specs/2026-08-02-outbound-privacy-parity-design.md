# Outbound privacy + Worker parity batch — design

**Date:** 2026-08-02 (evening session)
**Status:** Approved by user (format: direction-only, no return %; NET SHORT count dropped; Worker wrap suppress-but-never-send)
**Origin:** Earnings feedback backlog item #8 (user review 2026-08-02: "500 shares up 12% — anyone can just do the math") + the three Worker parity follow-ups from the 8/02 build, batched because both live in `workers/cron`.

## Problem

1. Outbound emails (earnings preview/recap, Sunday briefing, evening) disclose **share and contract counts**. Every price is public, so `count × price` reconstructs exact dollar exposure — the presence-only rendering was not actually presence-only. The briefing's `NET SHORT <n>` marker has the same leak.
2. Three parity gaps left by the 8/02 morning-debrief build:
   - (a) The Worker's legacy wrap still ships the rejected 20:00 staple when the Mac is asleep on a heavy night.
   - (b) Worker `parseSourceKey` returns `unknown` for `manual:SYM:DATE:earnings` keys (Mac fixed 8/02), so cloud enrichment can't capture actuals for corrected/manual rows while the Mac sleeps.
   - (c) A missing `BRIEFING_EMAIL_TO` burns the debrief day key — the stamp happens before recipient resolution.

## Decisions (user-approved 2026-08-02)

- **Maximum privacy format**: direction + symbol + account + option terms only. **No share counts, no contract counts, and no return % either** — this supersedes the 2026-05-12 direction that relative % returns were fine to keep.
- **NET SHORT** in briefings keeps the direction flag, drops the number.
- **Worker wrap becomes suppress-but-never-send.** Accepted trade-off: if the Mac also sleeps through the morning debrief window, coverage waits for the debrief's 3-day self-heal — no cloud debrief exists (non-goal). The 07:40 MTWRFS pmset wake (registered this session) makes a missed morning rare.

## Components

### A. Presence formatter — counts and returns removed

Files: `lib/digest/presence-only-position.ts` + byte-parity Worker mirror `workers/cron/src/presence-position.ts` (change BOTH together, per the existing mirror convention).

New output shapes:

```
long AAPL (vanguard taxable)
short META (ibkr)
long AAPL $145 calls exp 2026-06-19 (ibkr)
short SPY $590 puts exp 2026-05-23 (ibkr)
```

- `formatPositionPresence`: quantity is consumed ONLY for its sign (direction). Option lines pluralize the right ("calls"/"puts") and use `exp` instead of `expiring`. Strike + expiry stay (public market data).
- `formatReturnSuffix` is **deleted**. `costBasis` / `latestPrice` leave `PositionPresenceArgs`; `OptionMeta.multiplier` is removed (it only served the return calc). Callers updated: `lib/digest/send-earnings-email.ts` (~1577, ~1599) and `workers/cron/src/fallback-earnings.ts` (~1355, ~1392).
- `formatCombinedExposurePresence`: **signature unchanged** (counts become >0 presence flags — zero caller churn). Renders e.g. `long shares + long options`, `long shares + short options`, or `no live exposure`. No numbers anywhere in the output.
- Doc headers on both files updated: record the 2026-08-02 supersession of the 2026-05-12 "% returns OK" direction, and the count×price=notional rationale.
- A byte-parity test pins the mirror below the header comment (add if none exists, mirroring the `plausibility.ts` / `print-push-message.ts` parity-test pattern).

### B. Briefing NET SHORT count

`lib/calendar/briefing.ts` (~741) and `workers/cron/src/fallback-briefing.ts` (~167): render `— NET SHORT (cross-account net)` — no `Math.abs(qty)`. The surrounding comment about why net-shorts are marked stays.

### C. Worker wrap → suppress-but-never-send

`workers/cron/src/fallback-earnings.ts` wrap section:

- The wrap-pending **suppression of individual cloud recaps stays exactly as is** (heavy-night clusters must not ship N individual cloud recaps at 20:00 either — they roll into the Mac's morning debrief).
- The deadline-triggered staple compose + send is **removed**. Members past the deadline keep being skipped, with an explicit skip reason (`wrap-suppressed-for-debrief`) so `/internal` diagnostics and logs stay honest about why nothing shipped.
- `workers/cron/src/wrap-send.ts` retirement header updated to note the cloud staple is also retired (file still kept for its parity-pinned constants).
- Worker tests updated: the "wrap sends at deadline" cases become "wrap never sends; members suppressed with reason".

### D. Worker `parseSourceKey` — manual earnings keys

`workers/cron/src/enrich-actuals.ts::parseSourceKey`: add the Mac's exact regex
`/^manual:([^:]+):(\d{4}-\d{2}-\d{2}):earnings$/` → `{ kind: "finnhub", symbol, date }`
(mirrors `lib/calendar/enrich-actuals.ts` ~310). Mirrored test case added to the Worker enrich-actuals tests.

### E. Debrief day-key guard

`lib/earnings/debrief-send.ts::runMorningDebrief`: move recipient resolution (opts.recipient / `BRIEFING_EMAIL_TO`) **above** the `setDebriefLastRunDay` stamp; return `skippedReason: "no-recipient"`. A misconfigured env var then no-ops harmlessly and the day retries once configured.

## Testing

- TDD per component. Update existing presence-formatter + earnings-composer test expectations to the new strings.
- New: byte-parity pin for presence mirror (if absent); Worker manual-key parse; Worker wrap-never-sends; debrief no-recipient-doesn't-burn-day.
- Full `npx vitest run` (Mac, ~4,029 tests) + `workers/cron` vitest suite green before merge.

## Non-goals

- No cloud debrief (accepted trade-off above).
- No change to in-app surfaces (`PrivateText` masking already covers them).
- No change to bogeys / intel / scoreboard figures — those are public market data by convention.
- No change to the `earnings_emails` audit schema or the marker dance.
