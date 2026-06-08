# IBKR Market-Data Snapshot — Quote Enrichment (items 2 + 3)

**Date:** 2026-06-08
**Status:** Approved (scope: "free byproduct" price coverage + full IV/52wk/yield enrichment)

## Problem

The app has no source for per-security **implied volatility**, **52-week range**, or
**dividend yield**. Greeks falls back to a blind 30% vol when an option's market price
is missing (`lib/compute/options-greeks.ts:431`). Security Detail shows none of these
fundamentals. Separately, **watchlist (non-held)** securities get no price refresh from
any current path (held positions get `mktPrice` via the OAuth `/portfolio` fallback;
benchmarks get a Yahoo top-up; watchlist is uncovered).

The IBKR Web API `/iserver/marketdata/snapshot` returns **all of these in one batched
call** — last price + IV + historical vol + 52-week hi/lo + dividend yield — over the
same headless OAuth session already used for positions. No TWS dependency.

## Scope decision (user-approved 2026-06-08)

- **Item 3 (enrichment):** built in full — IV/HV/52wk/yield captured + consumed.
- **Item 2 (prices):** **free byproduct only.** The snapshot's price field tops up
  `prices` for **held + watchlist** symbols (watchlist = the only genuinely new
  coverage). The working held-price (`/portfolio` mktPrice) and Yahoo-benchmark paths
  are **not** touched or superseded.

## Design

### 1. Web API wrapper — `lib/ibkr/web-api.ts`

```ts
getMarketDataSnapshot(cfg, lst, conids: number[], fields: string[]): Promise<RawSnapshotRow[]>
```

- Signed GET `/iserver/marketdata/snapshot?conids=<csv>&fields=<csv>`.
- IBKR requires a **warm-up call** — the first request to a conid returns a sparse row;
  fields populate on the second poll ~1s later. The wrapper issues the request, and if
  target fields are absent, re-polls once after a short delay (bounded retry, ≤2 polls).
- Returns raw rows keyed by `conid` with numeric-coded fields.

**Field codes (VERIFIED via live probe 2026-06-08, AAPL conid 265598, cross-checked
against the connector's named fields):**

| Code | Meaning | Raw value | Parse |
|------|---------|-----------|-------|
| `31`   | Last price | `"302.94"` | `parseFloat` |
| `7283` | Implied Vol % (underlying) | `"24.279%"` | strip `%`, ÷100 → fraction |
| `7284` | Historic Vol % (30d) | `"23.216%"` | strip `%`, ÷100 → fraction |
| `7293` | 52-week High | `"316.94"` | `parseFloat` |
| `7294` | 52-week Low | `"194.47"` | `parseFloat` |

Cross-check: `7084` (IV/HV ratio) = 104.6% = 24.279/23.216 ✓; connector
`implied-vol-underlying.annual_iv`=0.244 ✓, `historical-vol.annual_pct`=0.232 ✓,
`misc-statistics.high_52w`=316.94 ✓. A `SNAPSHOT_FIELDS` constant records this map with
the inline "verified 2026-06-08" note.

**Dividend yield — DEFERRED.** The raw `/iserver/marketdata/snapshot` does NOT expose
dividend yield (codes 7286–7289 returned nothing across 3 warm-up polls). The connector
sources it from a separate fundamentals endpoint. Rather than chase + verify another
endpoint (scope creep; yield is the lowest-value of the three), the `dividend_yield`
column stays nullable and is left null for now — a one-line add later. IV + HV + 52wk
range are the high-value, verified payload.

### 2. Storage — migration `058_security_quotes.sql`

```sql
CREATE TABLE security_quotes (
  security_id    INTEGER PRIMARY KEY REFERENCES securities(id) ON DELETE CASCADE,
  as_of_date     TEXT NOT NULL,
  iv_underlying  REAL,      -- annualized fraction (0.30 = 30%)
  hv_30d         REAL,      -- annualized fraction
  week52_high    REAL,
  week52_low     REAL,
  dividend_yield REAL,      -- percent (1.8 = 1.8%)
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Single row per security (latest wins), mirroring the `security_betas` cache pattern.
`as_of_date` is ET (`todayET()`).

- Mutation: `lib/mutations/security-quotes.ts::upsertSecurityQuote(db, row)`.
- Query: `lib/queries/security-quotes.ts::getSecurityQuote(db, securityId)`.

### 3. Capture — `lib/ibkr/refresh.ts`

A new `fetchAndStoreQuotes(db, cfg, lst, securityIds)` runs **inside the existing IBKR
refresh session** (one LST, no new launchd job). Resolves conids from
`securities.ib_con_id` for held + watchlist symbols, batches the snapshot call, and:
- upserts `security_quotes` (IV/HV/52wk/yield),
- writes the price field to `prices` (source `'tws'`) for held + watchlist only.

Best-effort: any failure logs + degrades (never blocks the positions write). Gated on
OAuth config presence (same as `refreshIbkrHoldingsFromWebApi`).

### 4. Consumers

- **Greeks (IV):** `computeOptionsGreeks` reads `security_quotes.iv_underlying` for the
  option's underlying as the fallback sigma when the option price is missing — replacing
  the hardcoded `0.3`. When a quote exists, the diagnostic reason changes from
  `missing_iv` to a computed Greek (annotated `iv_source: "ibkr"`). When neither option
  price nor stored IV exists, the 0.3 fallback remains.
- **Security Detail (52wk + yield):** a small `<QuoteStats>` strip on
  `/dashboard/security/[id]` — 52-week range (with current-price position) + dividend
  yield. Public market data → rendered with plain `formatPercent`/`formatUSD` (NOT
  privacy-masked; these reveal nothing about the user's holdings).

## Testing (TDD)

- `getMarketDataSnapshot` parse/retry — mocked `signedRequest` (sparse-then-full rows).
- `upsertSecurityQuote` / `getSecurityQuote` — in-memory DB, upsert-replaces.
- `fetchAndStoreQuotes` — DI-mocked snapshot fn; asserts `security_quotes` +
  held/watchlist price writes, and that non-held/non-watchlist conids are skipped.
- Greeks IV fallback — option with no price + a stored quote → uses stored IV, not 0.3.
- Migration applies cleanly; full suite + tsc green.

## Out of scope / non-goals

- No supersession of the `/portfolio` mktPrice or Yahoo-benchmark price paths.
- No per-option IV storage (Greeks solves per-option IV from price already).
- No Worker mirror (cloud path doesn't compute Greeks or render Security Detail).
- No new scheduler — rides the existing IBKR refresh.
```
