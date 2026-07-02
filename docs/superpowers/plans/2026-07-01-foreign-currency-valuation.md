# Foreign-currency valuation (KRW phantom-position fix) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make foreign-currency (KRW) holdings value correctly in USD everywhere, eliminating the `402340.KS` $17.3M phantom position, without changing behavior for USD holdings.

**Architecture:** Add a `currency` column to `securities` and an `fx_rates` (currency → USD) table. Populate the rate from the broker's own USD figures during sync (no external FX feed). Apply the conversion at the single valuation chokepoint (`lib/valuation.ts`) so every holdings-derived surface converts uniformly. Account totals from broker NetLiq are untouched.

**Tech Stack:** Next.js 16 / TypeScript 5, better-sqlite3 (WAL, FK on), Vitest (`:memory:` DBs), `@stoqey/ib` (TWS) + first-party IBKR Web API.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-01-foreign-currency-valuation-design.md`.
- **Invariant:** `prices.close_price` and `holdings.cost_basis` are denominated in the owning security's `securities.currency`; USD conversion happens only at read/valuation time.
- **USD path must be byte-unchanged:** `currency='USD'` ⇒ rate 1.0 ⇒ identical output to today. Every task includes a USD regression assertion.
- FX rates are **broker-sourced, never guessed or hardcoded** (data-integrity rule). One unit of `currency` = `usd_per_unit` USD.
- All DB functions take `db: Database.Database` (DI for `:memory:` tests). Queries in `lib/queries/`, mutations in `lib/mutations/`.
- `prices` table columns are `date` + `close_price` (never `close`). Always `COALESCE(s.multiplier, 1)`.
- Scope: **correct net numbers only** — no visible loan line, no per-currency cash ingestion, no display-layer currency labels, no tax-lot historical FX.
- Run `npx vitest run` (2828 tests currently green) at the end; must stay green. Do not commit with failing tests.
- Commit after each task. No push (user authorizes pushes separately).

---

### Task 1: Migration 061 — `securities.currency` + `fx_rates` table

**Files:**
- Create: `lib/db/migrations/061_foreign_currency.sql`
- Test: `tests/db/migration-061-currency.test.ts`

**Interfaces:**
- Produces: `securities.currency TEXT NOT NULL DEFAULT 'USD'`; table `fx_rates(currency TEXT PK, usd_per_unit REAL NOT NULL, as_of TEXT NOT NULL, source TEXT)`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/db/migration-061-currency.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

describe("migration 061 — foreign currency", () => {
  it("adds securities.currency defaulting to USD and creates fx_rates", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const cols = db.prepare("SELECT name FROM pragma_table_info('securities')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("currency");

    // existing-style insert without currency → defaults to USD
    db.prepare(
      "INSERT INTO securities (symbol, security_type, source_key) VALUES ('AAPL','Stock','k1')",
    ).run();
    const row = db.prepare("SELECT currency FROM securities WHERE symbol='AAPL'").get() as { currency: string };
    expect(row.currency).toBe("USD");

    const fxCols = db.prepare("SELECT name FROM pragma_table_info('fx_rates')").all() as { name: string }[];
    expect(fxCols.map((c) => c.name).sort()).toEqual(["as_of", "currency", "source", "usd_per_unit"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/migration-061-currency.test.ts`
Expected: FAIL — `currency` not in `securities` columns / `fx_rates` has no columns.

- [ ] **Step 3: Write the migration**

```sql
-- lib/db/migrations/061_foreign_currency.sql
-- Foreign-currency valuation: per-security currency + FX rates.
-- Fixes the 402340.KS KRW-as-USD phantom. USD securities default to 'USD'
-- (rate 1.0, never stored) so all existing holdings are unaffected.

ALTER TABLE securities ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';

CREATE TABLE IF NOT EXISTS fx_rates (
  currency     TEXT PRIMARY KEY,   -- ISO code, e.g. 'KRW'
  usd_per_unit REAL NOT NULL,      -- 1 unit of `currency` = this many USD
  as_of        TEXT NOT NULL,      -- YYYY-MM-DD
  source       TEXT                -- 'ibkr_derived' | 'tws_derived' | 'ibkr_ledger'
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/migration-061-currency.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db/migrations/061_foreign_currency.sql tests/db/migration-061-currency.test.ts
git commit -m "feat(db): migration 061 — securities.currency + fx_rates table"
```

