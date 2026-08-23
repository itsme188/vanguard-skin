# Number-Trust Durable Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cost-basis/realized path store true economic dollars (fixing bond ÷100, short-column swap, fee omission, option-premium double-count), replace the circular TWR reconciliation with an independent Modified Dietz lane, and repair Data Confidence's universe queries while adding an integrity gate.

**Architecture:** Three independent tracks. Track A rewrites the dollar conventions inside `computeTaxLots` and gates every convention-crossing reader behind generation-bound markers, with a broker-reconciliation acceptance script. Track B adds `lib/compute/dietz.ts` and rewrites `twr-reconcile.ts` to compare statement TWR against it with banded verdicts. Track C adopts `latestHoldingsPredicate` throughout `data-confidence.ts` and adds `integrity-checks.ts` as a hard cap.

**Tech Stack:** TypeScript 5, better-sqlite3 (in-memory for tests), Vitest, Next.js 16 App Router.

**Spec:** `docs/superpowers/specs/2026-08-23-number-trust-durable-fixes-design.md` — read it first; every task below implements a named spec requirement.

## Global Constraints

- Run all tests/scripts with the node@24 pin: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run <path>` / `npx tsx scripts/<name>.ts`.
- Every DB function takes `db: Database.Database` (DI). Tests use `:memory:` SQLite.
- Dollar/percent/share UI values render through `lib/privacy/components.tsx` (`<Money>`/`<Pct>`/`<Shares>`/`<Count>`); AI/derived prose through `<PrivateText>`.
- Native-currency storage; FX at read time via `COALESCE(fx.usd_per_unit, 1)`. Never convert % returns.
- All dates `YYYY-MM-DD`; user-facing "today" via `todayET()` (`lib/calendar/date-utils.ts:19`), never `new Date().toISOString()`.
- Compare security types case-insensitively. Never inline a live-source filter — use `excludeLiveSnapshotsSql()` (`lib/db/live-sources.ts`).
- Real figures never enter committed files. Acceptance/rehearsal detail output only to `git check-ignore`-confirmed paths.
- Commit messages via temp file + `git commit -F` (never inline `-m`).
- Never undo import batches 56/58. Never edit migrations already applied.
- After each task: `npm run verify:changed`. Before merge: full `npx vitest run` + `npx next build`.

## Track/dependency map

- **Track A (Tasks 1–10):** convention core → engine → readers → export/banner → acceptance script → recompute script. Serial within track (each builds on the last), EXCEPT Task 8 (scenarios cleanup) and Task 9 (gitignore) which are independent.
- **Track B (Tasks 11–15):** Dietz module → reconcile rewrite → trust-state → UI → CLI. Serial within track. Independent of A and C.
- **Track C (Tasks 16–20):** confidence query repairs → integrity checks → cap wiring → UI + contract tests. Serial within track.
- **Cross-track dependencies (NOT fully parallel):** Task 17 imports Task 1's module (compile dependency: 1 → 17) AND both Tasks 2 and 17 modify `lib/mutations/securities.ts` — Task 17 must start only after Task 2 has merged. Tasks 14 and 19 write real-figure screenshots — Task 9 (gitignore) must merge before either runs its verification step. Task 17's lot-drift check additionally ships dark behind the Task 3 marker at runtime.
- **Task 21 (docs)** last, after all tracks merge.
- Live-DB recompute + acceptance stamping are USER-RUN post-merge (runbook at the end) — no task performs live mutations.

---

### Task 1: Tax-convention state module (generation counter + markers)

**Files:**
- Create: `lib/compute/tax-convention.ts`
- Test: `tests/compute/tax-convention.test.ts`

**Interfaces:**
- Consumes: `settings` key-value table (exists: `settings(key TEXT PRIMARY KEY, value TEXT)`).
- Produces (later tasks rely on these exact names):
  - `bumpTaxInputGeneration(db: Database.Database): number` — increments and returns the counter; MUST be called inside the caller's transaction.
  - `getTaxInputGeneration(db): number` — current counter (0 if unset).
  - `stampTaxLotsConvention(db): void` — writes `tax_lots_convention = 'v2:<generation>'`.
  - `stampBrokerAcceptance(db, coverage: AcceptanceCoverage[]): void` — writes `tax_report_broker_accepted = JSON of { generation, coverage }`.
  - `type AcceptanceCoverage = { accountId: number; taxYear: number }`.
  - `getTaxConventionState(db): TaxConventionState` where `TaxConventionState = { generation: number; recomputeCurrent: boolean; acceptance: { current: boolean; coverage: AcceptanceCoverage[] } }`.
  - `isYearAccepted(state: TaxConventionState, taxYear: number, accountIds: number[]): boolean` — true iff acceptance is current AND every requested account has that tax year in coverage.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/compute/tax-convention.test.ts
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import {
  bumpTaxInputGeneration, getTaxInputGeneration, stampTaxLotsConvention,
  stampBrokerAcceptance, getTaxConventionState, isYearAccepted,
} from "@/lib/compute/tax-convention";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
});

describe("tax input generation", () => {
  it("starts at 0 and increments monotonically", () => {
    expect(getTaxInputGeneration(db)).toBe(0);
    expect(bumpTaxInputGeneration(db)).toBe(1);
    expect(bumpTaxInputGeneration(db)).toBe(2);
    expect(getTaxInputGeneration(db)).toBe(2);
  });
});

describe("convention state", () => {
  it("is not current until stamped, current after, stale after a bump", () => {
    expect(getTaxConventionState(db).recomputeCurrent).toBe(false);
    stampTaxLotsConvention(db);
    expect(getTaxConventionState(db).recomputeCurrent).toBe(true);
    bumpTaxInputGeneration(db);
    expect(getTaxConventionState(db).recomputeCurrent).toBe(false);
  });

  it("treats an unrecognized marker value as not v2 (rollback safety)", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('tax_lots_convention', 'garbage')").run();
    expect(getTaxConventionState(db).recomputeCurrent).toBe(false);
  });

  it("acceptance is per account + tax year and generation-bound", () => {
    stampTaxLotsConvention(db);
    stampBrokerAcceptance(db, [
      { accountId: 1, taxYear: 2025 }, { accountId: 1, taxYear: 2026 },
      { accountId: 2, taxYear: 2026 },
    ]);
    const state = getTaxConventionState(db);
    expect(state.acceptance.current).toBe(true);
    expect(isYearAccepted(state, 2026, [1, 2])).toBe(true);
    expect(isYearAccepted(state, 2025, [1, 2])).toBe(false); // account 2 lacks 2025
    bumpTaxInputGeneration(db);
    const stale = getTaxConventionState(db);
    expect(stale.acceptance.current).toBe(false);
    expect(isYearAccepted(stale, 2026, [1])).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/tax-convention.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/compute/tax-convention.ts`**

```ts
import type Database from "better-sqlite3";

/**
 * Generation-bound convention markers for the tax-lots dollar convention
 * (spec: number-trust durable fixes, WS1). The generation counter advances
 * on every MATERIAL tax-input mutation; both markers bind to it so a stale
 * stamp can never survive new data. All readers go through
 * getTaxConventionState — never parse the settings rows elsewhere.
 */

export interface AcceptanceCoverage { accountId: number; taxYear: number }
export interface TaxConventionState {
  generation: number;
  recomputeCurrent: boolean;
  acceptance: { current: boolean; coverage: AcceptanceCoverage[] };
}

const GEN_KEY = "tax_input_generation";
const CONVENTION_KEY = "tax_lots_convention";
const ACCEPTANCE_KEY = "tax_report_broker_accepted";

function readSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getTaxInputGeneration(db: Database.Database): number {
  const raw = readSetting(db, GEN_KEY);
  const n = raw == null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Call inside the mutating transaction. Returns the new generation. */
export function bumpTaxInputGeneration(db: Database.Database): number {
  const next = getTaxInputGeneration(db) + 1;
  writeSetting(db, GEN_KEY, String(next));
  return next;
}

export function stampTaxLotsConvention(db: Database.Database): void {
  writeSetting(db, CONVENTION_KEY, `v2:${getTaxInputGeneration(db)}`);
}

export function stampBrokerAcceptance(
  db: Database.Database,
  coverage: AcceptanceCoverage[]
): void {
  writeSetting(
    db,
    ACCEPTANCE_KEY,
    JSON.stringify({ generation: getTaxInputGeneration(db), coverage })
  );
}

export function getTaxConventionState(db: Database.Database): TaxConventionState {
  const generation = getTaxInputGeneration(db);
  const conv = readSetting(db, CONVENTION_KEY);
  const m = conv == null ? null : /^v2:(\d+)$/.exec(conv);
  const recomputeCurrent = m != null && Number.parseInt(m[1], 10) === generation;

  let acceptance: TaxConventionState["acceptance"] = { current: false, coverage: [] };
  const rawAcc = readSetting(db, ACCEPTANCE_KEY);
  if (rawAcc != null) {
    try {
      const parsed = JSON.parse(rawAcc) as { generation?: number; coverage?: AcceptanceCoverage[] };
      const coverage = Array.isArray(parsed.coverage) ? parsed.coverage : [];
      acceptance = { current: parsed.generation === generation && recomputeCurrent, coverage };
    } catch {
      // unparseable stamp = no acceptance (fail closed)
    }
  }
  return { generation, recomputeCurrent, acceptance };
}

export function isYearAccepted(
  state: TaxConventionState,
  taxYear: number,
  accountIds: number[]
): boolean {
  if (!state.acceptance.current) return false;
  return accountIds.every((accountId) =>
    state.acceptance.coverage.some((c) => c.accountId === accountId && c.taxYear === taxYear)
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/tax-convention.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(tax): generation-bound convention markers (tax-convention.ts)` (via `git commit -F <tmpfile>`).

---

### Task 2: Generation bumps at every material mutation site

