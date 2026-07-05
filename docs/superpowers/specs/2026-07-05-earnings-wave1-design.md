# Earnings Wave 1 — Coverage Guard, Push-at-Print, Shorts, Watchlist/Option Coverage

**Date:** 2026-07-05
**Status:** Approved (user, 2026-07-05)
**Context:** Follow-on to the pre-season fix batch (`docs/plans/2026-07-04-earnings-season-audit.md`, fixes `f13a340..4274ed2`). The pipeline is now reliable; Wave 1 closes the remaining *coverage* holes before the 7/14 bank week. Four components, one branch.

**User decisions (locked):**
1. Coverage guard = auto-fix + residual alert (not alert-only).
2. Gap alerts surface in the Sunday briefing email AND one Pushover (only when gaps exist).
3. Push-at-print fires from BOTH Mac and Worker (real-time even when the Mac sleeps), KV-deduped.
4. Watchlist names get full parity with held names: events + Hub + push + preview/recap emails (the per-symbol mute list is the volume valve).

---

## 1. Coverage guard

### Auto-fix: 4-week sync reach
`lib/digest/send-briefing.ts:148` currently syncs `[weekOf, weekOf+7]`. Change to `[weekOf, +7, +14, +21]`. Rationale: earnings dates confirm 2–4+ weeks out; the July 7/13 bank week was structurally unreachable by any automated sync. Each `syncCalendarForWeek` call is idempotent (source_key upserts) and already has per-phase error isolation; cost ≈ +2 min on Sundays (Finnhub 550 ms/symbol pacing × ~65 symbols × 2 extra weeks).

### Residual guard: `lib/calendar/coverage-guard.ts`
New module, pure DB reads:

```
findEarningsCoverageGaps(db, opts?: { now?: Date }): CoverageGap[]
interface CoverageGap {
  symbol: string;
  kind: "due_no_event" | "no_history";
  lastEventDate: string | null;   // most recent earnings event_date (any status)
  daysSinceLast: number | null;
}
```

**Candidate set:** held stocks (latest holdings per account, `quantity != 0`, `security_type` stock-like — same filter family as `getHeldStockSymbols`) ∪ active watchlist symbols (stock-like only). ETFs/funds/bonds/options excluded by type. Uppercased, deduped.