---

### Task 2: FX-rate read/write helpers

**Files:**
- Create: `lib/queries/fx-rates.ts`
- Create: `lib/mutations/fx-rates.ts`
- Test: `tests/queries/fx-rates.test.ts`

**Interfaces:**
- Consumes: `fx_rates` table (Task 1).
- Produces:
  - `getUsdPerUnit(db, currency: string): number` — returns 1 for `'USD'`/nullish, cached rate for a known currency, else 1 (fail-safe: never fabricate a rate; unconverted is better than a guessed one). Swallows "no such table" for minimal test DBs.
  - `upsertFxRate(db, { currency, usdPerUnit, asOf, source }): void` — validates `usdPerUnit` finite and `> 0`; no-op for `'USD'`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/queries/fx-rates.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getUsdPerUnit } from "@/lib/queries/fx-rates";
import { upsertFxRate } from "@/lib/mutations/fx-rates";

function db() { const d = new Database(":memory:"); runMigrations(d); return d; }

describe("fx-rates helpers", () => {
  it("USD is always 1 and never stored", () => {
    const d = db();
    expect(getUsdPerUnit(d, "USD")).toBe(1);
    upsertFxRate(d, { currency: "USD", usdPerUnit: 0.9, asOf: "2026-07-01", source: "x" });
    expect(d.prepare("SELECT COUNT(*) n FROM fx_rates").get()).toMatchObject({ n: 0 });
  });

  it("round-trips a KRW rate and reads it back", () => {
    const d = db();
    upsertFxRate(d, { currency: "KRW", usdPerUnit: 0.000734, asOf: "2026-07-01", source: "ibkr_derived" });
    expect(getUsdPerUnit(d, "KRW")).toBeCloseTo(0.000734, 9);
  });

  it("unknown currency and missing table fall back to 1 (never fabricate)", () => {
    const d = db();
    expect(getUsdPerUnit(d, "JPY")).toBe(1);
    const bare = new Database(":memory:");
    expect(getUsdPerUnit(bare, "KRW")).toBe(1);
  });

  it("refuses to write an implausible rate", () => {
    const d = db();
    expect(() => upsertFxRate(d, { currency: "KRW", usdPerUnit: 0, asOf: "2026-07-01", source: "x" })).toThrow();
    expect(() => upsertFxRate(d, { currency: "KRW", usdPerUnit: -1, asOf: "2026-07-01", source: "x" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queries/fx-rates.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the helpers**

```typescript
// lib/queries/fx-rates.ts
import type Database from "better-sqlite3";

/**
 * USD per 1 unit of `currency`. 'USD' (or nullish) → 1. Unknown currency or a
 * DB without the fx_rates table → 1 (fail-safe: leave the native value
 * unconverted rather than fabricate a rate — never guess FX).
 */
export function getUsdPerUnit(db: Database.Database, currency: string | null | undefined): number {
  if (!currency || currency.toUpperCase() === "USD") return 1;
  let row: { usd_per_unit: number } | undefined;
  try {
    row = db
      .prepare("SELECT usd_per_unit FROM fx_rates WHERE currency = ?")
      .get(currency.toUpperCase()) as { usd_per_unit: number } | undefined;
  } catch {
    return 1;
  }
  if (!row || !Number.isFinite(row.usd_per_unit) || row.usd_per_unit <= 0) return 1;
  return row.usd_per_unit;
}
```

```typescript
// lib/mutations/fx-rates.ts
import type Database from "better-sqlite3";

export interface FxRateInput {
  currency: string;
  usdPerUnit: number;
  asOf: string; // YYYY-MM-DD
  source: string;
}

/** Upsert an FX rate. No-op for USD; rejects non-finite / non-positive rates. */
export function upsertFxRate(db: Database.Database, r: FxRateInput): void {
  const currency = r.currency.toUpperCase();
  if (currency === "USD") return;
  if (!Number.isFinite(r.usdPerUnit) || r.usdPerUnit <= 0) {
    throw new Error(`Refusing to write implausible FX rate for ${currency}: ${r.usdPerUnit}`);
  }
  db.prepare(
    `INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(currency) DO UPDATE SET usd_per_unit = excluded.usd_per_unit,
       as_of = excluded.as_of, source = excluded.source`,
  ).run(currency, r.usdPerUnit, r.asOf, r.source);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/queries/fx-rates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/queries/fx-rates.ts lib/mutations/fx-rates.ts tests/queries/fx-rates.test.ts
git commit -m "feat(fx): fx_rates read/write helpers (broker-sourced, USD=1 fail-safe)"
```

---

### Task 3: Apply FX at the valuation chokepoint

**Files:**
- Modify: `lib/valuation.ts` (`marketValue` lines 14-24; `adjustedMarketValueSQL` lines 61-71)
- Test: `tests/valuation.test.ts` (add cases; create file if absent)

**Interfaces:**
- Consumes: nothing new (pure functions).
- Produces:
  - `marketValue(quantity, price, securityType, multiplier=1, usdPerUnit=1)` — final multiply by `usdPerUnit`.
  - `adjustedMarketValueSQL(quantityExpr, priceExpr, securityTypeExpr, multiplierExpr="1", fxExpr="1")` — wraps the existing CASE in `(... ) * COALESCE(${fxExpr}, 1)`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/valuation.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { marketValue, adjustedMarketValueSQL } from "@/lib/valuation";

describe("valuation FX", () => {
  it("USD (default rate 1) is unchanged", () => {
    expect(marketValue(10, 150, "Stock", 1)).toBe(1500);        // no 5th arg
    expect(marketValue(10, 150, "Stock", 1, 1)).toBe(1500);     // explicit 1
    expect(marketValue(5, 3.5, "Option", 100)).toBe(1750);
  });

  it("applies usdPerUnit for a foreign price", () => {
    // 402340.KS: 10 sh * ₩1,731,000 * 0.000734 ≈ $12,705.54
    expect(marketValue(10, 1_731_000, "Stock", 1, 0.000734)).toBeCloseTo(12705.54, 1);
  });

  it("SQL: fx defaults to 1 (byte-identical) and multiplies when provided", () => {
    const noFx = adjustedMarketValueSQL("q", "p", "t", "m");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE x (q REAL, p REAL, t TEXT, m REAL, fx REAL)");
    db.prepare("INSERT INTO x VALUES (10, 1731000, 'Stock', 1, 0.000734)").run();
    const usd = adjustedMarketValueSQL("q", "p", "t", "m", "fx");
    const rowUsd = db.prepare(`SELECT ${usd} AS v FROM x`).get() as { v: number };
    expect(rowUsd.v).toBeCloseTo(12705.54, 1);
    const rowNoFx = db.prepare(`SELECT ${noFx} AS v FROM x`).get() as { v: number };
    expect(rowNoFx.v).toBe(1731000 * 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/valuation.test.ts`
Expected: FAIL — `marketValue` ignores a 5th arg; `adjustedMarketValueSQL` has no `fxExpr`.

- [ ] **Step 3: Implement**

Replace `marketValue` body and `adjustedMarketValueSQL` in `lib/valuation.ts`:

```typescript
export function marketValue(
  quantity: number,
  price: number,
  securityType: string | null,
  multiplier: number = 1,
  usdPerUnit: number = 1
): number {
  const native =
    securityType?.toLowerCase() === "bond"
      ? (quantity * price) / 100
      : quantity * price * multiplier;
  return native * usdPerUnit;
}
```

```typescript
export function adjustedMarketValueSQL(
  quantityExpr: string,
  priceExpr: string,
  securityTypeExpr: string,
  multiplierExpr: string = "1",
  fxExpr: string = "1"
): string {
  return `(CASE WHEN LOWER(${securityTypeExpr}) = 'bond'
    THEN ${quantityExpr} * ${priceExpr} / 100.0
    ELSE ${quantityExpr} * ${priceExpr} * COALESCE(${multiplierExpr}, 1)
  END) * COALESCE(${fxExpr}, 1)`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/valuation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/valuation.ts tests/valuation.test.ts
git commit -m "feat(valuation): optional FX factor on marketValue + adjustedMarketValueSQL (USD unchanged)"
```

---

### Task 4: Convert holdings value in `daily-valuation.ts`

**Files:**
- Modify: `lib/compute/daily-valuation.ts` (the `marketValue(...)` call near line 112; the holdings SELECT that feeds it)
- Test: `tests/compute/daily-valuation-fx.test.ts`

**Interfaces:**
- Consumes: `marketValue(..., usdPerUnit)` (Task 3), `getUsdPerUnit` (Task 2).

**Context for implementer:** The holdings loop reads each holding's `security_type`, `multiplier`, and `close_price`. Join/read the security's `currency` in the holdings query, then pass `getUsdPerUnit(db, holding.currency)` as `marketValue`'s 5th arg. The per-holding query already joins `securities s`; add `s.currency` to its SELECT. (Confirm the exact SELECT column list and the loop variable name by reading the file first.)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/compute/daily-valuation-fx.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { upsertFxRate } from "@/lib/mutations/fx-rates";

// Seeds one account with a single KRW stock and asserts the day's holdings
// value is FX-converted, not the ₩ notional. (Fill account/holding/price
// inserts using this file's existing sibling tests as the schema reference.)
describe("computeDailyValuations FX", () => {
  it("values a KRW holding in USD, not won", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    // --- seed: account, KRW security (currency='KRW'), holding 10 @ ₩1,731,000, fx rate ---
    // (see tests/compute/*.test.ts for the exact insert shape used elsewhere)
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: "2026-07-01", source: "test" });
    // ... run computeDailyValuations(db, ...) and assert the KRW contribution
    // to total_value ≈ 12_705 USD, NOT 17_310_000.
    expect(true).toBe(true); // replace with the real assertion once seeded
  });
});
```

**Note to implementer:** replace the placeholder assertion by copying the seed pattern from the nearest existing `tests/compute/daily-valuation*.test.ts`; the deliverable is a real assertion that the KRW holding contributes ≈ $12,705 (not ₩17.31M) to `total_value`, plus a USD-holding case that is unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/compute/daily-valuation-fx.test.ts`
Expected: FAIL — KRW contributes 17,310,000 (rate not applied).

- [ ] **Step 3: Implement**

In `lib/compute/daily-valuation.ts`: add `s.currency` to the holdings SELECT, import `getUsdPerUnit`, and change the value line to:

```typescript
holdingsValue += marketValue(
  holding.quantity,
  price.close_price,
  holding.security_type,
  holding.multiplier,
  getUsdPerUnit(db, holding.currency),
);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/compute/daily-valuation-fx.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/compute/daily-valuation.ts tests/compute/daily-valuation-fx.test.ts
git commit -m "feat(valuation): FX-convert holdings value in computeDailyValuations"
```

---

### Task 5: Convert Analysis surfaces (allocation / exposure / tilts)

**Files:**
- Modify: `lib/queries/analysis.ts` (every `adjustedMarketValueSQL(...)` call — lines ~193, 273, 367, 535, 646)
- Modify (same pattern if they call the helper): `lib/queries/accounts.ts`, `lib/compute/factors.ts`
- Test: `tests/queries/analysis-fx.test.ts`

**Interfaces:**
- Consumes: `adjustedMarketValueSQL(..., fxExpr)` (Task 3).

**Context for implementer:** For each query using `adjustedMarketValueSQL`, add `LEFT JOIN fx_rates fx ON fx.currency = s.currency` to the FROM/JOIN chain (the queries already alias `securities` — confirm the alias, usually `s`), and pass `"COALESCE(fx.usd_per_unit, 1)"` as the new `fxExpr` argument. Where a query aggregates across multiple security aliases (e.g. option underlying `s_u`), FX-join on the alias whose price is being valued. Do NOT add FX to `monthly_snapshots`-based totals.

- [ ] **Step 1: Write the failing integration test (real 402340 numbers)**

```typescript
// tests/queries/analysis-fx.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getAllocationByDimension } from "@/lib/queries/analysis";

// Seed: one IBKR account, a USD stock (~$2.08M spread) + the KRW 402340
// (10 @ ₩1,731,000, currency='KRW'), fx KRW=0.000734. Assert the KRW row's
// value ≈ $12.7K and the allocation total ≈ real USD (~$2.1M), NOT $19.3M.
describe("Analysis allocation FX", () => {
  it("KRW holding contributes its USD value, not its won notional", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: "2026-07-01", source: "test" });
    // ... seed accounts/securities/holdings/prices per existing analysis tests ...
    // const alloc = getAllocationByDimension(db, { ...scope..., dimension: "category" });
    // const total = alloc.reduce((s, r) => s + r.value, 0);
    // expect(total).toBeLessThan(100_000);      // ~$2.1M seed, NOT $19.3M
    // expect(krwRow.value).toBeCloseTo(12705, -2);
    expect(true).toBe(true); // replace with real assertions once seeded
  });
});
```

**Note to implementer:** copy the seed shape from the nearest existing `tests/queries/analysis*.test.ts`. Deliverable: real assertions that the KRW position values at ≈$12.7K and the allocation total reflects real USD, plus a USD-only control that is unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queries/analysis-fx.test.ts`
Expected: FAIL — KRW valued at won notional.

- [ ] **Step 3: Implement** — add the `LEFT JOIN fx_rates` + `fxExpr` at each call site listed above.

- [ ] **Step 4: Run tests (targeted + the existing analysis suite for regressions)**

Run: `npx vitest run tests/queries/analysis-fx.test.ts tests/queries/analysis.test.ts tests/queries/analysis-option-lookthrough.test.ts tests/queries/analysis-exposure.test.ts`
Expected: PASS (new) + no regressions (existing).

- [ ] **Step 5: Commit**

```bash
git add lib/queries/analysis.ts lib/queries/accounts.ts lib/compute/factors.ts tests/queries/analysis-fx.test.ts
git commit -m "feat(analysis): FX-convert holdings value across allocation/exposure/tilts"
```

---

### Task 6: Ingestion — persist currency + capture the broker rate

**Files:**
- Modify: `lib/ibkr/map-positions.ts` (add `currency` to `MappedPosition`, map `raw.currency`)
- Modify: `lib/ibkr/refresh.ts` (`writeIbkrHoldings` upsert — persist currency; derive + `upsertFxRate` from `mktValue`/`mktPrice`)
- Modify: `lib/tws/positions.ts` (`syncPortfolio` — read `contract.currency` into `upsertSecurity`; derive + `upsertFxRate` from `marketValue`/`marketPrice`)
- Modify: `lib/tws/contracts.ts` (`buildContract` — stop hardcoding `currency:"USD"` for stocks), `lib/tws/snapshot.ts` (same)
- Modify: `lib/mutations/securities.ts` (`upsertSecurity` — accept + persist `currency`, defaulting `'USD'`)
- Test: `tests/ibkr/map-positions-fx.test.ts`, plus assertions in the TWS positions test if one exists.

**Interfaces:**
- Consumes: `upsertFxRate` (Task 2), `securities.currency` (Task 1).
- Produces: `MappedPosition.currency: string`; a helper `deriveUsdPerUnit(mktValueUsd, mktPriceLocal, quantity, multiplier=1): number | null` (returns null when inputs missing/≤0 so callers skip the fx upsert).

**Validation gate (do this step first):** Query the live DB for the derived rate and sanity-check it against spot KRW/USD (~1,362 KRW/USD → ~0.000734):
Run: `sqlite3 "file:$HOME/code/vanguard-skin/data/vanguard.db?mode=ro" "SELECT close_price FROM prices WHERE security_id=10132 ORDER BY date DESC LIMIT 1;"`
The TWS path derives the rate from `Position.marketValue` (USD base). If, on inspection of a live sync, `marketValue` for 402340 is NOT ~USD (i.e. derived rate ≈ 1 instead of ~0.000734), treat `marketValue` as local-currency on this account and instead source the rate from the IBKR Web API ledger `exchangeRate` (`lib/ibkr/web-api.ts::getLedger`), skipping TWS derivation. Record which source was used in `fx_rates.source`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ibkr/map-positions-fx.test.ts
import { describe, it, expect } from "vitest";
import { mapPosition, deriveUsdPerUnit } from "@/lib/ibkr/map-positions";

describe("IBKR position currency", () => {
  it("carries currency through mapPosition (default USD)", () => {
    expect(mapPosition({ assetClass: "STK", contractDesc: "AAPL", position: 10, mktPrice: 150 }).currency).toBe("USD");
    expect(mapPosition({ assetClass: "STK", contractDesc: "402340", currency: "KRW", position: 10, mktPrice: 1_731_000, mktValue: 12705 }).currency).toBe("KRW");
  });

  it("derives USD-per-unit from mktValue / (mktPrice*qty)", () => {
    expect(deriveUsdPerUnit(12705, 1_731_000, 10, 1)).toBeCloseTo(0.000734, 6);
    expect(deriveUsdPerUnit(null as unknown as number, 1_731_000, 10)).toBeNull();
    expect(deriveUsdPerUnit(12705, 0, 10)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ibkr/map-positions-fx.test.ts`
Expected: FAIL — `MappedPosition` has no `currency`; `deriveUsdPerUnit` not exported.

- [ ] **Step 3: Implement**

In `lib/ibkr/map-positions.ts`: add `currency: string;` to `MappedPosition`, set `const currency = (raw.currency ?? "USD").toUpperCase();` in `mapPosition`, and include `currency` in both returned objects. Add:

```typescript
/** USD per 1 unit of the position's local currency, from the broker's own USD
 *  market value. Returns null when inputs are missing/≤0 (caller skips fx write). */
export function deriveUsdPerUnit(
  mktValueUsd: number | null,
  mktPriceLocal: number | null,
  quantity: number,
  multiplier: number = 1,
): number | null {
  if (!mktValueUsd || !mktPriceLocal || !quantity) return null;
  const localNotional = mktPriceLocal * quantity * (multiplier || 1);
  if (localNotional <= 0) return null;
  const rate = mktValueUsd / localNotional;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}
```

Then in `lib/ibkr/refresh.ts::writeIbkrHoldings`: pass `p.currency` into the security upsert; when `p.currency !== "USD"`, compute `deriveUsdPerUnit(p.mktValue, p.mktPrice, p.quantity, p.multiplier)` and, if non-null, `upsertFxRate(db, { currency: p.currency, usdPerUnit: rate, asOf: <sync date>, source: "ibkr_derived" })`.

In `lib/tws/positions.ts::syncPortfolio`: read `contract.currency` (default `"USD"`) into the `upsertSecurity` call; when non-USD, `deriveUsdPerUnit(pos.marketValue, pos.marketPrice, pos.position, multiplier)` → `upsertFxRate(..., source: "tws_derived")`.

In `lib/mutations/securities.ts::upsertSecurity`: accept an optional `currency` field (default `"USD"`), add it to the INSERT column list and the `ON CONFLICT ... DO UPDATE` set (preserve existing non-USD value with `COALESCE`).

In `lib/tws/contracts.ts::buildContract` and `lib/tws/snapshot.ts`: for stocks, use the security's stored `currency` (fall back to `"USD"`) instead of the hardcoded literal, so a KRW contract is queried on its real exchange. (Options remain USD.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/ibkr/map-positions-fx.test.ts && npx vitest run tests/ibkr tests/tws`
Expected: PASS + no regressions in the ibkr/tws suites.

- [ ] **Step 5: Commit**

```bash
git add lib/ibkr/map-positions.ts lib/ibkr/refresh.ts lib/tws/positions.ts lib/tws/contracts.ts lib/tws/snapshot.ts lib/mutations/securities.ts tests/ibkr/map-positions-fx.test.ts
git commit -m "feat(ingestion): persist security currency + capture broker-derived FX rate"
```

---

### Task 7: FX-convert cost basis at unrealized-gain display sites

**Files:**
- Modify: cost-basis read sites that render unrealized gain — `lib/queries/security-detail.ts`, `lib/queries/accounts.ts` (`getCrossAccountPositions`), and the Today IBKR list query (`app/dashboard/today/*` server query). Enumerate exact sites by grepping `cost_basis` in `lib/queries/`.
- Test: `tests/queries/cost-basis-fx.test.ts`

**Interfaces:**
- Consumes: `getUsdPerUnit` (Task 2) / `fx_rates` join (Task 3 pattern).

**Context for implementer:** Unrealized gain = USD market value − USD cost basis. Market value is already converted (Tasks 4-5); cost basis is still native. For each site that subtracts `cost_basis` from a (now-USD) market value, multiply `cost_basis` by the security's rate — in SQL via the same `LEFT JOIN fx_rates fx ON fx.currency = s.currency` and `h.cost_basis * COALESCE(fx.usd_per_unit, 1)`; in JS via `getUsdPerUnit`. Grep first: `grep -rn "cost_basis" lib/queries app/dashboard` and convert every site that pairs it with market value for a gain/return figure.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/queries/cost-basis-fx.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getCrossAccountPositions } from "@/lib/queries/accounts";

// Seed the KRW 402340: cost_basis ₩16,329,792, price ₩1,731,000×10, KRW=0.000734.
// Assert the returned USD cost basis ≈ $11,986 and unrealized gain is the USD
// difference (~+$719), NOT a ₩-vs-$ mixed-unit number.
describe("cost basis FX", () => {
  it("converts cost basis to USD for unrealized gain", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: "2026-07-01", source: "test" });
    // ... seed + call getCrossAccountPositions; assert USD cost basis + gain ...
    expect(true).toBe(true); // replace with real assertions once seeded
  });
});
```

**Note to implementer:** replace the placeholder with real assertions using the seed shape from existing `tests/queries/accounts*.test.ts`. Deliverable: USD cost basis ≈ $11,986 and gain ≈ +$719 for the KRW row; a USD row unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queries/cost-basis-fx.test.ts`
Expected: FAIL — cost basis returned as ₩16.33M.

- [ ] **Step 3: Implement** — apply the fx join/multiply at each `cost_basis` gain site found by the grep.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/queries/cost-basis-fx.test.ts tests/queries/accounts.test.ts`
Expected: PASS + no regressions.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(valuation): FX-convert cost basis at unrealized-gain sites"
```

---

### Task 8: Full-suite verification + live sanity check

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all green (≥2828; new tests added). If any pre-existing test broke, fix at the source before proceeding.

- [ ] **Step 2: Build check**

Run: `npx next build`
Expected: clean compile (catches type errors the tests miss).

- [ ] **Step 3: Live sanity check (deployed app or dev server)**

Load `/dashboard/today` and `/dashboard/analysis?scope=all` after a TWS/IBKR sync. Confirm: 402340.KS shows ≈ $12.7K (not $17.3M); Analysis allocation total ≈ real portfolio (~$2.1M, not $19.3M); `MU` no longer shows $1,044.79 if it shares the same currency-ingestion class; USD holdings unchanged. Verify `fx_rates` has a `KRW` row: `sqlite3 data/vanguard.db "SELECT * FROM fx_rates;"`.

- [ ] **Step 4: Update the deep-QA finding**

Mark the KRW finding fixed in `qa/findings/ledger.json` / `FINDINGS.md` on the next sweep, or note the fix commit range in the ledger entry.

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(fx): full-suite green + build after foreign-currency valuation"
```

---

## Self-review notes

- **Spec coverage:** §Data model → Task 1; §Ingestion → Task 6; §Valuation chokepoint → Tasks 3-5; §Cost basis → Task 7; §Testing → per-task + Task 8; §Validation gate → Task 6 first step. All covered.
- **Out-of-scope honored:** no cash-ledger ingestion, no loan line, no display changes, no tax-lot historical FX — none appear as tasks.
- **Type consistency:** `getUsdPerUnit`, `upsertFxRate`/`FxRateInput`, `deriveUsdPerUnit`, `marketValue(...usdPerUnit)`, `adjustedMarketValueSQL(...fxExpr)` used consistently across tasks.
- **Known soft spots (deliberate):** Tasks 4/5/7 tests carry a placeholder assertion the implementer must replace with a real one seeded from the nearest sibling test — flagged explicitly in each because the exact seed-insert shape must match that file's existing helpers rather than be guessed here.
