# Codex Session Handoff — 2026-04-26

This file summarizes the project interview, architectural conclusions, adversarial-review synthesis, and the critical bug-fix pass implemented by Codex on 2026-04-26.

## Project Intent

Vanguard Skin started as a way to make Vanguard and IBKR account reporting usable in one place. Vanguard reporting is especially weak for margin/leverage and downloadable data; IBKR is better for live/trading data. The long-term goal is a secure financial second brain for active investing/trading: portfolio accounting, live/provisional state, research ingestion, trade journaling, AI-assisted review, and cross-device access.

Primary user workflows:

- Morning prep from about 7:30am to market open: ingest email research, Substack/newsletters, Twitter/X, market context, and TMT Breakout.
- Intraday: alerts for breaking news, meaningful stock moves, and "why is this moving?"
- After market close: earnings calls, earnings research, and trade/portfolio review.
- Second brain: click a ticker and see related research, trades, thesis history, notes, alerts, and prior AI/trade-review context.

Product direction:

- Reliability first, UX friction second.
- Month-end broker statements are source of truth.
- TWS live sync is provisional/current-month state, especially useful for IBKR.
- Vanguard mid-month values are estimates unless backed by statement data.
- Numbers must be auditable and trustworthy because they represent real money.
- AI should summarize, research, coach, review trades, detect patterns, and push back, but should never trade or share sensitive financial data.
- Long-term app direction may include brother/trading group/users, so multi-user privacy and account isolation matter even if current use is personal.

## Architectural Priorities

The next engineering phase should be "Number Trust" before feature expansion:

- Every displayed financial number should have provenance: statement-confirmed, broker-live, estimated, stale, manual, or AI-extracted.
- Account scoping must be explicit and fail closed.
- Imports must have clear commit, correction, recompute, and undo semantics.
- Derived analytics must not silently fail after a successful import.
- Security boundaries must be treated as product features because this app handles financial data.

Important deferred areas:

- Import undo/re-import consistency.
- Scope fail-open and multi-account collapse.
- TWS stale-data and wedged-sync behavior.
- Worker failover and stale snapshot semantics.
- Alert correctness and visibility drift.
- Chat/tool timeout and AI data-boundary hardening.

## Adversarial Review Synthesis

The supplied adversarial review files were read from:

`/Users/Yitzi/Desktop/Codex Adversarial Review 2026-04-26/`

Reviewed files:

- `api.md`
- `import.md`
- `tws.md`
- `calendar.md`
- `workers.md`
- `alerts.md`

Combined priority order identified:

1. Import-derived option prices could be inflated 100x by applying the option multiplier twice.
2. Calendar enrichment auth accepted missing secrets and could leak `CRON_SHARED_SECRET` via caller-controlled `Host` self-fetch.
3. Import undo/re-import semantics are not reliable.
4. Scope handling can fail open or collapse multi-account views to one account.
5. TWS sync can mix fresh/stale data and wedge on hung promises.
6. Calendar `release_time` ingestion can silently skip events forever.
7. Worker failover can duplicate/miss emails and use stale snapshots.
8. Alerts can compute MA levels from the wrong bar size and leak pending/rejected levels into visible surfaces.
9. Streaming routes lack timeout/failure boundaries.
10. API boundary validation is inconsistent.

## Implemented Critical Bug Pass

Branch:

`codex/critical-bug-pass`

Implemented only the agreed critical items:

1. Correct import-derived option prices.
2. Lock down calendar enrichment auth and remove the `Host` self-call secret leak.
3. Populate `calendar_events.release_time` during normal ingestion.

### Import Valuation Fix

Files changed:

- `lib/valuation.ts`
- `lib/import/engine.ts`
- `tests/lib/valuation.test.ts`
- `tests/import/engine.test.ts`

Behavior:

- Added `unitPriceFromMarketValue()`, the inverse of existing `marketValue()`.
- Stocks/ETFs/funds: `unitPrice = marketValue / quantity`.
- Bonds: inverse percent-of-par pricing, `unitPrice = marketValue * 100 / quantity`.
- Options: `unitPrice = marketValue / quantity / multiplier`.
- Import-derived holding prices now use security type and multiplier from the database.
- Explicit parser-provided prices for the same symbol/date/source are not overwritten by holding-derived prices from the same import.

New test coverage:

- Option holding with 5 contracts, `marketValue=1750`, `multiplier=100` stores `close_price=3.5`, not `350`.
- Bond holding stores percent-of-par price correctly.
- Existing stock behavior remains unchanged.
- Explicit same-import statement price wins over derived price.

### Calendar Auth Fix

Files changed:

- `app/api/calendar/enrich/route.ts`
- `app/api/calendar/reconcile-cloud-enrich/route.ts`
- `lib/calendar/cloud-reconcile.ts`
- `scripts/enrich-calendar-events.sh`
- `tests/calendar/reconcile-cloud-enrich.test.ts`
- `tests/calendar/enrich-route.test.ts`

