# Foreign-currency valuation (KRW phantom-position fix) — design

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation plan
**Origin:** Deep-QA sweep 2026-07-01, HIGH finding — `402340.KS` (Korea Exchange listing) priced in KRW but rendered as USD, creating a $17.3M phantom position that poisons Today, Security Detail, and every Analysis surface (allocation reads $19.3M vs the real ~$2.1M, scenario impacts ~13× inflated, factor alpha +204%).

## Problem

`402340.KS` is held in IBKR, priced at ₩1,731,000/share, 10 shares, cost basis ₩16,329,792. The app stores the KRW price verbatim in `prices.close_price` (`source='tws'`) and computes market value as `quantity × close_price × multiplier` with **no currency awareness and no FX conversion**, then renders it with a hardcoded `$`. Result: ₩17.31M shows as **$17.3M** (~8× the whole portfolio).

### Root cause (verified via code map)

- `securities` has **no `currency` column**; `prices` has none either. The data model is implicitly USD-only.
- Both ingestion paths receive the broker's `currency` field and **discard it**:
  - TWS (`lib/tws/positions.ts::syncPortfolio`): `contract.currency` never read; `pos.marketPrice` (KRW) written to `prices.close_price` (upsert ~line 360).
  - IBKR Web API (`lib/ibkr/map-positions.ts::mapPosition`): `RawPosition.currency` typed but never mapped into `MappedPosition`; `mktPrice` (KRW) written by `lib/ibkr/refresh.ts::writeIbkrHoldings`.
  - `lib/tws/contracts.ts::buildContract` and `lib/tws/snapshot.ts::fetchSnapshotPrices` hardcode `currency:"USD"`.
- Valuation (`lib/valuation.ts::marketValue` / `adjustedMarketValueSQL`) computes `quantity × price × multiplier` with no FX term. Every holdings-derived surface inherits the error (`lib/compute/daily-valuation.ts`, `lib/queries/analysis.ts` lines 193/273/367/535/646, `lib/queries/accounts.ts`, `lib/compute/factors.ts`).
- Display (`lib/format.ts`, `lib/privacy/components.tsx::Money`) is currency-agnostic — always `$`.
- **No FX infrastructure exists anywhere** in the repo.

### Key insight — the broker figures are already correct

IBKR reports account NetLiq in USD base currency, so the account's `monthly_snapshots.total_value` ($484,374 for IBKR on 2026-07-01) is **correct** — it already nets the KRW asset against the borrowed-KRW margin loan that funded it. Both broker paths also hand us a **USD market value per position** (TWS `Position.marketValue`; IBKR Web API `mktValue`) and a **per-currency ledger with an explicit `exchangeRate`** (IBKR `getLedger`) — all currently discarded. The corruption is **only** in the app's per-holding recomputation, which is why NetLiq-anchored totals stay right while holdings-summed Analysis surfaces read $19.3M.

## Scope

**Goal (user-selected):** *Correct net numbers only.* The KRW stock must show its true ~USD value everywhere and account totals must stay right. The borrowed-KRW loan stays **implicit** in cash (already netted in NetLiq) — not surfaced as its own line.

**In scope:**
- Per-security currency + an FX rate applied at the single valuation chokepoint so all surfaces convert uniformly.
- Rate sourced from the broker's own data (authoritative, no external API).

**Out of scope (documented known limitations):**
- The KRW margin loan as its own visible negative-cash / liability line.
- Per-currency cash-ledger ingestion (cash stays a single USD scalar; the loan remains netted in NetLiq / inferred-cash residual).
- Historical / tax-accurate FX for Form 8949 tax lots — a **current-rate** approximation is used for cost-basis display; KRW tax-lot basis remains a noted limitation.
- Display layer stays USD-only (`<Money>` / `formatUSD` unchanged).
- First-class multi-currency UI (labels, per-currency toggles).

## Approach — currency-aware valuation (chosen over ingestion-rewrite / external FX feed)

Convert at the one valuation chokepoint every surface already flows through, using a broker-derived rate. This fixes it once rather than chasing every price-writing path, and needs no external dependency.

### 1. Data model — migration `061`

- `ALTER TABLE securities ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';` — existing rows backfill to `'USD'` (zero behavioral change for all current holdings).
- New table:
  ```sql
  CREATE TABLE fx_rates (
    currency     TEXT PRIMARY KEY,   -- ISO code, e.g. 'KRW'
    usd_per_unit REAL NOT NULL,      -- 1 unit of `currency` = this many USD
    as_of        TEXT NOT NULL,      -- YYYY-MM-DD
    source       TEXT                -- 'ibkr_ledger' | 'tws_exchange_rate' | 'tws_derived'
  );
  ```
  `USD` is implicitly `1.0` and is never stored.