**Gap predicate** (issuer-family aware — a GOOGL event covers GOOG via `issuerSiblings`):
- `due_no_event`: no `calendar_events` earnings row (`superseded=0`) with `event_date` in `[today, today+45d]` for the symbol or any sibling, AND the most recent earnings event (any date) is older than 75 days. "A report is due and no source has it." Stays quiet for names that just reported ((75d, next-45d) brackets the quarterly cycle).
- `no_history`: symbol has zero earnings events ever AND no future event. Reported under a separate label ("no earnings history — verify coverage") so genuinely uncovered names (e.g. foreign listings Finnhub won't return) are visible without masquerading as due-and-missing.

**Exclusion valve:** settings key `coverage_guard_ignored_symbols` (JSON array, no UI — hand-edit via sqlite or future settings surface). Known-uncoverable names (e.g. `402340`) go here so they don't repeat weekly. Reader helper lives in the same module; missing key → empty list.

**Wiring:** runs inside `sendBriefingEmail` after the sync loop, wrapped in try/catch (a guard failure logs and never blocks the briefing — same convention as other briefing best-effort steps). Output:
- A deterministic "Coverage gaps" markdown block appended to the briefing content by code (NOT via the AI prompt), rendered only when gaps exist. One line per gap: symbol, kind, days since last report.
- One `sendPushover` (existing helper, graceful no-op) when `gaps.length > 0`: title "Earnings coverage gaps", message = comma-joined symbols + count, deep link `/dashboard/today`.

**Not in scope:** no new tables/columns; persistent gaps re-report every Sunday by design (a real gap should stay visible until fixed or ignored).

---

## 2. Push-at-print

**Trigger:** the null→non-null transition of `calendar_events.actual_value` for an `event_type='earnings'` row whose symbol is held or watchlist (via `getSymbolStatus`, which after §4 includes option-only exposure) and not in the muted-symbols list (`getEarningsSettings`). One push per event, ever.

**Message (public market data only — no position info):**
- Title: `{SYMBOL} reported`
- Body: `EPS {act} vs {cons} est · Rev {act} vs {cons}` — values parsed from the Finnhub-shape strings via the `lib/format/finnhub-figure.ts` family (never the raw blob); missing halves omitted. If `reaction_snapshot` is already present at push time, append ` · {sym} {±x.xx}% vs SPY {±x.xx}% (T+2h)`.
- URL: `${PUSHOVER_LINK_BASE ?? "http://localhost:3099"}/dashboard/today`, urlTitle "Open Earnings Hub".

**Three capture sites, one shared dedup marker:**

| Site | When it captures | Push condition |
|---|---|---|
| Mac `runEnrichment` (`lib/calendar/enrichment-runner.ts`) | awake, per retry tick | `event.actual_value` was NULL pre-pass AND `actualResult.actual != null` |
| Mac reconcile (`lib/calendar/cloud-reconcile.ts`) | on wake, draining Worker payloads | `existing.actual_value` NULL AND `payload.actual != null` |
| Worker cloud-enrich (`workers/cron/src/calendar-enrich.ts`) | Mac asleep, flag-gated path | actual captured for an earnings candidate |

**Dedup:** shared KV marker `print-push-{eventId}` (24h TTL), added to the existing earnings-markers family (`workers/cron/src/earnings-markers.ts` + Worker `/internal/` endpoint + Mac helper in `lib/cron/earnings-marker-check.ts`, same X-Cron-Secret + 3s-timeout + graceful-degrade pattern). Every site CHECKS the marker before pushing and WRITES it after a successful push. Mac degrades to push-without-check when `WORKER_MARKER_URL` is unset/unreachable (duplicate risk only exists when both sides are active, which requires the Worker reachable). Race window between sides is minutes-apart ticks; accepted.

**Worker inputs:** held symbols already in the R2 snapshot (`heldSymbols`); muted list already in snapshot `earningsSettings`. Watchlist symbols are NOT in the snapshot → additive field `watchlistSymbols: string[]` written by `scripts/snapshot-state-to-r2.ts` (schemaVersion bump per existing convention; Worker degrades to held-only for older snapshots). Worker held/watchlist check is issuer-family aware via the existing `issuerSiblings` mirror. **Accepted degradation:** the snapshot's `heldSymbols` stays stock-only (changing its semantics would ripple into the digest/evening/newsletter fallbacks), so an option-ONLY name gets pushes from the Mac sites but not from the Worker; its events, Hub row, and emails are unaffected.

**New Mac module:** `lib/alerts/print-push.ts` — `sendEarningsPrintPush(db, { eventId, symbol, actual, consensus, reactionJson })` composing the message + calling `sendPushover`; both Mac sites use it. Worker composes inline next to its existing pushover usage (level-scan precedent).

---

## 3. B7 — shorts in earnings emails

**Mac:** `getCrossAccountPositions` (`lib/digest/send-earnings-email.ts:596`) changes `AND h.quantity > 0` → `AND h.quantity != 0`. The downstream long/short accumulation in `buildPreviewContext` and `formatCombinedExposurePresence` (`lib/digest/presence-only-position.ts`) already exist and become reachable — no signature changes.

**Worker (three fixes):**
1. `scripts/snapshot-state-to-r2.ts:391` snapshot holdings query: `quantity > 0` → `!= 0`.
2. `workers/cron/src/fallback-earnings.ts:388` drops the `quantity <= 0 → continue` skip.
3. The hand-rolled netting (`fallback-earnings.ts:497-501`, signed-sum-then-`Math.abs` — long 500 + short 300 prints "200 shares") is replaced by porting `formatCombinedExposurePresence` into `workers/cron/src/presence-position.ts` (byte-parity below the header, same convention as `formatPositionPresence`) and using it.

**Guards:** extend `tests/digest/earnings-prompt-no-dollar-leak.test.ts` (short positions render presence-only, no $), add a Worker parity test for the ported function, and a netting test (long+short renders both buckets, never a netted count).

---

## 4. B10 — watchlist events + option-only held status

**Watchlist → Finnhub scan:** `lib/calendar/sync.ts:178-185` merges active watchlist symbols (reuse the existing watchlist query module; stock-like only, uppercase) AND distinct underlyings of currently-held unexpired options (the option-only case — without this, a TER-LEAP-only book never gets TER's earnings synced either) into the scan set exactly like read-through reporters are merged today. Dedup via the existing Set union. Cost: +550 ms per added symbol on each sync.

**Option-only held:** `getSymbolStatus` (`lib/queries/briefing-symbols.ts:91-105`) gains a second membership check: a symbol is `held` when any account's latest holdings contain an unexpired option (`quantity != 0`) whose `underlying_symbol` matches the symbol or an issuer sibling — the same look-through `getCrossAccountPositions` performs. Precedence unchanged: held > watchlist > neither. Consumers (`findEmailCandidates`, EarningsHub, coverage guard, push-at-print) inherit the fix automatically.

---

## Error handling & conventions

- All pushes are best-effort: `sendPushover` never throws; marker checks degrade gracefully; no push failure may block enrichment, reconcile, or the briefing.
- Coverage guard wrapped in try/catch inside the briefing pipeline; failure logs `[coverage-guard]` and the briefing proceeds.
- Snapshot field is additive; Worker tolerates its absence (held-only fallback).
- No raw Finnhub-shape strings reach the user (finnhub-figure formatters everywhere).
- ET-anchor rule: the guard's "today"/window math uses `todayET()`/date-utils, never UTC `toISOString().slice`.

## Testing

TDD throughout, in-memory SQLite via migrations. Key cases: guard predicate (just-reported name quiet at 60d, due name flagged at 80d, sibling event covers, ignored-symbols valve, no-history label); push transition (first capture pushes, retry tick doesn't, reconcile skips when payload already pushed/marker present, muted symbol skipped); B7 (short-only position surfaces, mixed long/short renders both buckets, Worker parity); B10 (watchlist symbol enters scan set; option-only symbol reads `held`). Worker tests in `workers/cron/test/` per existing patterns.

## Rollout

One branch → tests + `tsc` + build → merge → Worker deploy (`npx wrangler deploy`) + snapshot script runs at 2am (watchlistSymbols appears next snapshot) + DMG rebuild at session end. No migrations.
