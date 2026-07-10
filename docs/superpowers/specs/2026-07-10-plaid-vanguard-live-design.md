# Plaid Live Vanguard Holdings — Design

**Date:** 2026-07-10
**Status:** Approved design, pre-implementation
**Goal:** Mid-month Vanguard position changes (buys/sells, cash) reach Portfolio Desk within a day, instead of waiting for the monthly PDF statement. Monthly statements remain the authoritative ledger.

## Scope

- **In:** Holdings quantities + cash balance for both Vanguard accounts (Taxable + Roth), refreshed daily + on demand. Prices for securities TWS cannot cover (Vanguard mutual funds).
- **Out:** Transactions / tax lots (statements remain the only transaction source — no dedup risk), cost basis (Plaid's is unreliable), intraday freshness (Plaid refreshes once daily after close), the paid `/investments/refresh` add-on.

## Why Plaid / feasibility facts (verified 2026-07-10)

- Plaid's **Investments** product supports Vanguard (holdings + investment accounts), US-only, OAuth-based connection ([plaid.com/institutions/vanguard](https://plaid.com/institutions/vanguard/)).
- Investments data updates **once daily after market close** on Plaid's side; on-demand refresh is a paid add-on we skip.
- Plaid's **Trial plan** (US/Canada teams created after 2026-04-15) allows real production data free, capped at 10 production Items — one Item (the Vanguard login) is all this needs.
- TWS already prices Vanguard-held listed securities daily (`fetchSnapshotPrices`), so what Plaid adds is **position changes, cash, and mutual-fund prices** — not general pricing.

## Architecture

Mirror of the IBKR Web API live path (`lib/ibkr/refresh.ts`): a live-sync module that writes broker-snapshot-semantics rows which the monthly statement import later overwrites.

### 1. Connect flow & credentials

- **Static creds:** `PLAID_CLIENT_ID` + `PLAID_SECRET` via the standard Electron env-threading pattern (4 touchpoints: `AppSettings`, `ENV_TO_SETTING` row in `bootstrapFromEnvLocal`, `getSanitizedSettings`, `main.ts` env injection) + `.env.local` for dev. Optional `PLAID_ENV` (`sandbox` | `production`), default `production`.
- **No new npm dependencies:** server side calls Plaid's REST API (JSON-over-POST) with `fetch`; the frontend loads Plaid Link via its hosted script tag (`https://cdn.plaid.com/link/v2/stable/link-initialize.js`).
- **Connect UI:** "Vanguard Live (Plaid)" section in `SettingsModal`:
  1. `POST /api/plaid/link-token` → `/link/token/create` (products: `investments`).
  2. Plaid Link widget opens; user OAuths into Vanguard; Link returns `public_token`.
  3. `POST /api/plaid/exchange` → `/item/public_token/exchange`; the permanent `access_token` is stored in the SQLite **`settings` table** (runtime-obtained, DB is local + gitignored; same home as `feature_model_overrides`). Never in git, never in settings.json.
- **Account mapping:** after exchange, list Plaid accounts and auto-match to local `accounts` rows by name/mask; user confirms the proposed Taxable/Roth mapping in Settings; persisted as `plaid_account_map` in `settings`.

### 2. Sync engine (`lib/plaid/refresh.ts::refreshVanguardHoldingsFromPlaid(db, opts?)`)

Pipeline per run (all-or-nothing per account, DI-shaped, injected `fetchImpl` for tests):

1. **Fetch** `/investments/holdings/get` (returns holdings + securities + account balances in one call).
2. **Map securities.** Resolution order: `ticker_symbol` match against `securities` (issuer-family aware) → CUSIP match → **log-and-skip** (surfaced in the sync result; never guessed). Options run through `ensureOCCSymbol()` before matching. Plaid rows for the settlement fund (VMFXX) fold into cash, not holdings.
3. **Write holdings**: full snapshot per mapped account at `todayET()`, `source_key = 'plaid:{acct}:{symbol}'`, **`cost_basis = NULL`** (readers COALESCE back to statement rows — same as TWS rows).
4. **Same-day stale cleanup**: sibling of `removeStaleSameDayTwsHoldings` for `plaid:%` rows absent from the current pull; 50% shrink-guarded.
5. **Closed positions**: call the existing `reconcileClosedEquityHoldings(db)` (snapshot-diff → `quantity = 0` rows, non-destructive, shrink-guarded).
6. **Live account snapshot**: same-day `monthly_snapshots` row (NetLiq + cash) with **`source = 'plaid'`** — a fresh cash anchor so a mid-month buy doesn't double-count against carried-forward inferred cash.
7. **Mutual-fund prices**: Plaid `institution_price` → `prices` with `source = 'vanguard'` (priority 3) **only** for securities whose `security_type` is `Mutual Fund` (case-insensitive, per convention) — the one class TWS snapshot pricing doesn't cover; TWS (priority 1) keeps winning elsewhere.
8. **`computeDailyValuations()`**, then report through sync-state with `lastSyncVia: 'plaid'` (mutex via `isSyncing()`).

### 3. Invariant extensions (the sacred-ground changes)

- **`LIVE_SNAPSHOT_SOURCES = ('tws', 'plaid')`** in one new shared module. Every `monthly_snapshots` exclusion site currently written as `source != 'tws'` sweeps to the shared predicate. A lint-style test asserts no raw `!= 'tws'` comparison survives outside the module.
- **Statement-wins upserts** extend by one pattern each:
  - `holdings` conflict clause: overwrite `WHERE source_key LIKE 'tws-%' OR source_key LIKE 'plaid:%'`.
  - `monthly_snapshots` conflict clause: overwrite `WHERE source IN ('tws','manual','plaid')`.
- Symmetric guard: the Plaid snapshot write only lands when no statement row exists for that (account, date) — same as `lib/tws/positions.ts`.

### 4. Triggers

- **Daily auto:** launchd `com.vanguard-skin.plaid-sync.plist` — `StartInterval=300` + `et-gate.sh` self-gate (**never `StartCalendarInterval`**), first tick after **07:30 ET Mon–Fri**, `isMarketClosed` holiday skip, once-per-ET-day marker. Script calls `POST /api/plaid/sync` with `X-Cron-Secret`. 07:30 lands after Plaid's overnight Vanguard re-scrape and before the 8:45 digest.
- **Manual:** "Sync Vanguard now" button in the Settings section and on the Accounts tab next to the Vanguard cards (in-app route, no cron auth). Honest-feedback rules: show counts + unmatched symbols, explain no-ops, loud failures.

### 5. Error handling

- **`ITEM_LOGIN_REQUIRED`** (Vanguard forces re-auth): persist `plaid_connection_status` in `settings`, Settings shows a **Reconnect** button (Link update mode — mapping survives), fire a one-time Pushover alert (stamp-before-push). Loud, not silent drift.
- Zero-holdings account responses are skipped entirely (never written); shrink guards protect against partial responses.
- All upstream errors bubble into the sync-state result (no bare `catch { console.warn }`).

### 6. Testing

- In-memory SQLite + injected `fetchImpl`; sanitized Plaid holdings fixture in `tests/fixtures/`, real capture gitignored in `tests/fixtures/real/`.
- Unit: security mapping (ticker → CUSIP → skip; OCC conversion), statement-wins upserts (both tables), same-day stale removal + shrink guard, cash-anchor math (mid-month buy doesn't double-count), settlement-fund→cash folding, `LIVE_SNAPSHOT_SOURCES` sweep lint test.
- Contract test for any new API route a component fetches.
- E2E: Plaid **Sandbox** Item first, then live Vanguard connect; verify DB rows + Accounts UI as a real user (dev server, real clicks).

## Decisions log

| Decision | Choice | Why |
|---|---|---|
| Scope | Holdings + cash only | No transaction dedup risk; statements stay the ledger |
| Cadence | Daily auto + manual button | Plaid only refreshes daily; free tier |
| Aggregator | Plaid (not SnapTrade/Yodlee) | Free Trial plan, Vanguard Investments support verified |
| SDK | None — plain `fetch` + Link script tag | No-new-deps rule; Worker-mirror pattern is fetch-based anyway |
| Access token home | SQLite `settings` table | Runtime-obtained by web app; DB local + gitignored |
| Cost basis | Ignored (NULL) | Plaid unreliable; COALESCE-to-statement precedent exists |
| Snapshot provenance | New `source = 'plaid'` + shared `LIVE_SNAPSHOT_SOURCES` predicate | Honest provenance without scattering a second magic string |
| Prices | Mutual funds only, priority 3 | TWS already prices listed securities at priority 1 |