**Invariant:** `prices.close_price` and `holdings.cost_basis` are denominated in the owning security's `currency`. USD conversion happens only at read/valuation time. USD securities (rate 1.0) are unaffected.

### 2. Ingestion — persist currency + capture an authoritative rate

- **IBKR Web API** (`lib/ibkr/map-positions.ts`, `lib/ibkr/refresh.ts`): add `currency` to `MappedPosition`, map `raw.currency`, persist to `securities.currency` via the upsert. Capture the rate from `getLedger`'s per-currency `exchangeRate` (already fetched, currently discarded) → upsert `fx_rates` (`source='ibkr_ledger'`).
- **TWS** (`lib/tws/positions.ts`): read `contract.currency` into `upsertSecurity`. Capture the rate from the per-currency `ExchangeRate` account value when present (`source='tws_exchange_rate'`); else derive `marketValue_USD / (marketPrice_local × qty × multiplier)` (`source='tws_derived'`) and upsert `fx_rates`.
- Remove the hardcoded `currency:"USD"` in `lib/tws/contracts.ts::buildContract` and `lib/tws/snapshot.ts` so a non-USD contract is queried on its real exchange (keeps the nightly snapshot-refresh price valid rather than fetching a wrong/USD-forced quote).
- Rates are **broker-sourced, never guessed**.

### 3. Valuation — apply FX at the chokepoint

- `lib/valuation.ts`:
  - `adjustedMarketValueSQL()` multiplies price by the security's USD rate via a `LEFT JOIN fx_rates` on `securities.currency` with `COALESCE(fx.usd_per_unit, 1)`.
  - `marketValue()` (the JS variant) takes an optional `usdPerUnit` factor (default 1) so callers holding a rate can pass it; `lib/compute/daily-valuation.ts` supplies it.
- Because all holdings-value surfaces route through these two functions, Today / Security Detail / Analysis (allocation, exposure, tilts, scenarios, factors) / `daily_valuations` all become USD-correct together.
- **Cost basis** is converted by the same current rate at the unrealized-gain display sites so gain is coherent.
- `monthly_snapshots` (broker NetLiq) is **not** touched; removing the phantom from holdings-derived `daily_valuations` self-heals the inferred-cash residual (which had gone hugely negative).

### 4. Display

Unchanged — conversion is upstream, so `<Money>` / `formatUSD` keep emitting `$` on already-USD values.

## Testing

- **Unit** (`tests/valuation` / compute): `marketValue` + `adjustedMarketValueSQL` with a KRW security + `fx_rates` row → correct USD; a USD security → identical to today (regression guard that the USD path is byte-unchanged).
- **Ingestion**: a broker payload with `currency:'KRW'` + exchangeRate persists both the security currency and the `fx_rates` row; a USD payload leaves `currency='USD'` and writes no `fx_rates` row.
- **Integration** (`:memory:` DB seeded with the real 402340 figures + a KRW rate): Analysis allocation total ≈ $2.1M (not $19.3M); 402340 market value ≈ $12.7K; IBKR account total unchanged.
- **Full suite**: `npx vitest run` (2828 currently green) must stay green before completion.

## Validation gate (first implementation step)

Before building on the TWS-path derivation, validate that `Position.marketValue` is USD-base by checking the derived rate for the live `402340.KS` position against a known KRW/USD spot (≈1,362 KRW/USD → rate ≈ 0.000734). If TWS `marketValue` turns out to be local-currency on this account, fall back to the IBKR-Web-API ledger `exchangeRate` as the sole authoritative source and skip TWS derivation.

## Files touched (anticipated)

- `lib/db/migrations/061_*.sql` (new)
- `lib/tws/positions.ts`, `lib/tws/contracts.ts`, `lib/tws/snapshot.ts`
- `lib/ibkr/map-positions.ts`, `lib/ibkr/refresh.ts`, `lib/ibkr/web-api.ts` (types)
- `lib/valuation.ts`
- `lib/compute/daily-valuation.ts`
- new `lib/queries/fx-rates.ts` + `lib/mutations/fx-rates.ts` (read/write helpers, db-injection pattern)
- cost-basis display sites (unrealized gain) — enumerated in the implementation plan
- tests as above