**Files:**
- Modify: `lib/import/engine.ts` (batch completion, ~line 799 — inside the commit transaction, only when business rows changed)
- Modify: `lib/mutations/import-batches.ts` (undo path, near line 111)
- Modify: `lib/mutations/donation-links.ts` (link ~181, unlink ~206)
- Modify: `lib/mutations/donations.ts` (confirm promotion ~103)
- Modify: `lib/mutations/securities.ts` (only where an EXISTING security's `multiplier` or `security_type` actually changes)
- Test: `tests/import/tax-generation-bumps.test.ts`

**Interfaces:**
- Consumes: `bumpTaxInputGeneration(db)` from Task 1.
- Produces: the invariant later tasks assume — any mutation that can change tax outputs advances the generation; a NO-OP re-import does not.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/import/tax-generation-bumps.test.ts — representative cases; use the
// existing import-engine test helpers (see tests/import/engine.test.ts for
// the fixture setup pattern: createTestDb() + commitImport of a small parsed payload).
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";

it("import commit that inserts transactions bumps the generation", () => {
  const before = getTaxInputGeneration(db);
  commitSmallFixtureImport(db); // helper: 2 BUY rows
  expect(getTaxInputGeneration(db)).toBe(before + 1);
});

it("re-importing the identical file is a no-op and does NOT bump", () => {
  commitSmallFixtureImport(db);
  const before = getTaxInputGeneration(db);
  commitSmallFixtureImport(db); // all rows dedupe on source_key
  expect(getTaxInputGeneration(db)).toBe(before);
});

it("import undo bumps", () => { /* undo the batch, assert +1 */ });
it("donation link + unlink each bump", () => { /* assert +1 per mutation */ });
it("changing multiplier on an existing security bumps; a no-change upsert does not", () => {});
```

- [ ] **Step 2: Run tests — expect FAIL** (`generation stays 0`).

- [ ] **Step 3: Implement the bumps**

In `lib/import/engine.ts`, at batch completion inside the commit transaction, count business-row changes the commit made (transactions inserted/deleted + corporate_actions inserted — the commit path already tracks inserted counts for its result object). Add:

```ts
import { bumpTaxInputGeneration } from "@/lib/compute/tax-convention";
// ... at completion, inside the same transaction:
if (insertedTransactionCount > 0 || insertedCorporateActionCount > 0) {
  bumpTaxInputGeneration(db);
}
```

In `lib/mutations/import-batches.ts` undo (rows are deleted): call `bumpTaxInputGeneration(db)` inside the undo transaction whenever it deleted at least one transaction/corporate-action row **or any donation-link/donation-lot row** (donation-only batches are material too). The COMPLETE bump-site enumeration (Codex plan review #1 — grep-verify each before implementing, and add a test per site):

| Site | File | Trigger |
|---|---|---|
| Import commit | `lib/import/engine.ts` (~799) | inserted transactions or corporate actions > 0 |
| Import undo | `lib/mutations/import-batches.ts` (~111) | deleted any transaction/CA/donation-link row |
| Donation link demote/restore | `lib/mutations/donation-links.ts` (~181/~206) | always |
| Donation lot assignment | `lib/mutations/donation-links.ts` (`assignDonationLots`, ~342) | always (changes lot consumption) |
| Donation confirm | `lib/mutations/donations.ts` (~103) | always |
| Donation reversal | `lib/mutations/donations.ts` (~90, `reversed_date` set/cleared) | always |
| Security identity change | `lib/mutations/securities.ts` | existing row's `multiplier` or `security_type` actually changes AND `EXISTS (SELECT 1 FROM tax_lots WHERE security_id = ?)` |
| Repair applies | `scripts/repair-security-type-corruption.ts` apply path (and any future `scripts/repair-*` that writes transactions/securities/donation tables) | inside the apply transaction |

Each site calls the settings-table-guarded `bumpTaxGenerationIfPresent(db)` wrapper (exported from `tax-convention.ts`).

Guard for minimal test DBs: `bumpTaxInputGeneration` requires a `settings` table; every mutation-site call goes through a tiny local wrapper that checks `sqlite_master` for `settings` first (same guard pattern as `fetchNetFlowsByDate`, `flow-adjusted.ts:70`) — name it `bumpTaxGenerationIfPresent(db)` and put it IN `tax-convention.ts` as an export so all five sites share it.

- [ ] **Step 4: Run the new tests + `npm run verify:changed`** — expect PASS, no regressions in import/mutation suites.

- [ ] **Step 5: Commit** — `feat(tax): advance tax input generation on material mutations`.

---

### Task 3: Engine rewrite — true-dollar lots and sales, fees, shorts, anniversary, rollover flag

This is the core task. Read spec §Workstream 1 fully first, then `lib/compute/tax-lots.ts` end to end (710 lines).

**Files:**
- Create: `lib/db/migrations/0XX_tax_lot_sales_premium_rollover.sql` (next free number)
- Modify: `lib/compute/tax-lots.ts`
- Test: `tests/compute/tax-lots-dollar-convention.test.ts` (new), plus update existing expectations in `tests/compute/tax-lots*.test.ts` that assert the old per-unit convention

**Interfaces:**
- Consumes: `marketValue(quantity, price, securityType, multiplier)` from `lib/valuation.ts:14`; `stampTaxLotsConvention(db)` from Task 1.
- Produces: stored columns in TRUE ECONOMIC DOLLARS (native currency): `tax_lots.cost_basis`, `tax_lot_sales.proceeds`, `tax_lot_sales.cost_basis_allocated`. New column `tax_lot_sales.premium_rollover INTEGER NOT NULL DEFAULT 0` (1 = exercised/assigned option close whose premium moved to the underlying — not filing-eligible). `isLongTermHolding` becomes calendar-anniversary. `computeTaxLots` stamps the convention marker as its final act.

- [ ] **Step 1: Migration**

```sql
-- 0XX_tax_lot_sales_premium_rollover.sql
-- Flags exercised/assigned option closes whose premium rolled into the
-- linked underlying leg (IRS Pub 550: exercised premium adjusts the
-- underlying; it is not a separate disposition). Filing surfaces exclude
-- these rows; the engine regenerates them on every recompute.
ALTER TABLE tax_lot_sales ADD COLUMN premium_rollover INTEGER NOT NULL DEFAULT 0;
```

Run `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx lib/db/migrate.ts` against a scratch copy only if needed for manual poking; tests apply migrations to `:memory:` via the standard test helper.

- [ ] **Step 2: Write the failing convention tests**

`tests/compute/tax-lots-dollar-convention.test.ts` — use the existing tax-lots test scaffold (see `tests/compute/tax-lots.test.ts` for `createDb()` + seed helpers). Synthetic fixtures, one test per convention cell. Exact expectations:

```ts
describe("bond dollar convention", () => {
  // Bond: qty 20000 face, price 99.438385 per-100-face → economic $19,887.68
  it("stores bond lot cost_basis at economic dollars (÷100)", () => {
    seedBond(db, { qty: 20000, price: 99.438385 });          // BUY
    computeTaxLots(db);
    const lot = getOnlyLot(db);
    expect(lot.cost_basis).toBeCloseTo(19887.68, 2);          // NOT 1,988,768
    expect(lot.acquisition_price).toBeCloseTo(99.438385, 6);  // per-unit price unchanged
  });

  it("bill redemption at cost realizes $0 with proceeds == |amount|", () => {
    seedBond(db, { qty: 20000, price: 99.438385 });
    addTxn(db, { type: "REDEMPTION", qty: 20000, price: null, amount: 19887.69 });
    computeTaxLots(db);
    const sale = getOnlySale(db);
    expect(sale.proceeds).toBeCloseTo(19887.69, 2);
    expect(sale.cost_basis_allocated).toBeCloseTo(19887.68, 2);
    expect(sale.realized_gain_loss).toBeCloseTo(0.01, 2);
  });
});

describe("short-cover IRS orientation", () => {
  // SELL_TO_OPEN 100 sh @ $50 fees $1 → net open proceeds $4,999 (stored in cost_basis)
  // BUY_TO_COVER 100 sh @ $40 fees $1 → basis $4,001; gain = 4999 - 4001 = $998
  it("proceeds = net short-open leg, basis = cover cost + fees, gain falls out unsigned", () => {
    seedStock(db);
    addTxn(db, { type: "SELL_TO_OPEN", qty: 100, price: 50, fees: 1 });
    addTxn(db, { type: "BUY_TO_COVER", qty: 100, price: 40, fees: 1, daysLater: 30 });
    computeTaxLots(db);
    const sale = getOnlySale(db);
    expect(sale.proceeds).toBeCloseTo(4999, 2);
    expect(sale.cost_basis_allocated).toBeCloseTo(4001, 2);
    expect(sale.realized_gain_loss).toBeCloseTo(998, 2);
    expect(sale.is_long_term).toBe(0);
  });

  it("short cover held >1yr is STILL short-term (§1233 blanket rule)", () => {
    // same trade, daysLater: 500 → is_long_term stays 0, holding_period_days records 500
  });
});

describe("fees on long lots", () => {
  it("buy fees enter stored basis; sell fees reduce proceeds proportionally on partial sale", () => {
    // BUY 100 @ $10 fees $2 → cost_basis $1,002
    // SELL 40 @ $12 fees $1 → proceeds = 480 - 1×(40/40)= $479; basis = 1002×0.4 = $400.80
    // gain = 78.20
  });
});

describe("option round-trip and exercise", () => {
  it("plain option round-trip stores contract dollars (×100) on both legs", () => {
    // BUY_TO_OPEN 1 contract @ $2.50 fees $1 → cost_basis $251
    // SELL_TO_CLOSE @ $4.00 fees $1 → proceeds $399, gain $148
  });

  it("EXERCISED option with linked stock leg is a premium rollover: zero gain, flagged, premium lands once", () => {
    // Long call 1x @ $3 premium on XYZ, EXERCISED; linked stock BUY 100 @ $100 same day.
    // Option sale row: premium_rollover=1, realized_gain_loss=0, proceeds==cost_basis_allocated==300.
    // Stock lot cost_basis = 100×100 + 3×100 = $10,300 (premium exactly once).
  });

  it("EXERCISED option with NO linkable stock leg keeps its realized loss (premium must not vanish)", () => {
    // No stock txn within ±1 day → premium_rollover=0, realized loss = -$300 - fees.
  });
});

describe("long-term anniversary boundary", () => {
  it("2024-02-28 → 2025-02-28 is NOT long-term; 2025-03-01 IS (leap year span)", () => {
    expect(isLongTermHolding("2024-02-28", "2025-02-28")).toBe(false); // exactly 1yr = not MORE than
    expect(isLongTermHolding("2024-02-28", "2025-03-01")).toBe(true);
    expect(isLongTermHolding("2024-02-29", "2025-03-01")).toBe(true);  // Feb 29 anniversary = Mar 1 rule: >
  });
});

describe("recompute idempotence and marker", () => {
  it("second run is semantically identical over business columns and stamps the marker", () => {
    // run twice; SELECT the business columns (account_id, security_id, dates, prices,
    // quantities, dollar fields, flags) ORDER BY stable keys; deep-equal the two snapshots.
    // Then expect getTaxConventionState(db).recomputeCurrent === true.
  });
});
```

- [ ] **Step 3: Run — expect FAIL** on every new test (old convention numbers).

- [ ] **Step 4: Implement the engine changes in `lib/compute/tax-lots.ts`**

4a. `isLongTermHolding` (lines 98-106) — calendar anniversary:

```ts
/**
 * IRS long-term test, single-sourced: held MORE than one year — strictly
 * after the calendar anniversary of acquisition (Pub 550), not a fixed
 * 365-day count (which misclassifies anniversary sales across Feb 29).
 */
export function isLongTermHolding(acquisitionDate: string, dispositionDate: string): boolean {
  const [y, m, d] = acquisitionDate.split("-").map(Number);
  const anniversary = `${String(y + 1).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return dispositionDate > anniversary; // ISO strings compare lexicographically
}
```

(A Feb-29 acquisition yields anniversary `YYYY-02-29`, which doesn't exist in the non-leap following year; lexicographic `>` against `YYYY-03-01` behaves as "more than one year" correctly — pin with the test above.)

4b. `buys` query (lines 127-136) — join securities:

```sql
SELECT t.id, t.account_id, t.security_id, t.trade_date, t.type, t.quantity,
       t.price_per_share, t.amount, t.fees,
       LOWER(COALESCE(s.security_type, '')) AS security_type,
       COALESCE(s.multiplier, 1) AS multiplier
FROM transactions t
JOIN securities s ON s.id = t.security_id
WHERE LOWER(t.type) IN ('buy', 'reinvestment', 'buy_to_open', 'sell_to_open', 'transfer_in')
  AND t.security_id IS NOT NULL
  AND t.price_per_share IS NOT NULL AND t.quantity IS NOT NULL
ORDER BY t.trade_date, t.id
```

Extend `TransactionRow` with `security_type: string; multiplier: number` (make the two fields required on the buys/sells row types).

4c. Lot write (lines 145-168) — economic dollars + fees. `import { marketValue } from "@/lib/valuation";` at top. Replace `const costBasis = buy.quantity * effectivePrice;` with:

```ts
const isShort = buy.type.toLowerCase() === "sell_to_open" ? 1 : 0;
const gross = marketValue(buy.quantity, effectivePrice, buy.security_type, buy.multiplier);
const fees = buy.fees ?? 0;
// Long-side fees ADD to basis; a short open's stored leg is its NET
// proceeds (gross received minus fees) — see spec fee matrix.
const costBasis = isShort ? gross - fees : gross + fees;
```

4d. `OpenLot` (lines 24-30) — add `quantity_acquired: number; cost_basis: number;` and extend the openLots SELECT (line 312) to include both columns.

4e. Sale allocation (lines 319-353) — replace the two formula lines and the negation with:

```ts
const quantitySold = Math.min(remainingToSell, lot.quantity_remaining);
const lotFraction = lot.quantity_acquired !== 0 ? quantitySold / lot.quantity_acquired : 0;
const sellFees = sell.fees ?? 0;
const allocatedSellFees = sell.quantity > 0 ? sellFees * (quantitySold / sell.quantity) : 0;
const grossSaleDollars = marketValue(
  quantitySold, effectiveSalePrice, sell.security_type, sell.multiplier
);

let proceeds: number;
let costBasisAllocated: number;
if (lot.is_short) {
  // IRS orientation for a short lifecycle: proceeds = the net short-open
  // leg (stored dollar-proportionally in lot.cost_basis); basis = what the
  // cover paid including its fees. Gain falls out unsigned — no negation.
  proceeds = lot.cost_basis * lotFraction;
  costBasisAllocated = grossSaleDollars + allocatedSellFees;
} else {
  proceeds = grossSaleDollars - allocatedSellFees;
  costBasisAllocated = lot.cost_basis * lotFraction;
}
const realizedGainLoss = proceeds - costBasisAllocated;
// Signed display convention preserved (spec WS1 / conventions-detail:
// negative holding days identify shorts on existing surfaces).
const spanDays = daysBetween(lot.acquisition_date, sell.trade_date);
const holdingDays = lot.is_short ? -spanDays : spanDays;
const isLongTerm =
  lot.is_short ? 0 : (isLongTermHolding(lot.acquisition_date, sell.trade_date) ? 1 : 0);
```

DELETE the old `if (lot.is_short) realizedGainLoss = -realizedGainLoss;` line. The sells query (line 240) additionally selects `LOWER(COALESCE(s.security_type,'')) AS security_type` (multiplier is already there). Correspondingly, the Task-3 short tests expect `holding_period_days` of **−30 / −500**, and Task 6's short-row test expects `holdingPeriodDays: -41`.

4e-bis. **Authoritative-`amount` precedence + reversal fees (fee matrix, Codex plan review #2).** Add ONE derivation helper in `tax-lots.ts` and route BOTH the lot write (4c) and the sale gross (4e) through it:

```ts
/**
 * Net economic dollars of one transaction leg. Statement `amount` is the
 * broker's own net figure (fees included) and takes precedence when
 * present; the qty×price±fees derivation is the fallback for rows without
 * an amount. Reversal rows carry negative quantities/amounts — the sign
 * of `amount` (or of fees on the fallback path) rides along untouched,
 * never Math.abs'd here (REDEMPTION's |amount| price derivation upstream
 * is the one deliberate exception and is unchanged).
 */
function netLegDollars(
  row: { quantity: number; amount: number | null; fees: number | null;
         security_type: string; multiplier: number },
  perUnitPrice: number,
  side: "acquire" | "dispose" | "short_open" | "cover"
): number {
  if (row.amount != null && row.amount !== 0) return Math.abs(row.amount);
  const gross = marketValue(row.quantity, perUnitPrice, row.security_type, row.multiplier);
  const fees = row.fees ?? 0;
  switch (side) {
    case "acquire": return gross + fees;   // buy fees enter basis
    case "cover":   return gross + fees;   // cover cost includes fees
    case "dispose": return gross - fees;   // sale proceeds net of fees
    case "short_open": return gross - fees; // net short-open proceeds
  }
}
```

4c's `costBasis` becomes `netLegDollars(buy, effectivePrice, isShort ? "short_open" : "acquire")` — EXCEPT premium-adjusted buys (exercise links), where the adjustment must survive: when `adj` was applied, use the fallback formula with the ADJUSTED price (the statement `amount` predates the premium roll-in). 4e's `grossSaleDollars ± allocatedSellFees` collapses to `netLegDollars(sell, effectiveSalePrice, lot.is_short ? "cover" : "dispose") × (quantitySold / sell.quantity)` — amount-derived legs allocate proportionally the same way. Tests: one amount-present and one amount-null case per matrix row, plus a reversal row (negative amount) asserting sign passthrough, plus a premium-adjusted buy asserting the adjusted fallback.

4f. Premium rollover. `computePremiumAdjustments` (line 621) must also report WHICH exercise transactions linked. Change its return type to `{ adjustments: Map<number, PremiumAdjustment>; linkedExerciseTxnIds: Set<number> }` — add `linkedExerciseTxnIds.add(ex.id)` right where `adjustments.set(stockTx.id, …)` happens, and update the caller (line 119). Then in `processSell`, after computing the row values, override for linked exercise/assignment option closes:

```ts
const isPremiumRollover =
  (lowerType === "exercised" || lowerType === "assigned") &&
  linkedExerciseTxnIds.has(sell.id) ? 1 : 0;
if (isPremiumRollover) {
  // Premium flows through the underlying leg exactly once (Pub 550);
  // this close is a rollover, not a disposition — zero gain by definition.
  proceeds = costBasisAllocated;
}
```

`insertSale` (line 259) gains the `premium_rollover` column (value `isPremiumRollover`); when `isPremiumRollover`, `realizedGainLoss` recomputes to 0 after the override — keep the arithmetic (`proceeds - costBasisAllocated`) so it's zero by construction, and exclude it from `totalRealizedGain` accumulation? NO — include (it IS zero). Unlinked exercises keep their loss (test above).

4g. `RECONCILE_CLOSE` synthetic amount (lines 588 & 600): replace `orphan.open_qty * salePrice * orphan.multiplier` with `marketValue(orphan.open_qty, salePrice, "stock", orphan.multiplier)` — scope is stock/ETF so value is unchanged; consistency only. Note `open_cost` (line 510) is now a dollar figure (`SUM(quantity_remaining × acquisition_price)` must become `SUM(cost_basis × quantity_remaining / quantity_acquired)` so the breakeven fallback stays per-unit correct: `salePrice = open_cost_dollars / open_qty` for stocks, unchanged formula shape).

4h. Final act of `computeTaxLots`, inside the transaction, after the orphan sweep: `stampTaxLotsConvention(db);` (guarded by the same settings-table-exists check exported from Task 1 — minimal test DBs without `settings` skip stamping).

- [ ] **Step 5: Update existing tests that encoded the old convention**

Run `PATH=... npx vitest run tests/compute/` — every failure in `tax-lots*.test.ts` families is a convention expectation: bond/option basis and proceeds values change by ×100/÷100, short columns swap, exercised-option rows now zero-gain. Update each expectation to the ECONOMIC dollar value (compute by hand; never just paste the new actual). `tests/compute/tax-lots-options.test.ts:150` (the double-count expectation) now asserts the rollover behavior.

- [ ] **Step 6: Full compute suite + verify:changed** — expect PASS.

- [ ] **Step 7: Commit** — `feat(tax)!: true-dollar lot/sale convention (bond ÷100, short orientation, fees, premium rollover, anniversary LT)`.

---

### Task 4: Reader simplification — cost-basis reconciliation + portfolio-summary + giving verify

**Files:**
- Modify: `lib/compute/cost-basis-reconciliation.ts:119-131`
- Modify: `lib/queries/portfolio-summary.ts:287-297`
- Modify: `lib/queries/giving-view.ts` (verify only — add a regression test)
- Test: extend `tests/compute/cost-basis-reconciliation.test.ts`, `tests/queries/portfolio-summary.test.ts`, `tests/queries/giving-view.test.ts`

**Interfaces:**
- Consumes: v2 `tax_lots.cost_basis` (dollars) from Task 3; `getTaxConventionState` from Task 1.
- Produces: both readers return an extra field `conventionPending: boolean` (true when `!getTaxConventionState(db).recomputeCurrent`) — UI tasks read this exact name.

- [ ] **Step 1: Failing tests** — seed an option (multiplier 100) and a bond position through `computeTaxLots`; assert the reconciliation's computed basis now equals the broker-dollar convention (an option bought 1×$2.50 reconciles as ~$250, a 20k-face bond at ~99.4 as ~$19,888) and `flagged` is false when broker basis matches; assert `conventionPending === true` when the marker is stale (bump the generation after recompute in the test).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

`cost-basis-reconciliation.ts` — replace the hand-rolled SUM with the stored dollar column:

```sql
SUM(tl.cost_basis * tl.quantity_remaining / tl.quantity_acquired)
  * COALESCE(fx.usd_per_unit, 1) AS total_cost_basis
```

(guard `quantity_acquired != 0` in the WHERE — a zero-acquired lot cannot exist but the division must not NaN). `portfolio-summary.ts:287-297` — same expression replaces `quantity_remaining * acquisition_price`.

**Pending-state contract (Codex plan review #4/#5) — per reader, matched to its ACTUAL return type:**
- `cost-basis-reconciliation.ts` returns an object → add `conventionPending: boolean`.
- `portfolio-summary.ts`: `getPortfolioSummaryForChat` (line 59) returns a **plain string** — do NOT change its type; when pending, append one inline line to the text: `"Note: cost-basis figures are pending a recompute under the corrected dollar convention and may be unit-inconsistent."` Any structured sibling function that returns the tax block as an object gets the boolean field.
- `giving-view.ts`: the view-model object gets `conventionPending: boolean`; the Giving page renders a small pending note when true.
- Task 5's readers: `trade-roundtrips.ts` result object and the closed-options P&L query result get the same `conventionPending` field (computed once via `getTaxConventionState`); their surfaces (trade-review UI, options P&L panel) render the pending note — implemented in Task 5, E2E-verified in Task 20 against the ACTUAL five surfaces (tax card, cost-basis recon, portfolio tax block, giving view, trade-review/options P&L).

`giving-view.ts` formula: no change (per-share math inherits dollars) — add the regression test proving a donated OPTION lot's `basis`/`gainAvoided` now come out in economic dollars.

- [ ] **Step 4: Run tests + verify:changed — PASS.**

- [ ] **Step 5: Commit** — `fix(basis): readers consume stored dollar basis; convention-pending flags`.

---

### Task 5: Trade-roundtrips + options closed-P&L reader audit

**Files:**
- Modify: `lib/compute/trade-roundtrips.ts` (lines 115-121, 170-179, and the comment at 415-417)
- Modify: `lib/queries/options.ts` (lines 290-337)
- Modify: `lib/queries/tax-lots.ts` (`getClosedTaxLotSales`, lines 97-123 — add the filing filter)
- Test: extend `tests/compute/trade-roundtrips.test.ts`, `tests/queries/options.test.ts`

**Interfaces:**
- Consumes: v2 sale rows (Task 3), `premium_rollover` column.
- Produces: `getClosedTaxLotSales(db, year, opts?: { filingOnly?: boolean })` — with `filingOnly: true` it excludes rows where `premium_rollover = 1` OR the sale transaction's `type = 'RECONCILE_CLOSE'`. Task 6 consumes this exact signature.

- [ ] **Step 1: Grep audit (record findings in the task summary).** `rg -n "cost_basis_allocated|\.proceeds|scaledCostBasisFallbackSQL" lib/ app/ --type ts` — for every hit, decide: reads stored dollars (now correct — no change), or re-applies multiplier/÷100 on top (remove the compensation). Known compensation sites from the spec map: `trade-roundtrips.ts:415-417` comment block (entryCost carries multiplier — recheck the math around it), `lib/queries/options.ts:290-337`. Check every `scaledCostBasisFallbackSQL` call site (`lib/valuation.ts:93-110` defines it) — it scales HOLDINGS cost basis, not tax_lots, and stays.

- [ ] **Step 2: Failing tests** — an option round-trip renders its P&L in dollars exactly once (assert the roundtrip `entryCost`/`exitProceeds` equal $251/$399 from the Task 3 fixture); closed-options P&L query returns dollar figures; `getClosedTaxLotSales(db, year, { filingOnly: true })` excludes a seeded RECONCILE_CLOSE sale and a premium-rollover sale while the default includes them.

- [ ] **Step 3: Implement.** In `getClosedTaxLotSales`, the query already joins `transactions t ON t.id = tls.sale_transaction_id` (verify; add the join if it derives sale info elsewhere) — add:

```sql
${opts?.filingOnly ? "AND tls.premium_rollover = 0 AND t.type != 'RECONCILE_CLOSE'" : ""}
```

Remove any double-compensation found in Step 1; where a reader was CORRECT only because of compensation, the compensation removal + v2 rows cancel — the test from Step 2 is the proof. Add `conventionPending` to the trade-roundtrips result object and the closed-options P&L result (see Task 4's pending-state contract) and render the pending note on their surfaces.

- [ ] **Step 4: Run + verify:changed — PASS.**
- [ ] **Step 5: Commit** — `fix(readers): consume v2 dollar sale rows; filingOnly filter on getClosedTaxLotSales`.

---

### Task 6: Tax report — short dates, filing filter, marker-gated banner, wash-sale advisory

**Files:**
- Modify: `lib/compute/tax-report.ts`
- Modify: `app/api/tax-report/route.ts`
- Modify: `app/dashboard/components/TaxReportCard.tsx` (the containment banner component — find via `rg -n "NOT-FOR-FILING" app/ lib/`)
- Test: `tests/compute/tax-report-v2.test.ts` (new golden-file style), extend the route's existing test if present

**Interfaces:**
- Consumes: `getClosedTaxLotSales(db, year, { filingOnly: true })` (Task 5); `getTaxConventionState` + `isYearAccepted` (Task 1); `is_short` via the sale row (extend `TaxLotSaleWithDetails` with `is_short` if absent — add `tl.is_short` to the query's SELECT).
- Produces: `generateTaxReport(db, year)` result gains `{ filingReady: boolean; washSaleAdvisory: string }`. Route emits `-NOT-FOR-FILING` filenames iff `!filingReady`.

- [ ] **Step 1: Failing tests**

```ts
it("short rows report the cover date as BOTH 8949 dates", () => {
  // short fixture from Task 3: open 2025-01-10, cover 2025-02-20
  const report = generateTaxReport(db, 2025);
  const row = report.shortTermRows.find(r => r.symbol === "SHRT");
  expect(row.dateAcquired).toBe("02/20/2025");
  expect(row.dateSold).toBe("02/20/2025");
  expect(row.holdingPeriodDays).toBe(41); // analytics span survives
});

it("uses filingOnly rows: RECONCILE_CLOSE and premium rollovers absent", () => {});

it("filingReady is false without acceptance coverage for the year, true with it", () => {
  expect(generateTaxReport(db, 2025).filingReady).toBe(false);
  stampBrokerAcceptance(db, [{ accountId: 1, taxYear: 2025 }]);
  expect(generateTaxReport(db, 2025).filingReady).toBe(true); // account 1 is the only account in this fixture
});

it("CSV footer carries the wash-sale advisory line; totals unchanged otherwise", () => {
  const csv = generateForm8949CSV(report);
  expect(csv).toContain("Note: W adjustment codes are heuristic estimates");
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

In `generateTaxReport` (line 136): switch the fetch to `getClosedTaxLotSales(db, year, { filingOnly: true })`. Build the row (line 156): for `sale.is_short === 1`, `dateAcquired = toMMDDYYYY(sale.sale_date)` and `dateSold = toMMDDYYYY(sale.sale_date)` (cover trade date both — spec WS1). Compute `filingReady` **fail-closed against the explicit account universe** (Codex plan review #12 — an empty sale set must never be vacuously ready):

```ts
const state = getTaxConventionState(db);
// Universe = every account with ANY tax_lot_sales row in the year (filing-
// eligible or not) — derived from the DB, not from the filtered rows.
const accountIds = (db.prepare(
  `SELECT DISTINCT tl.account_id FROM tax_lot_sales tls
     JOIN tax_lots tl ON tl.id = tls.tax_lot_id
    WHERE tls.sale_date >= ? AND tls.sale_date <= ?`
).all(`${year}-01-01`, `${year}-12-31`) as { account_id: number }[]).map(r => r.account_id);
const filingReady =
  accountIds.length > 0 &&
  state.recomputeCurrent &&
  isYearAccepted(state, year, accountIds);
```

`washSaleAdvisory` constant string: `"W adjustment codes are heuristic estimates (30-day same-security scan) pending 1099-B reconciliation — verify before filing."` Append it as a final CSV line (`"Note: …"`) in `generateForm8949CSV`; a trailing comment is NOT valid TXF — leave the TXF body untouched; the advisory travels in the UI + CSV only.

**One filename builder** (Codex #12): export `buildTaxReportFilename(kind: "csv" | "txf", year: number, filingReady: boolean): string` from `tax-report.ts`; the route AND `TaxReportCard.tsx` (which currently hardcodes the `-NOT-FOR-FILING` name at ~line 101) both call it — grep the card for the literal and replace. Route (`app/api/tax-report/route.ts:20-33`): response envelope gains `filingReady`; `Content-Disposition` uses the builder. `TaxReportCard.tsx`: the big containment banner renders iff `!filingReady`; the wash-sale advisory line renders always (static copy, plain text); any dollar totals it shows must already be `<Money>` — verify.

- [ ] **Step 4: Run + verify:changed — PASS.**
- [ ] **Step 5: Commit** — `feat(tax): marker-gated filing readiness, short-cover 8949 dates, wash-sale advisory`.

---

### Task 7: Broker-reconciliation acceptance script

**Files:**
- Create: `scripts/reconcile-tax-report-vs-broker.ts`
- Create: `data/repair-configs/broker-realized-SAMPLE.json` — NO: config is gitignored; instead create `tests/fixtures/broker-realized-sample.json` (synthetic) and document the real config's location in the script header.
- Test: `tests/scripts/reconcile-tax-report-vs-broker.test.ts` (import the script's exported `runReconciliation(db, config)` core; the CLI shell is thin)

**Interfaces:**
- Consumes: `tax_lot_sales` v2 rows; `stampBrokerAcceptance` (Task 1).
- Produces: exported `runReconciliation(db: Database.Database, config: BrokerRealizedConfig): ReconcileResult` where:

```ts
interface BrokerRealizedConfig {
  entries: Array<{
    accountId: number; taxYear: number;
    source: string;                        // e.g. "vanguard-statement-2026-04" — provenance label
    statementTotal: { proceeds: number; basis: number; gain: number }; // printed section totals
    rows: Array<{ symbol: string; disposalDate: string; quantity: number;
                  currency: string; proceeds: number; basis: number; gain: number }>;
  }>;
}
interface ReconcileResult {
  pass: boolean;
  coverage: AcceptanceCoverage[];          // entries that fully reconciled
  summary: string;                          // direction-only (counts + PASS/FAIL per entry)
  detailLines: string[];                    // real figures — caller controls destination
}
```

- [ ] **Step 1: Failing tests** (synthetic config against a fixture DB): (a) transcription tie-out — rows not summing to `statementTotal` within $0.02 fails BEFORE any engine comparison; (b) full match passes with per-field tolerance `ACCEPT_TOL_USD = 0.01`; (c) an unmatched broker row fails; (d) an extra engine disposal in the covered (account, year) fails; (e) one broker disposal matching two FIFO sale rows sums them (sorted by lot acquisition_date, id) and passes; (f) empty `rows` fails (`zero coverage`); (g) `RECONCILE_CLOSE` and `premium_rollover` engine rows are invisible to (d).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Matching per spec: broker identity `(accountId, symbol normalized via existing symbol conventions, disposalDate, quantity to 4dp, currency)`; engine side groups `tax_lot_sales` (filing rows only) by `(account_id, security symbol, sale_date, sale_transaction_id)` and sums. **Input interface (Codex plan review #13):** the JSON config is the SINGLE validated input; the script header documents how to produce `entries` from each source — Vanguard statement realized sections are transcribed by hand (tie-out totals catch transcription error), and the IBKR annual activity CSV's realized-P&L rows are converted to the same row shape (symbol, disposal date, quantity, proceeds, basis, gain) by the user or a throwaway jq/spreadsheet pass; no CSV parsing lives in the acceptance script itself. CLI shell:

```
PATH=... npx tsx scripts/reconcile-tax-report-vs-broker.ts \
  [--config data/repair-configs/broker-realized-2026.json] [--stamp] [--detail-out <path>]
```

- DB: opens `REPAIR_DB_PATH` if set, else `data/vanguard.db` read-only unless `--stamp`.
- stdout: `result.summary` ONLY (direction-only).
- `--detail-out`: refuses unless `git check-ignore -q <path>` succeeds (spawn sync; on failure print the refusal and exit 1).
- `--stamp`: only when `result.pass`; calls `stampBrokerAcceptance(db, result.coverage)` in a transaction.
- Run from the repo root (tsx `@/` alias convention — script header comment).

- [ ] **Step 4: Run tests — PASS.** Also run the CLI once against the synthetic fixture with a scratch DB to prove the shell works: exit 0, direction-only stdout.
- [ ] **Step 5: Commit** — `feat(tax): broker-reconciliation acceptance harness (fail-closed, stamps coverage)`.

---

### Task 8: Scenarios inline-SQL cleanup (independent, tiny)

**Files:**
- Modify: `lib/compute/scenarios.ts:117-121`
- Test: existing `tests/compute/scenarios.test.ts` must stay green (behavioral no-op)

- [ ] **Step 1:** Replace the hand-inlined CASE expression with `adjustedMarketValueSQL("lh.total_qty", "lp.close_price", "s.security_type", "s.multiplier")` (import from `@/lib/valuation`). Compare the generated SQL string mentally — identical semantics.
- [ ] **Step 2:** `PATH=... npx vitest run tests/compute/scenarios.test.ts` — PASS unchanged.
- [ ] **Step 3: Commit** — `refactor(scenarios): use adjustedMarketValueSQL instead of inline copy`.

---

### Task 9: Gitignore the E2E evidence path (independent, tiny)

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1:** Add anchored rules under the existing privacy block (near line 102):

```
/qa/verify-evidence/
```

- [ ] **Step 2:** Verify: `git check-ignore -q qa/verify-evidence/x.png && echo ignored` prints `ignored`.
- [ ] **Step 3: Commit** — `chore(privacy): gitignore qa/verify-evidence (real-data E2E artifacts)`.

---

### Task 10: Live recompute + rehearsal script

**Files:**
- Create: `scripts/recompute-tax-lots-v2.ts`
- Test: `tests/scripts/recompute-tax-lots-v2.test.ts` (core function only)

**Interfaces:**
- Consumes: `computeTaxLots` (Task 3 — stamps the marker itself), the existing valuation recompute entry point (find via `rg -n "recomputeAllValuations|recomputeDailyValuations" lib/compute/daily-valuation.ts scripts/` and call the same function the auto-refresh Step 4 uses).
- Produces: the USER-RUN runbook step. No live mutation happens in any task.

- [ ] **Step 1: Failing test** — exported `runRecompute(db): { lots: number; sales: number; identityOk: boolean }`: on a fixture DB it recomputes lots + valuations and verifies the daily identity (`cash_balance + holdings_value = total_value` on every `daily_valuations` row — reuse the identity-check query pattern from `scripts/repair-security-type-corruption.ts`).

- [ ] **Step 2: Implement.** CLI shell mirrors the repair-script conventions exactly (this repo's pattern, proven 2026-08-23): `REPAIR_DB_PATH` env override; **no `--apply` → report-only** (Codex plan review #20): the script opens the DB read-only, prints current lot/sale counts, the marker state, and what a run WOULD do, and executes NOTHING destructive — `computeTaxLots` runs only under `--apply`, which itself is refused unless `REPAIR_DB_PATH` is set (rehearsal copy) OR `--live` is also passed (deliberate live run); WAL-safe backup FIRST on any writable run: `db.backup(path.join("data/backups", `vanguard-pre-v2-recompute-${stamp}.db`))` (better-sqlite3 backup API — never a bare file copy of a hot WAL DB); prints lots/sales counts, identity result, and the new marker value; second-run idempotence flag `--verify-idempotent` runs computeTaxLots twice and diffs business columns.

- [ ] **Step 3: Tests PASS; rehearse the CLI on a scratch fixture DB** (not the live DB).
- [ ] **Step 4: Commit** — `feat(tax): v2 recompute script (backup, identity check, idempotence verify)`.

---

### Task 11: Shared flow/snapshot primitives for Dietz

**Files:**
- Modify: `lib/compute/flow-adjusted.ts` (add `fetchInKindFlowsByDate`)
- Create: `lib/compute/monthly-snapshot-utils.ts`
- Modify: `lib/compute/twr.ts` (use the extracted helpers — behavioral no-op)
- Test: `tests/compute/monthly-snapshot-utils.test.ts`; existing `tests/compute/twr*.test.ts` stay green

**Interfaces:**
- Produces (Task 12 consumes these exact signatures):
  - `fetchInKindFlowsByDate(db, accountIds: number[] | null, startDate: string, endDate: string): { date: string; net: number }[]` in `flow-adjusted.ts` — in-kind TRANSFER legs (`IN_KIND_LEG_SQL`, `flow-adjusted.ts:46`) valued by their `amount` with `SIGNED_EXTERNAL_FLOW_SQL` signs, half-open `(startDate, endDate]`, same `sqlite_master` guard as `fetchNetFlowsByDate` (`flow-adjusted.ts:64-96` is the template — copy its shape, change the WHERE to the in-kind predicate).
  - `isAnnualSummaryRow(snap: { month_end_date: string; starting_value: number | null }, priorMonthTotal: number | null): boolean` in `monthly-snapshot-utils.ts` — extracted from the detection at `twr.ts:296-301`; the `month_end_date` input carries the December test (the function must return false for any non-December month regardless of divergence — Codex plan review #7).
  - `fetchMonthSnapshot(db, accountId: number, monthEndDate: string): MonthSnapshotRow | null` and `fetchPriorMonthTotal(db, accountId: number, monthEndDate: string): number | null` — both filtered by `excludeLiveSnapshotsSql("source")`. `fetchPriorMonthTotal` looks up the EXACT adjacent prior calendar month-end (compute the previous month's last day and match `month_end_date` equality) — never "latest earlier row", which would silently bridge a gap (test: a missing intervening month returns null).
  - `MonthSnapshotRow = { month_end_date: string; total_value: number; starting_value: number | null; twr: number | null; deposits_withdrawals: number | null; source: string }`.

- [ ] **Step 1: Failing tests** — in-kind fetch returns only TRANSFER legs with `security_id` set, signed; annual-summary detector true/false cases (mirror the twr.ts threshold exactly); month fetchers exclude a seeded `source='tws'` row.
- [ ] **Step 2: Implement; refactor `twr.ts:296-301` and its in-kind `appendInKindFlows` (lines 253-267) to call the shared helpers.** Keep `twr.ts` behavior byte-identical — the full twr test family is the regression net.
- [ ] **Step 3: Run `tests/compute/twr*` + new tests — PASS.**
- [ ] **Step 4: Commit** — `refactor(twr): extract shared snapshot/in-kind primitives for the Dietz lane`.

---

### Task 12: `lib/compute/dietz.ts` — independent Modified Dietz

**Files:**
- Create: `lib/compute/dietz.ts`
- Test: `tests/compute/dietz.test.ts`

**Interfaces:**
- Consumes: Task 11 helpers; `fetchNetFlowsByDate` + `fetchAnchorSourceSeamDates` (`flow-adjusted.ts:64,193`).
- Produces (Task 13 consumes):

```ts
export const DIETZ_CONSISTENT_BP = 125;
export const DIETZ_FLOW_TOL_USD = 1.0;
export type DietzBand = "consistent" | "investigate" | "not_comparable" | "insufficient";
export interface MonthlyDietzResult {
  monthEndDate: string;
  dietzReturn: number | null;
  vStart: number | null; vEnd: number | null;
  netFlow: number; flowCount: number;
  seamStraddled: boolean;
  rule:                       // why the band is what it is — exact strings
    | "annual-summary-row" | "missing-v-start" | "missing-statement-twr"
    | "nonpositive-denominator" | "flow-total-mismatch" | "flow-total-unavailable"
    | "seam-straddled" | "banded";
}
export function computeMonthlyDietz(
  db: Database.Database, accountId: number, monthEndDate: string
): MonthlyDietzResult;
```

- [ ] **Step 1: Failing tests** — hand-computed months (all fixture DBs with `monthly_snapshots` + `transactions` + `settings`-less guard tolerance):

```ts
it("computes day-weighted Dietz exactly", () => {
  // V_start 100,000 (prior month), V_end 103,000, one deposit 2,000 on day 10 of a 30-day month.
  // w = (30-10)/30 = 2/3. r = (103000-100000-2000)/(100000 + 2000*2/3) = 1000/101333.33 = 0.009868...
  const r = computeMonthlyDietz(db, 1, "2026-04-30");
  expect(r.dietzReturn).toBeCloseTo(0.0098684, 6);
  expect(r.rule).toBe("banded");
});
it("month-end flow gets weight 0 (end-of-day convention)", () => {});
it("in-kind TRANSFER legs count as flows (compared separately from the statement total)", () => {});
it("flow ledger vs statement deposits_withdrawals mismatch > $1 → insufficient/flow-total-mismatch", () => {});
it("null deposits_withdrawals → insufficient/flow-total-unavailable", () => {});
it("annual-summary December → not_comparable BEFORE any flow adjudication (precedence pin)", () => {
  // December row with cumulative starting_value divergence AND a null deposits_withdrawals:
  // must yield annual-summary-row, NOT flow-total-unavailable.
});
it("seam inside month → not_comparable/seam-straddled (after insufficiency checks)", () => {});
it("missing prior month → insufficient/missing-v-start", () => {});
it("nonpositive denominator → insufficient", () => {});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — equation and precedence exactly as spec WS2 (annual-summary FIRST, then insufficiency rules, then seam, then banded). Month day count from the calendar (`new Date(Date.UTC(y, m, 0)).getUTCDate()`); flow day-of-month from `date`; cash flows via `fetchNetFlowsByDate(db, [accountId], priorMonthEnd, monthEndDate, { excludeInKind: true })` and in-kind via `fetchInKindFlowsByDate` — both streams weighted identically, but ONLY the cash stream is compared to `deposits_withdrawals`. `dietzReturn` carries full precision (no rounding).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(perf): independent monthly Modified Dietz module`.

---

### Task 13: Rewrite `twr-reconcile.ts` — sever the circularity

**Files:**
- Modify: `lib/compute/twr-reconcile.ts` (full rewrite of the compare; keep the statement-preference query)
- Modify: `lib/queries/analysis-trust-state.ts:140-186`
- Test: rewrite `tests/compute/twr-reconcile.test.ts`; extend `tests/queries/analysis-trust-state.test.ts`

**Interfaces:**
- Consumes: `computeMonthlyDietz` + constants (Task 12).
- Produces:

```ts
export interface TwrReconcileResult {
  accountId: number; monthEndDate: string;
  statementTwr: number | null;   // decimal, source-normalized (ibkr ÷100 as today)
  statementSource: string | null;
  dietzReturn: number | null;
  divergenceBp: number | null;   // round((dietz - statement) * 10000)
  band: DietzBand; rule: string;
}
export function reconcileTwrAgainstStatements(
  db: Database.Database, accountId: number, monthEndDate: string
): TwrReconcileResult | null;
```

- `getAnalysisTrustState` result: `performanceReconciledThru` RENAMED to `crossCheckedThru`; `perAccountReconciliation` rows carry `{ accountName, monthEndDate, statementTwr, dietzReturn, divergenceBp, band }` plus per-account `bandHistory: Array<{ monthEndDate, band, divergenceBp }>` (the walked sequence). Consumers in Task 14 use these exact names.

- [ ] **Step 1: Failing tests**

```ts
it("CIRCULARITY GUARD: a statement TWR that disagrees with balances produces nonzero divergence", () => {
  // Snapshots: V_start 100k, V_end 110k, zero flows → Dietz = +10%.
  // Statement twr stored as 0.02 (+2%). Old code returned ~0bp; new must be ~+800bp → investigate.
  const r = reconcileTwrAgainstStatements(db, 1, "2026-05-31");
  expect(Math.abs(r.divergenceBp)).toBeGreaterThan(700);
  expect(r.band).toBe("investigate");
});
it("agreeing statement + Dietz within 125bp → consistent", () => {});
it("computeTwr is NOT called (spy/module-mock proves no import)", () => {
  // simplest: assert twr-reconcile.ts has no import of computeTwr — a static
  // source assertion (read the file, expect no /from "\.\/twr"/ match) — crude but pins the sever.
});
it("crossCheckedThru: chain starts at the 2nd statement month; investigate breaks it; not_comparable does not; a missing calendar month breaks it", () => {});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** `twr-reconcile.ts`: the statement-preference SELECT (lines 25-35) DROPS its `AND twr IS NOT NULL` clause (Codex plan review #6 — with the filter kept, `missing-statement-twr` is unreachable): fetch the preferred monthly row (same `ORDER BY (source = 'ibkr-activity') DESC LIMIT 1` preference), and when the row exists but `twr IS NULL`, return `{ …, statementTwr: null, band: "insufficient", rule: "missing-statement-twr" }` with the Dietz side populated; keep the source-aware ÷100 (lines 55-57) for non-null values. DELETE the `computeTwr` import and call; band from `computeMonthlyDietz` result + `DIETZ_CONSISTENT_BP` (banded rule: `abs(bp) <= 125 → consistent`, else `investigate`). `analysis-trust-state.ts`: per account, enumerate calendar months from the SECOND statement month (`fetchPriorMonthTotal != null` start rule) through the latest statement month, reconcile each, build `bandHistory`, compute `crossCheckedThru` per the spec chain rule (`consistent`/`not_comparable` continue; `investigate`/`insufficient`/missing month stop); roll-up earliest across accounts, null if any account chainless. Cache note: this runs one Dietz per account-month on a header-adjacent surface — measure with ~40 account-months (budget < 300 ms); if over, cache with a **60-second TTL** (Codex plan review #16 — the tax generation does NOT advance on snapshot imports, so it is an invalid cache key here; a short TTL is correct and simple).
- [ ] **Step 4: Run + verify:changed — PASS.**
- [ ] **Step 5: Commit** — `feat(perf)!: independent Dietz cross-check replaces circular TWR reconciliation`.

---

### Task 14: Trust surfaces — TrustStrip, drawer, PerformanceView

**Files:**
- Modify: `app/dashboard/components/analysis/TrustStrip.tsx` (lines 85-97, 117, 166-168)
- Modify: `app/dashboard/components/analysis/TrustStripDrawer.tsx` (lines 212-259)
- Modify: `app/dashboard/components/PerformanceView.tsx` (lines 134-152, 277)
- Modify: `app/api/analysis/trust-state/route.ts` (envelope passthrough only)
- Test: component tests if the repo has them for these files (check `tests/components/`); otherwise the API contract test in Task 20 + browser E2E cover it

**Interfaces:**
- Consumes: Task 13's `crossCheckedThru`, `perAccountReconciliation`, `bandHistory`.

- [ ] **Step 1: Implement copy + rendering.**
- TrustStrip performance line: label `Cross-checked (Modified Dietz)`, value `{crossCheckedThru ?? "—"}` with hint `"Latest month with a contiguous independent cross-check (Modified Dietz vs statement TWR)"`. Replace the old "statement-reported, not independently verified" hint (line 168).
- Drawer per-account rows: statement TWR and Dietz through `<Pct>` (decimal in, the component owns formatting); `divergenceBp` ALSO through `<Pct>` — pass `divergenceBp / 10000` as the decimal and render the unit label "bp" outside the component with the displayed magnitude `divergenceBp` (i.e. the masked value is the return-difference; the visible text reads like `+83bp`) — never `<PrivateText>` for a numeric return figure (Codex plan review #15). Band as a `<Chip>` with copy: consistent → `Consistent — method differences expected`; investigate → `Investigate`; not_comparable → `Not comparable`; insufficient → `Insufficient data`. Band history renders as a compact month strip (last 12), each month a dot titled with its band — no green "reconciled ✓" anywhere (grep the two files for `reconciled` and remove every hit).
- PerformanceView (line 277): disclosure becomes `Independently cross-checked (Modified Dietz) through {crossCheckedThru} — bands shown per month in the trust drawer.` Values through `<Pct>`.
- Follow chip-contrast + font-size design rules (`memory: design-readability`).
- [ ] **Step 2: `npm run verify:smoke` + manual dev-server look at /dashboard/analysis.** Screenshots with real figures → `qa/verify-evidence/` only (Task 9 made it ignored).
- [ ] **Step 3: Commit** — `feat(ui): Dietz cross-check surfaces (banded, no reconciled-checkmark language)`.

---

### Task 15: CLI audit script update

**Files:**
- Modify: `scripts/audit-twr-vs-statements.ts:38` (and surrounding result printing)

- [ ] **Step 1:** Point it at the new `reconcileTwrAgainstStatements` shape: print per-account-month `band` and `rule` in a table; exit code 0 unless any band is `investigate` (useful in rehearsals). stdout stays direction-only ALWAYS (bands/rules/counts — no returns, no bp); the numeric detail (returns, bp) writes only via `--detail-out <path>` with the same `git check-ignore` refusal as Task 7 (Codex plan review #19 — no real-figure stdout mode exists).
- [ ] **Step 2:** Run against a fixture DB; `npm run verify:changed`.
- [ ] **Step 3: Commit** — `chore(perf): audit CLI speaks Dietz bands`.

---

### Task 16: Data Confidence query repairs

**Files:**
- Modify: `lib/queries/data-confidence.ts` (lines 129, 145-167, 216-235, 381, 487-493, 533-538)
- Test: extend `tests/queries/data-confidence*.test.ts`

**Interfaces:**
- Consumes: `latestHoldingsPredicate` (`lib/queries/latest-holdings.ts:62`), `todayET` (`lib/calendar/date-utils.ts:19`), `lib/db/holding-sources.ts` source classes.
- Produces: unchanged public result types except `ValuationCoverageScore` gains `perAccountAsOf: Array<{ accountName: string; asOfDate: string | null }>`.

- [ ] **Step 1: Failing tests** (each maps to a spec WS3 bullet):

```ts
it("a carried position under a fresher live row stays in the price-freshness universe", () => {
  // account has statement holdings as_of 2026-07-31 for AAPL and a TWS row as_of 2026-08-20
  // for MSFT only → AAPL must still count in totalHeld.
});
it("shorts are in the universe (quantity != 0)", () => {});
it("a sold-out position can never be the stalest symbol", () => {});
it("a held security with NO price rows IS the stalest (LEFT JOIN, missing-first)", () => {});
it("holdings recency is per (account, security): one fresh TWS row does not make the account read today", () => {});
it("valuation coverage sums per-account latest rows; an account with holdings but no valuation row counts as unpriced", () => {});
it("evening ET boundary: at 2026-08-23T23:30-04:00 the staleness baseline is 2026-08-23, not -24", () => {
  // inject the clock: todayET(new Date("2026-08-24T03:30:00Z"))
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement**, one query at a time, each against its test:
- Lines 129/216/381: `const today = todayET();` — and thread an optional `now?: Date` param through the three scorer functions for the boundary test (default `new Date()`; `getDataConfidence` passes it down).
- Price freshness (145-154) + enrichment (487-493): replace the per-account `MAX(as_of_date)` JOIN with `FROM holdings h JOIN securities … WHERE ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}` (predicate string composes into WHERE; drop the old `h.quantity > 0`).
- Stalest scan (158-167): same predicate; `JOIN prices` → `LEFT JOIN` onto a **latest-price aggregate** (Codex plan review #14 — a bare LEFT JOIN row-multiplies and can pick an old price): `LEFT JOIN (SELECT security_id, MAX(date) AS latest_date FROM prices GROUP BY security_id) p ON p.security_id = s.id`, then `ORDER BY (p.latest_date IS NULL) DESC, days_stale DESC LIMIT 1`; when `latest_date IS NULL`, report `stalestDays` as the holding's own age and prefix the symbol's detail with "no price rows".
- Holdings recency (218-227): per-(account, security) ages via the predicate, then `MAX(days_old)` per account; `source` per account from its latest row's `source_key` through a NEW shared helper added to `lib/db/holding-sources.ts` (Codex #14 — the module today exports prefix lists + a SQL predicate + `isPlaidSourcedHolding`, but no general classifier): `export function classifyHoldingSourceKey(sourceKey: string | null): "statement" | "live"` built on the module's existing prefix lists, with its own small test file.
- Valuation coverage (533-538): 
```sql
SELECT a.name AS account_name, dv.valuation_date, dv.holdings_count, dv.priced_count
FROM accounts a
LEFT JOIN daily_valuations dv ON dv.account_id = a.id
  AND dv.valuation_date = (SELECT MAX(v2.valuation_date) FROM daily_valuations v2 WHERE v2.account_id = a.id)
WHERE EXISTS (SELECT 1 FROM holdings h WHERE h.account_id = a.id AND ${latestHoldingsPredicate(...)} …)
```
Sum `holdings_count`/`priced_count` treating NULL rows as (held-count, 0) — count that account's current holdings for the denominator.
- [ ] **Step 4: Full data-confidence suite + verify:changed — PASS.**
- [ ] **Step 5: Commit** — `fix(confidence): correct universes (latest-holdings predicate, LEFT-JOIN stalest, per-account coverage, ET dates)`.

---

### Task 17: Shared type-contradiction detector + integrity checks module

**Files:**
- Create: `lib/compute/type-contradictions.ts` (extracted from `scripts/repair-security-type-corruption.ts:579`-area detector)
- Modify: `scripts/repair-security-type-corruption.ts` (call the shared module)
- Modify: `lib/mutations/securities.ts:148`-area guard (call the shared module with the `import-guard` tier)
- Create: `lib/queries/integrity-checks.ts`
- Test: `tests/compute/type-contradictions.test.ts`, `tests/queries/integrity-checks.test.ts`

**Interfaces:**
- Produces:

```ts
// type-contradictions.ts — split into a candidate-level predicate and a
// DB-wide audit scan (Codex plan review #8: the import guard evaluates a
// PROPOSED incoming identity BEFORE any row exists, so a db-scan interface
// cannot serve it).
export interface TypeIdentityCandidate {
  securityType: string | null; name: string | null; derivedMaturity: string | null;
}
/** Candidate-level: would this identity contradict an equity-fill history?
 *  The import guard calls this with the INCOMING identity + the target's
 *  fill count; threshold = 1 fill (refuse new writes aggressively). */
export function isBondlikeIdentityOnEquityFills(
  candidate: TypeIdentityCandidate, equityFillCount: number
): boolean;
/** DB-wide audit scan: existing rows, repair-script semantics preserved
 *  EXACTLY — the current detector is an OR-union of (fill-count > 10) with
 *  its metadata corroboration branch and accepts excludeIds; read
 *  scripts/repair-security-type-corruption.ts:579-area FIRST and pin the
 *  existing OR/AND shape with tests BEFORE extraction. */
export function scanTypeContradictions(
  db: Database.Database, opts?: { excludeIds?: number[] }
): Array<{ securityId: number; symbol: string; securityType: string; equityFills: number; held: boolean }>;

// integrity-checks.ts
export interface IntegrityHit { key: string; severity: "critical" | "warning"; reason: string }
export function runIntegrityChecks(db: Database.Database): { critical: IntegrityHit[]; warnings: IntegrityHit[] };
```

- [ ] **Step 1: Extract the detector.** Read the repair script's detector and the `upsertSecurity` guard FIRST; write pin-tests for the current behavior of both; then extract the two functions above so the repair script calls `scanTypeContradictions` (passing its existing excludeIds) and `upsertSecurity` calls `isBondlikeIdentityOnEquityFills` with the incoming candidate — existing tests (`tests/mutations/securities*.test.ts`, repair-script tests) must stay green unchanged.
- [ ] **Step 2: Failing integrity tests** — one fixture per check and per exclusion:

```ts
it("critical: held bond-typed security with equity fills (the U class)", () => {});
it("warning only: the same contradiction on a non-held security", () => {});
it("critical: unexplained negative residual beyond floors; seam/live-anchor classified points do NOT hit", () => {});
it("lot drift: >5% signed drift critical; zero-transaction zero-lot position stays warning; lots-without-position is a warning; epsilon 1e-4 suppresses float dust", () => {});
it("warning: non-null reconcile_delta", () => {});
it("lot-drift check is DARK while the tax convention marker is stale (pre-recompute safety)", () => {
  // getTaxConventionState(db).recomputeCurrent === false → drift check returns no hits.
});
```

- [ ] **Step 3: Implement `runIntegrityChecks`** per the spec matrix: check 1 via `scanTypeContradictions(db)` (held → critical, else warning); check 2's EXACT predicate (Codex plan review #10): a `computeCashFlowResiduals` point where `point.residual < 0` AND `isUnexplainedCashFlow(point, floors)` AND `classification` is neither `source-seam` nor `live-anchor-residual` AND `point.toDate` falls within the LAST 30 valuation days of that account (ancient residuals inform Data Health, not a live gate); hits ordered by `sortWorstFirst` (the existing comparator, `data-confidence.ts:278-284`) so `capReason` is deterministic; check 3 signed drift per the spec formula, guarded dark behind `getTaxConventionState(db).recomputeCurrent` (Track A dependency handled at runtime, not merge order); check 4 `SELECT … FROM corporate_actions WHERE reconcile_delta IS NOT NULL`. Every `reason` string is short and names the object (symbol/date) — it will render inside `<PrivateText>`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(confidence): shared type-contradiction detector + integrity checks module`.

---

### Task 18: Integrity gate wiring — cap the score

**Files:**
- Modify: `lib/queries/data-confidence.ts` (aggregation at 663-675; result type)
- Test: extend `tests/queries/data-confidence.test.ts`

**Interfaces:**
- Consumes: `runIntegrityChecks` (Task 17).
- Produces: `DataConfidence` gains `{ integrity: { critical: IntegrityHit[]; warnings: IntegrityHit[] }; capReason: string | null }`. Cap semantics (spec WS3): monotonic only.

- [ ] **Step 1: Failing tests**

```ts
it("a critical hit caps level high→low and score to ≤45, names capReason", () => {});
it("cap never promotes: a stale (score 15) result stays stale/15 with capReason set", () => {});
it("warnings do not cap", () => {});
it("two criticals: capReason names the FIRST by module order (deterministic)", () => {});
```

- [ ] **Step 2: Implement** after the weighted mean (line 663). NOTE: `overallScore` and `overallLevel` are currently `const` declarations (663, 671) — change both to `let` first (Codex plan review #17):

```ts
let overallScore = Math.round( /* existing weighted mean, unchanged */ );
let overallLevel: DataConfidence["overallLevel"] = /* existing thresholds */;

const integrity = runIntegrityChecks(db);
let capReason: string | null = null;
if (integrity.critical.length > 0) {
  capReason = integrity.critical[0].reason;
  overallScore = Math.min(overallScore, 45);
  // monotonic: only lower. Order: high > medium > low > stale.
  if (overallLevel === "high" || overallLevel === "medium") overallLevel = "low";
}
```

Latency budget: time `runIntegrityChecks` on a live-size DB COPY (rehearsal DB) — must be ≤ 100 ms; run `EXPLAIN QUERY PLAN` on each new SQL and record index usage in the task summary; if over budget, add a module-level cache keyed by `(tax generation, latest valuation date)` with the timing evidence in the summary (numbers themselves to gitignored evidence, direction-only in the summary).
- [ ] **Step 3: Run + verify:changed — PASS.**
- [ ] **Step 4: Commit** — `feat(confidence): integrity gate caps score/level with named reason`.

---

### Task 19: Indicator UI — capReason + timingResidual

**Files:**
- Modify: `app/dashboard/components/DataConfidenceIndicator.tsx`
- Test: browser E2E (Task 20 checklist) + any existing component test

- [ ] **Step 1: Implement.** When `capReason` is set: the badge renders the capped level with an alert accent and a detail line `<PrivateText>{capReason}</PrivateText>`; caption becomes `Data freshness with integrity checks — not a numerical certification.` The integrity **warnings list renders too** (Codex plan review #15 — warnings must be visible, uncapped): a collapsed "N integrity notes" row (`<Count>` for N) expanding to each `reason` in `<PrivateText>`. When `timingResidual` is present (field exists since containment, currently dropped): render its own line — `<PrivateText>Cash delta on {date} in {accountName} is a live-snapshot timing residual — not treated as an external flow.</PrivateText>` with the amount through `<Money>`. Follow chip-contrast rules; no hover-only affordance (expansion is a tap/click).
- [ ] **Step 2: Dev-server look; screenshots → `qa/verify-evidence/`.**
- [ ] **Step 3: Commit** — `feat(ui): confidence badge shows integrity cap + timing-residual label`.

---

### Task 20: API contract tests + browser E2E sweep

**Files:**
- Create: `tests/api/number-trust-contracts.test.ts` (or extend the repo's existing route-test pattern — check `tests/api/` for the harness convention)
- E2E: agent-browser checklist (no committed artifacts beyond the test file)

- [ ] **Step 1: Contract tests — invoke the ACTUAL route handlers** (Codex plan review #11; follow the repo's existing route-handler test convention — find it via `rg -l "route" tests/api/ | head` and mirror the mocking pattern for the db module + Request construction):
- `GET /api/analysis/trust-state`: 200, `{success:true,data}` envelope, `data.crossCheckedThru` + `perAccountReconciliation[].band` + `bandHistory` present; no `performanceReconciledThru` key anywhere in the body (and grep app/ for the old name — zero hits).
- `GET /api/data-confidence`: envelope carries `capReason`, `integrity.critical/warnings`, `timingResidual`; capped score ≤45 under a critical fixture.
- `GET /api/summary` (reads `getDataConfidence` at `app/api/summary/route.ts:37`): body carries the CAPPED score (Electron consumer).
- `GET /api/tax-report`: `filingReady:false` pre-stamp in the JSON body; the download response's `Content-Disposition` header carries `buildTaxReportFilename(...)`'s NOT-FOR-FILING name pre-stamp and the clean name under a stamped fixture.
- [ ] **Step 2: Browser E2E** (dev server, agent-browser; evidence to `qa/verify-evidence/`): tax-report card shows banner + NOT-FOR-FILING filename pre-marker; trust drawer renders all four band chips (seed a fixture DB month per band via the dev DB or assert on whatever live months show + the band legend); confidence badge with a seeded critical shows the cap; privacy mode ON masks every new value (Dietz %, bp, capReason, residual amount); the five gated reader surfaces (tax card, cost-basis recon surface, portfolio-summary tax block / chat summary line, giving view, trade-review/options P&L) each show their pending/disclaimed state when the marker is stale.
- [ ] **Step 3: Full suite** — `PATH=... npx vitest run` + `npx next build`. Record counts.
- [ ] **Step 4: Commit** — `test(contracts): number-trust envelope + E2E evidence`.

---

### Task 21: Reference-doc updates (after all tracks merge)

**Files:**
- Modify: `docs/reference/conventions-detail.md` (tax-lot dollar convention section; TWR-reconciliation contract)
- Modify: `docs/reference/data-integrity.md` (NOT-FOR-FILING → marker-gated + wash-sale advisory; TWR relabel → Dietz cross-check)
- Modify: `docs/reference/auto-refresh.md` + `docs/reference/api-patterns.md` (confidence dimensions + integrity gate + new envelope fields)
- Modify: `CLAUDE.md` (the two containment bullets that become stale: "Tax exports are bannered NOT-FOR-FILING" → marker-gated description; "TWR reconciliation is statement-self-referential" → replaced by the Dietz lane rule "never re-add reconciled ✓" stays)

- [ ] **Step 1:** Update each doc, direction-only language, cross-referencing the spec. The CLAUDE.md tax bullet becomes: exports are marker-gated (`getTaxConventionState`) — banner clears per accepted account/tax-year; wash-sale W codes stay advisory pending 1099-B reconciliation; never bypass the gate.
- [ ] **Step 2: Commit** — `docs: number-trust durable fixes — reference contracts updated`.

---

## USER-RUN post-merge runbook (no task performs these)

1. Quit the packaged app. Rehearse on a copy: `cp data/vanguard.db <scratch>/rehearsal.db` (app quit = no hot WAL), then `REPAIR_DB_PATH=<scratch>/rehearsal.db npx tsx scripts/recompute-tax-lots-v2.ts --apply --verify-idempotent` from the repo root.
2. Rehearse acceptance: transcribe statement realized sections + IBKR annual CSV into `data/repair-configs/broker-realized-<year>.json` (real figures — gitignored), then `REPAIR_DB_PATH=<scratch>/rehearsal.db npx tsx scripts/reconcile-tax-report-vs-broker.ts --config … --detail-out docs/private/reconcile-detail.txt`.
3. Live run: `npx tsx scripts/recompute-tax-lots-v2.ts --apply --live` (backs up via SQLite backup API to `data/backups/` first), then the acceptance script with `--stamp`.
4. Verify in the app: tax card banner cleared for accepted years; trust drawer bands; confidence badge. Rollback = restore the backup **and** revert code together (spec Rollout).
5. Electron rebuild per the session-end convention.

## Self-review checklist (ran at authoring)

- Spec coverage: WS1 → Tasks 1-10; WS2 → 11-15; WS3 → 16-19; Privacy → Tasks 7/9/14/19/20; Testing → in-task + Task 20; Rollout → runbook + Task 10; doc updates → Task 21. Wash-sale advisory → Task 6. Fee matrix → Task 3. Generation/markers → Tasks 1-2.
- Type consistency: `getTaxConventionState`/`isYearAccepted`/`AcceptanceCoverage` (T1) consumed by T2/T4/T6/T7/T17; `filingOnly` (T5) consumed by T6; `computeMonthlyDietz`/`DietzBand`/constants (T12) consumed by T13; `crossCheckedThru`/`bandHistory` (T13) consumed by T14/T20; `IntegrityHit`/`runIntegrityChecks` (T17) consumed by T18/T19.
- No placeholder patterns remain.