Behavior:

- `POST /api/calendar/enrich` now requires `X-Cron-Secret` matching `CRON_SHARED_SECRET`.
- `POST /api/calendar/reconcile-cloud-enrich` now requires the same.
- Missing or wrong header returns `403`.
- Missing server `CRON_SHARED_SECRET` returns `500`.
- Removed the internal self-fetch built from caller-controlled `Host` / `X-Forwarded-Proto`.
- Moved cloud reconciliation logic into `lib/calendar/cloud-reconcile.ts`.
- The enrich route calls the helper directly instead of sending the cron secret to an HTTP URL derived from request headers.
- Launchd script now treats non-2xx HTTP as failure and falls back to direct `tsx` execution.

New test coverage:

- Missing/wrong secrets are rejected.
- Missing server secret returns `500`.
- Correct secret permits enrichment.
- Enrich route does not send `X-Cron-Secret` to a caller-controlled host.

### Calendar Release-Time Ingestion Fix

Files changed:

- `lib/calendar/release-times.ts`
- `lib/mutations/calendar.ts`
- `tests/calendar/release-times.test.ts`
- `tests/calendar/queries-mutations.test.ts`

Behavior:

- `upsertCalendarEvents()` now writes normalized `release_time` on insert and update.
- `event_time="HH:MM"` remains authoritative.
- Macro events use `RELEASE_TIMES_ET`.
- Earnings event-time codes are normalized:
  - `BMO -> 08:00`
  - `AMC -> 16:15`
  - `DMH -> 16:15`
  - explicit `UNKNOWN -> 16:15`
- Finnhub-style `raw_json.entry.hour` is also normalized.
- Unresolvable events intentionally keep `release_time = null`.

No live database backfill was run.

## Verification Performed

Targeted Vitest run:

```bash
npx vitest run tests/import/engine.test.ts tests/lib/valuation.test.ts tests/calendar/release-times.test.ts tests/calendar/queries-mutations.test.ts tests/calendar/reconcile-cloud-enrich.test.ts tests/calendar/enrich-route.test.ts --exclude '.Codex/**'
```

Result:

- 6 test files passed.
- 87 tests passed.

TypeScript:

```bash
npx tsc --noEmit
```

Result:

- Passed.

Focused ESLint:

```bash
npx eslint --quiet lib/valuation.ts lib/import/engine.ts lib/calendar/release-times.ts lib/mutations/calendar.ts lib/calendar/cloud-reconcile.ts app/api/calendar/enrich/route.ts app/api/calendar/reconcile-cloud-enrich/route.ts tests/lib/valuation.test.ts tests/import/engine.test.ts tests/calendar/release-times.test.ts tests/calendar/queries-mutations.test.ts tests/calendar/reconcile-cloud-enrich.test.ts tests/calendar/enrich-route.test.ts
```

Result:

- Passed.

Note:

- `npm run typecheck` was attempted but the repo has no `typecheck` script.
- Repo-wide `npm run lint -- --quiet` was attempted but it traversed packaged Electron `dist` output and was stopped; focused lint was used instead.

## Current Repo State At Handoff

Current branch:

`codex/critical-bug-pass`

Known pre-existing/unrelated local changes that were not intentionally modified by this bug pass:

- `AGENTS.md`
- `qa/qa-report.txt`
- `.agents/`
- `.codex/`
- `docs/codex-migration.md`

New files from this pass:

- `lib/calendar/cloud-reconcile.ts`
- `tests/calendar/enrich-route.test.ts`

This handoff file:

- `docs/codex-session-handoff-2026-04-26.md`

## Recommended Next Session

Next session should take the high-priority bugs in this order:

1. Import undo/re-import contract:
   - Decide append vs replace vs revise-in-place.
   - Stop undo from globally wiping derived tables without recompute.
   - Prevent corrected imports from splitting state across transactions, holdings, prices, and snapshots.

2. Scope fail-closed:
   - Replace fuzzy/fail-open scope helpers.
   - Invalid scope should return `400`, never widen to all accounts.
   - Multi-account scopes should either be supported consistently or rejected explicitly.

3. TWS stale-data rules:
   - Add freshness/provenance status to sync outputs.
   - Decide whether partial price refresh can drive valuations and alerts.
   - Add a lease/timeout/watchdog around sync state.

4. Worker failover:
   - Make primary success body-aware, not HTTP-status-only.
   - Add claim-before-send dedup or accept/document duplicate risk.
   - Add stale snapshot refusal/warning rules.

5. Alerts correctness:
   - Ensure MA levels use daily bars only.
   - Decide whether `review_status` gates visibility or only scan arming.
   - Add uniqueness/race protection for alert firing.
