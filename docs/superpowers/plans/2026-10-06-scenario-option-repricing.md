# Scenario Option Repricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the straight-line option treatment in both scenario engines with Black-Scholes repricing at the shocked underlying price, with a user-set volatility slider and honest "not modelled" handling.

**Architecture:** One new pure module, `lib/compute/option-reprice.ts`, holds the whole calculation. The custom engine (`lib/compute/scenarios.ts`) and the preset engine (`lib/compute/scenario-recipes.ts`) both call it, so the two cards cannot disagree. The pricers and the implied-volatility solver already exist in `lib/compute/options-greeks.ts` and are reused unchanged.

**Tech Stack:** TypeScript 5, Next.js 16 App Router, better-sqlite3, Vitest (in-memory SQLite). No new dependency. No schema change.

**Spec:** `docs/superpowers/specs/2026-10-06-scenario-option-repricing-design.md` — read it before any task.

## Global Constraints

- Run every command from the repo root with `PATH=/opt/homebrew/opt/node@24/bin:$PATH` in front.
- No guessed financial figure on the scenario path: no `2.5` elasticity, no `0.30` / `?? 0.3` volatility default. An option that cannot be priced is unmodelled.
- Volatility source order is fixed: solved from the contract's own last price, then `security_quotes.iv_underlying`, then unmodelled.
- Dollar change for an option = `market_value × (V1 − V0) ÷ own_price`. Do not add a second quantity, multiplier or FX path.
- The interest rate is `getRiskFreeRate(db)` and does not move with the scenario. Time to expiry is today's. No dividend yield.
- Presets use a volatility change of 0. Only a custom scenario carries `volMove` (volatility points; 15 means +0.15).
- Test fixtures are synthetic: `ZZ*` tickers and round numbers. Never copy a figure from the real database.
- UI: portfolio-derived figures stay inside `<PrivateText>`; no caret glyphs; text of 17px or less needs 4.5:1 contrast (use existing `text-ink-faint` / `text-ink-dim` tokens).
- Do not touch `lib/compute/options-greeks.ts`, `lib/compute/exposure.ts`, the Greeks card, or the import pipeline.
- Commit by pathspec with `git commit -F <message-file> -- <paths>`; never `git stash`; never a bare `git commit`.

## Review Focus

1. **Stale option quote below exercise value.** A contract whose last price is under its exercise value has no solvable volatility. Expected: it falls to the broker figure, or is unmodelled; never `NaN` on screen. Pinned in Task 1 (`falls back to the broker figure when the own price is below exercise value`).
2. **A move of −100% or worse on the underlying.** `S'` reaches zero; `log(0)` must not leak. Expected: a put is worth its strike, a call is worth zero. Pinned in Task 1 (`underlying to zero`).
3. **Expiry today.** Time to expiry is hours. Expected: a finite result, or `expired` after the close. Pinned in Task 1 (`same-day expiry`).
4. **A large negative volatility slider.** `σ + Δvol` at or below zero. Expected: floored at 0.01, finite result. Pinned in Task 1 (`volatility floor`).
5. **Every option unmodelled, or a non-number sent as the slider value.** Expected: the card still renders with its count line and the total still ties; the API answers 400. Pinned in Task 2 (`all options unmodelled`) and Task 4 (`rejects a non-finite volMove`).

---

### Task 1: The repricing module

**Files:**
- Create: `lib/compute/option-reprice.ts`
- Modify: `lib/compute/option-elasticity.ts` (export `normalizeExpirationDate`; one word)
- Test: `tests/compute/option-reprice.test.ts`

**Interfaces:**
- Consumes: `callPrice`, `putPrice`, `impliedVolatility`, `yearsToExpiry`, `isExpiredAsOf` from `lib/compute/options-greeks.ts`; `OptionElasticityInputs`, `normalizeExpirationDate`, `isOptionSecurityType` from `lib/compute/option-elasticity.ts`; `todayET` from `lib/calendar/date-utils`.
- Produces:
  - `type OptionIvSource = "own-price" | "broker-underlying"`
  - `type OptionUnmodelledReason = "no-option-terms" | "expired" | "no-option-price" | "no-underlying-price" | "no-volatility"`
  - `interface OptionRepriceShock { underlyingMove: number; volChange?: number; riskFreeRate: number; today?: string; now?: Date }`
  - `type OptionRepriceResult = { modelled: true; v0: number; v1: number; perShareChange: number; changePercent: number; sigma: number; sigmaShocked: number; ivSource: OptionIvSource } | { modelled: false; reason: OptionUnmodelledReason }`
  - `function repriceOptionUnderShock(pos: OptionElasticityInputs, shock: OptionRepriceShock): OptionRepriceResult`
  - `function summarizeUnmodelledOptions(rows: Array<{ securityType: string; currentValue: number; unmodelledReason?: OptionUnmodelledReason }>): { count: number; valueShare: number }`
  - `const MIN_SHOCKED_VOL = 0.01`

- [ ] **Step 1: Export the expiry normalizer**

In `lib/compute/option-elasticity.ts` change `function normalizeExpirationDate(expiry: string): string | null {` to `export function normalizeExpirationDate(expiry: string): string | null {`. Nothing else in that file changes in this task.

- [ ] **Step 2: Write the failing tests**

Create `tests/compute/option-reprice.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  repriceOptionUnderShock,
  summarizeUnmodelledOptions,
  MIN_SHOCKED_VOL,
} from "@/lib/compute/option-reprice";
import { putPrice, callPrice } from "@/lib/compute/options-greeks";
import type { OptionElasticityInputs } from "@/lib/compute/option-elasticity";

// All figures synthetic. Fixed clock so time-to-expiry is deterministic.
const TODAY = "2026-06-01";
const NOW = new Date("2026-06-01T15:00:00Z"); // 11:00 ET, market open
const EXPIRY = "2026-08-30"; // 90 days
const T = 90 / 365;
const R = 0.04;

function put(over: Partial<OptionElasticityInputs> = {}): OptionElasticityInputs {
  // Own price is the model price at sigma 0.40, so the solver recovers 0.40.
  return {
    option_type: "PUT",
    strike_price: 50,
    expiration_date: EXPIRY,
    own_price: putPrice(60, 50, T, R, 0.4),
    underlying_price: 60,
    underlying_iv: 0.3,
    ...over,
  };
}
function call(over: Partial<OptionElasticityInputs> = {}): OptionElasticityInputs {
  return { ...put(), option_type: "CALL", strike_price: 60, own_price: callPrice(60, 60, T, R, 0.4), ...over };
}
const shock = (underlyingMove: number, volChange = 0) => ({ underlyingMove, volChange, riskFreeRate: R, today: TODAY, now: NOW });

describe("repriceOptionUnderShock", () => {
  it("zero-shock identity: no move and no volatility change gives exactly zero", () => {
    const r = repriceOptionUnderShock(put(), shock(0));
    expect(r.modelled).toBe(true);
    if (!r.modelled) return;
    expect(r.ivSource).toBe("own-price");
    expect(r.sigma).toBeCloseTo(0.4, 3);
    expect(r.perShareChange).toBe(0);
    expect(r.changePercent).toBe(0);
  });

  it("the finding: a put's shocked value is never below exercise value at the shocked price", () => {
    for (const move of [-0.1, -0.25, -0.5, -0.8]) {
      const r = repriceOptionUnderShock(put(), shock(move));
      if (!r.modelled) throw new Error("expected modelled");
      const shockedUnderlying = 60 * (1 + move);
      expect(r.v1).toBeGreaterThanOrEqual(Math.max(50 - shockedUnderlying, 0) - 1e-9);
    }
    // -50%: underlying 30, exercise value 20. The old linear engine capped
    // the move at +800% of a small premium, far below this.
    const big = repriceOptionUnderShock(put(), shock(-0.5));
    if (!big.modelled) throw new Error("expected modelled");
    expect(big.v1).toBeGreaterThanOrEqual(20 - 1e-9);
    expect(big.changePercent).toBeGreaterThan(8);
  });

  it("sign: a put gains and a call loses on a down move, reversed on an up move", () => {
    const pd = repriceOptionUnderShock(put(), shock(-0.2));
    const cd = repriceOptionUnderShock(call(), shock(-0.2));
    const pu = repriceOptionUnderShock(put(), shock(0.2));
    const cu = repriceOptionUnderShock(call(), shock(0.2));
    if (!pd.modelled || !cd.modelled || !pu.modelled || !cu.modelled) throw new Error("expected modelled");
    expect(pd.perShareChange).toBeGreaterThan(0);
    expect(cd.perShareChange).toBeLessThan(0);
    expect(pu.perShareChange).toBeLessThan(0);
    expect(cu.perShareChange).toBeGreaterThan(0);
  });

  it("monotonic in volatility: raising the volatility change never lowers the shocked value", () => {
    let last = -Infinity;
    for (const vol of [-0.2, 0, 0.15, 0.4]) {
      const r = repriceOptionUnderShock(put(), shock(-0.15, vol));
      if (!r.modelled) throw new Error("expected modelled");
      expect(r.v1).toBeGreaterThanOrEqual(last - 1e-9);
      last = r.v1;
    }
  });

  it("volatility floor: a large negative change is floored, result finite", () => {
    const r = repriceOptionUnderShock(put(), shock(-0.1, -5));
    if (!r.modelled) throw new Error("expected modelled");
    expect(r.sigmaShocked).toBe(MIN_SHOCKED_VOL);
    expect(Number.isFinite(r.v1)).toBe(true);
  });

  it("underlying to zero: a put is worth its strike, a call is worth zero", () => {
    const p = repriceOptionUnderShock(put(), shock(-1.5)); // floored at -100%
    const c = repriceOptionUnderShock(call(), shock(-1));
    if (!p.modelled || !c.modelled) throw new Error("expected modelled");
    expect(p.v1).toBeCloseTo(50, 9);
    expect(c.v1).toBe(0);
    expect(c.changePercent).toBe(-1);
  });

  it("falls back to the broker figure when the own price is below exercise value", () => {
    // Deep in-the-money put quoted under exercise value: no volatility solves it.
    const stale = put({ strike_price: 80, own_price: 5, underlying_price: 60, underlying_iv: 0.35 });
    const r = repriceOptionUnderShock(stale, shock(-0.1));
    if (!r.modelled) throw new Error("expected modelled");
    expect(r.ivSource).toBe("broker-underlying");
    expect(r.sigma).toBe(0.35);
    // Change is model-to-model (v1 - v0), not v1 minus the market price.
    expect(r.perShareChange).toBeCloseTo(r.v1 - r.v0, 12);
    expect(r.changePercent).toBeGreaterThanOrEqual(-1);
  });

  it("legacy expiry spelling reprices the same as ISO", () => {
    const iso = repriceOptionUnderShock(put(), shock(-0.2));
    const compact = repriceOptionUnderShock(put({ expiration_date: "20260830" }), shock(-0.2));
    expect(compact).toEqual(iso);
  });

  it("same-day expiry stays finite before the close and is expired after it", () => {
    const sameDay = put({ expiration_date: TODAY, own_price: 0.05 });
    const open = repriceOptionUnderShock(sameDay, shock(-0.2));
    if (open.modelled) expect(Number.isFinite(open.v1)).toBe(true);
    const closed = repriceOptionUnderShock(sameDay, { ...shock(-0.2), now: new Date("2026-06-01T21:00:00Z") });
    expect(closed).toEqual({ modelled: false, reason: "expired" });
  });

  it("unmodelled reasons", () => {
    const s = shock(-0.2);
    expect(repriceOptionUnderShock(put({ option_type: null }), s)).toEqual({ modelled: false, reason: "no-option-terms" });
    expect(repriceOptionUnderShock(put({ strike_price: null }), s)).toEqual({ modelled: false, reason: "no-option-terms" });
    expect(repriceOptionUnderShock(put({ expiration_date: "garbage" }), s)).toEqual({ modelled: false, reason: "no-option-terms" });
    expect(repriceOptionUnderShock(put({ expiration_date: "2026-05-01" }), s)).toEqual({ modelled: false, reason: "expired" });
    expect(repriceOptionUnderShock(put({ own_price: null }), s)).toEqual({ modelled: false, reason: "no-option-price" });
    expect(repriceOptionUnderShock(put({ underlying_price: null }), s)).toEqual({ modelled: false, reason: "no-underlying-price" });
    expect(
      repriceOptionUnderShock(put({ strike_price: 80, own_price: 5, underlying_iv: null }), s),
    ).toEqual({ modelled: false, reason: "no-volatility" });
  });
});

describe("summarizeUnmodelledOptions", () => {
  it("counts unmodelled options and their share of option value; ignores non-options", () => {
    const out = summarizeUnmodelledOptions([
      { securityType: "Stock", currentValue: 10000 },
      { securityType: "Option", currentValue: 600 },
      { securityType: "Option", currentValue: -200, unmodelledReason: "no-underlying-price" },
      { securityType: "Option", currentValue: 0, unmodelledReason: "no-option-price" },
    ]);
    expect(out.count).toBe(2);
    expect(out.valueShare).toBeCloseTo(200 / 800, 12);
  });
  it("no options at all gives zero and zero", () => {
    expect(summarizeUnmodelledOptions([{ securityType: "Stock", currentValue: 1 }])).toEqual({ count: 0, valueShare: 0 });
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/option-reprice.test.ts`
Expected: FAIL, cannot resolve `@/lib/compute/option-reprice`.

- [ ] **Step 4: Write the module**

Create `lib/compute/option-reprice.ts`:

```ts
/**
 * Option repricing under a scenario shock — the ONE option treatment both
 * scenario engines share (spec: docs/superpowers/specs/
 * 2026-10-06-scenario-option-repricing-design.md).
 *
 * Replaces the linear elasticity estimate (Ω = Δ·S/V, capped at 8), which
 * drew a large move as a straight line and understated a short put's loss
 * several times over. An option is repriced with Black-Scholes at the shocked
 * underlying price; nothing here is a guessed figure — an option that cannot
 * be priced is reported as unmodelled.
 */

import { callPrice, putPrice, impliedVolatility, yearsToExpiry, isExpiredAsOf } from "./options-greeks";
import { normalizeExpirationDate, isOptionSecurityType, type OptionElasticityInputs } from "./option-elasticity";
import { todayET } from "@/lib/calendar/date-utils";

export type OptionIvSource = "own-price" | "broker-underlying";

export type OptionUnmodelledReason =
  | "no-option-terms"
  | "expired"
  | "no-option-price"
  | "no-underlying-price"
  | "no-volatility";

/** Shocked volatility never goes to or below zero (the formula divides by it). */
export const MIN_SHOCKED_VOL = 0.01;

export interface OptionRepriceShock {
  /** The UNDERLYING's scenario move, e.g. -0.2. Floored at -100% here. */
  underlyingMove: number;
  /** Volatility change as a decimal (15 points = 0.15). Absent or non-finite = 0. */
  volChange?: number;
  riskFreeRate: number;
  /** Injected for tests; default the ET calendar date / the wall clock. */
  today?: string;
  now?: Date;
}

export type OptionRepriceResult =
  | {
      modelled: true;
      /** Model value today, per share. Equals the market price on the own-price source. */
      v0: number;
      /** Model value at the shocked underlying and shocked volatility, per share. */
      v1: number;
      perShareChange: number;
      /** perShareChange / own price, floored at -100%. Multiply by market value for dollars. */
      changePercent: number;
      sigma: number;
      sigmaShocked: number;
      ivSource: OptionIvSource;
    }
  | { modelled: false; reason: OptionUnmodelledReason };

function intrinsic(type: "CALL" | "PUT", S: number, K: number): number {
  return type === "CALL" ? Math.max(S - K, 0) : Math.max(K - S, 0);
}

/** Black-Scholes value floored at exercise value (the early-exercise treatment). */
function modelValue(type: "CALL" | "PUT", S: number, K: number, T: number, r: number, sigma: number): number {
  const floor = intrinsic(type, S, K);
  if (S <= 0) return floor;
  const bs = type === "CALL" ? callPrice(S, K, T, r, sigma) : putPrice(S, K, T, r, sigma);
  return Number.isFinite(bs) ? Math.max(bs, floor) : floor;
}

export function repriceOptionUnderShock(pos: OptionElasticityInputs, shock: OptionRepriceShock): OptionRepriceResult {
  const rawType = (pos.option_type ?? "").trim().toUpperCase();
  const type = rawType.startsWith("P") ? "PUT" : rawType.startsWith("C") ? "CALL" : null;
  const K = pos.strike_price;
  const expiry = pos.expiration_date ? normalizeExpirationDate(pos.expiration_date) : null;
  if (!type || K == null || !(K > 0) || !expiry) return { modelled: false, reason: "no-option-terms" };

  const today = shock.today ?? todayET();
  const now = shock.now ?? new Date();
  if (isExpiredAsOf(expiry, today, now)) return { modelled: false, reason: "expired" };

  const V = pos.own_price;
  if (V == null || !(V > 0)) return { modelled: false, reason: "no-option-price" };
  const S = pos.underlying_price;
  if (S == null || !(S > 0)) return { modelled: false, reason: "no-underlying-price" };

  const T = yearsToExpiry(expiry, today, now);
  const r = shock.riskFreeRate;

  let sigma: number;
  let ivSource: OptionIvSource;
  const solved = impliedVolatility(V, S, K, T, r, type);
  // Round-trip check: a quote below exercise value has no volatility that
  // explains it, and a solver that returns its lower bound instead of null
  // must not be trusted. Accept only a volatility that reprices the quote.
  const reprices =
    solved != null &&
    Number.isFinite(solved) &&
    solved > 0 &&
    Math.abs((type === "CALL" ? callPrice(S, K, T, r, solved) : putPrice(S, K, T, r, solved)) - V) <= Math.max(0.01, 0.01 * V);
  if (solved != null && reprices) {
    sigma = solved;
    ivSource = "own-price";
  } else if (pos.underlying_iv != null && Number.isFinite(pos.underlying_iv) && pos.underlying_iv > 0) {
    sigma = pos.underlying_iv;
    ivSource = "broker-underlying";
  } else {
    return { modelled: false, reason: "no-volatility" };
  }

  const move = Math.max(Number.isFinite(shock.underlyingMove) ? shock.underlyingMove : 0, -1);
  const volChange = typeof shock.volChange === "number" && Number.isFinite(shock.volChange) ? shock.volChange : 0;
  const sigmaShocked = Math.max(sigma + volChange, MIN_SHOCKED_VOL);

  const v0 = modelValue(type, S, K, T, r, sigma);
  // No move and no volatility change is the same calculation twice; return it
  // as an exact zero rather than a floating-point near-zero.
  const v1 = move === 0 && sigmaShocked === sigma ? v0 : modelValue(type, S * (1 + move), K, T, r, sigmaShocked);
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) return { modelled: false, reason: "no-volatility" };

  const perShareChange = v1 - v0;
  return {
    modelled: true,
    v0,
    v1,
    perShareChange,
    changePercent: Math.max(-1, perShareChange / V),
    sigma,
    sigmaShocked,
    ivSource,
  };
}

/**
 * How many option rows a scenario left unmodelled, and their share of the
 * absolute option value. A contract with no price of its own has zero value,
 * so it adds to the count and not to the share.
 */
export function summarizeUnmodelledOptions(
  rows: Array<{ securityType: string; currentValue: number; unmodelledReason?: OptionUnmodelledReason }>,
): { count: number; valueShare: number } {
  let count = 0;
  let unmodelledValue = 0;
  let optionValue = 0;
  for (const row of rows) {
    if (!isOptionSecurityType(row.securityType)) continue;
    const value = Math.abs(row.currentValue);
    optionValue += value;
    if (row.unmodelledReason) {
      count += 1;
      unmodelledValue += value;
    }
  }
  return { count, valueShare: optionValue > 0 ? unmodelledValue / optionValue : 0 };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/option-reprice.test.ts && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit`
Expected: all tests PASS; `tsc` prints nothing.

If `same-day expiry` or `underlying to zero` fails, fix the module, not the test: those two are Review Focus items.

- [ ] **Step 6: Commit**

```bash
git add lib/compute/option-reprice.ts tests/compute/option-reprice.test.ts
git commit -F <message-file> -- lib/compute/option-reprice.ts lib/compute/option-elasticity.ts tests/compute/option-reprice.test.ts
```
Message: `feat(scenarios): option repricing under a shock, one shared pure module`

---

### Task 2: Custom engine uses repricing

**Files:**
- Modify: `lib/compute/scenarios.ts` (types near lines 27–72; position query WHERE near line 145; option branch near lines 242–256; result near lines 283–310)
- Modify: `lib/compute/option-elasticity.ts` (add one exported SQL fragment)
- Rename and rewrite: `tests/compute/scenarios-custom-option-elasticity.test.ts` → `tests/compute/scenarios-custom-option-repricing.test.ts`

**Interfaces:**
- Consumes: `repriceOptionUnderShock`, `summarizeUnmodelledOptions`, `OptionIvSource`, `OptionUnmodelledReason` from Task 1.
- Produces (in `lib/compute/scenarios.ts`):
  - `ScenarioDefinition.volMove?: number` — volatility points for a custom scenario.
  - `PositionImpact.ivSource?: OptionIvSource` and `PositionImpact.unmodelledReason?: OptionUnmodelledReason`.
  - `ScenarioResult.optionsUnmodelled: { count: number; valueShare: number }` (always present).
  - In `lib/compute/option-elasticity.ts`: `export const OPTION_ROW_SQL = "LOWER(TRIM(s.security_type)) IN ('option', 'call', 'put')"`.

- [ ] **Step 1: Rewrite the test file**

`git mv tests/compute/scenarios-custom-option-elasticity.test.ts tests/compute/scenarios-custom-option-repricing.test.ts`, then edit it. Keep its `seed()` function, ids and scenario constants as they are (read the whole file first). Make these changes:

1. Replace the `option-elasticity` import with:
```ts
import { repriceOptionUnderShock } from "@/lib/compute/option-reprice";
import type { OptionElasticityInputs } from "@/lib/compute/option-elasticity";
```
2. Delete every assertion that calls `optionElasticity(` or reads `DEFAULT_OPTION_ELASTICITY` (three `it` blocks around lines 200–230: the sign-matches-omega test, the "equals underlying move × omega" test, and the levered-beta test).
3. In `seed()`, add one more option with no price row of its own (id 8, `ZZUL` put, strike 90, same expiry, quantity 1, no `prices` insert) so the query change is exercised.
4. Add these tests inside the main `describe`:

```ts
  it("an option's change is the shared repricing result (engine and module agree)", () => {
    const res = computeScenario(db, DOWN_20);
    const longPut = res.positionImpacts.find((p) => p.securityId === LONG_PUT_ID)!;
    const expected = repriceOptionUnderShock(putInputs(), {
      underlyingMove: -0.2 * UNDERLYING_BETA,
      riskFreeRate: getRiskFreeRate(db),
    });
    if (!expected.modelled) throw new Error("fixture must be modelled");
    expect(longPut.changePercent).toBeCloseTo(expected.changePercent, 10);
    expect(longPut.ivSource).toBe(expected.ivSource);
    expect(longPut.estimatedChange).toBeCloseTo(longPut.currentValue * expected.changePercent, 8);
  });

  it("a long put gains and a long call loses on a down move; a short put loses dollars", () => {
    const res = computeScenario(db, DOWN_20);
    const by = (id: number) => res.positionImpacts.find((p) => p.securityId === id)!;
    expect(by(LONG_PUT_ID).estimatedChange).toBeGreaterThan(0);
    expect(by(LONG_CALL_ID).estimatedChange).toBeLessThan(0);
    expect(by(SHORT_PUT_ID).currentValue).toBeLessThan(0);
    expect(by(SHORT_PUT_ID).estimatedChange).toBeLessThan(0);
  });

  it("a zero move with no volatility change leaves every option unchanged", () => {
    const res = computeScenario(db, { ...DOWN_20, id: "custom-flat", marketMove: 0 });
    for (const p of res.positionImpacts.filter((x) => x.securityType === "Option" && !x.unmodelledReason)) {
      if (p.ivSource === "own-price") expect(p.estimatedChange).toBe(0);
    }
  });

  it("the volatility slider moves option rows only", () => {
    const base = computeScenario(db, DOWN_20);
    const bumped = computeScenario(db, { ...DOWN_20, volMove: 20 });
    const stock = (r: typeof base) => r.positionImpacts.find((p) => p.securityId === STOCK_ID)!;
    expect(stock(bumped).estimatedChange).toBe(stock(base).estimatedChange);
    const put = (r: typeof base) => r.positionImpacts.find((p) => p.securityId === LONG_PUT_ID)!;
    expect(put(bumped).estimatedChange).toBeGreaterThan(put(base).estimatedChange);
  });

  it("an option that cannot be repriced is listed, adds nothing, and is counted", () => {
    const res = computeScenario(db, DOWN_20);
    const orphan = res.positionImpacts.find((p) => p.securityId === ORPHAN_PUT_ID)!;
    expect(orphan.unmodelledReason).toBe("no-underlying-price");
    expect(orphan.estimatedChange).toBe(0);
    expect(orphan.changePercent).toBe(0);
    const priceless = res.positionImpacts.find((p) => p.securityId === 8)!;
    expect(priceless.unmodelledReason).toBe("no-option-price");
    expect(priceless.currentValue).toBe(0);
    expect(res.optionsUnmodelled.count).toBe(2);
    expect(res.optionsUnmodelled.valueShare).toBeGreaterThan(0);
  });

  it("the scenario total equals the sum of the rows", () => {
    const res = computeScenario(db, { ...DOWN_20, volMove: 10 });
    const sum = res.positionImpacts.reduce((s, p) => s + p.estimatedChange, 0);
    expect(res.estimatedChange).toBeCloseTo(sum, 8);
  });

  it("all options unmodelled: the result still computes and the total ties", () => {
    db.prepare(`DELETE FROM prices WHERE security_id = ?`).run(STOCK_ID); // every ZZUL option loses its underlying price
    const res = computeScenario(db, DOWN_20);
    const options = res.positionImpacts.filter((p) => p.securityType === "Option");
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((p) => p.unmodelledReason)).toBe(true);
    expect(res.optionsUnmodelled.count).toBe(options.length);
    expect(res.estimatedChange).toBeCloseTo(res.positionImpacts.reduce((s, p) => s + p.estimatedChange, 0), 8);
  });
```
If the existing file has no `putInputs()` helper returning `OptionElasticityInputs` for the long put, keep the one it has (it is used by the deleted tests) and reuse it. If the orphan put in the fixture has an underlying WITH a price, change the fixture so `ORPHAN_UNDERLYING_ID` has no `prices` row, as its comment near line 101 describes.

Keep the money-market-fund tests in this file unchanged.

- [ ] **Step 2: Run and confirm the new tests fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/scenarios-custom-option-repricing.test.ts`
Expected: FAIL (`ivSource` undefined, `optionsUnmodelled` undefined, id 8 not found).

- [ ] **Step 3: Add the SQL fragment**

In `lib/compute/option-elasticity.ts`, after `OPTION_PRICING_JOINS_SQL`, add:

```ts
/**
 * SQL twin of `isOptionSecurityType` for the `s` alias. Both position queries
 * use it to keep an option row that has no price of its own, so the scenario
 * can list it as "not modelled" instead of dropping it silently.
 */
export const OPTION_ROW_SQL = `LOWER(TRIM(s.security_type)) IN ('option', 'call', 'put')`;
```

- [ ] **Step 4: Change the types in `lib/compute/scenarios.ts`**

Add the import:
```ts
import {
  repriceOptionUnderShock,
  summarizeUnmodelledOptions,
  type OptionIvSource,
  type OptionUnmodelledReason,
} from "./option-reprice";
```
Change the `./option-elasticity` import to drop `optionElasticity` and `leverUnderlyingMoveByElasticity` and add `OPTION_ROW_SQL`.

In `ScenarioDefinition`, after `rateMove`:
```ts
  /** Volatility change in points for option repricing (15 = +15 points). Custom scenarios only; presets hold volatility at today's level. */
  volMove?: number;
```
In `PositionImpact`, after `subjectShare`:
```ts
  /** Options only: where the volatility used to reprice this contract came from. */
  ivSource?: OptionIvSource;
  /** Options only: set when the contract could not be repriced; its change is then zero. */
  unmodelledReason?: OptionUnmodelledReason;
```
In `ScenarioResult`, after `biggestWinners`:
```ts
  /** Option rows left out of the total because they could not be repriced. */
  optionsUnmodelled: { count: number; valueShare: number };
```

- [ ] **Step 5: Keep priceless options in the query**

In `computeScenario`'s position query change
```sql
       WHERE COALESCE(lp.close_price, 0) > 0
         AND ${liveOptionExpirationSql("s")}
```
to
```sql
       WHERE (COALESCE(lp.close_price, 0) > 0 OR ${OPTION_ROW_SQL})
         AND ${liveOptionExpirationSql("s")}
```

- [ ] **Step 6: Replace the option branch**

Replace the block from `let changePercent: number;` through the end of the `if (isOption) { … } else { … }` (the lines shown in the spec's §2 area, about 240–266) with:

```ts
    let changePercent: number;
    let ivSource: OptionIvSource | undefined;
    let unmodelledReason: OptionUnmodelledReason | undefined;
    if (isOption) {
      // Reprice at the shocked underlying (spec 2026-10-06). The engine's
      // move describes the UNDERLYING; the option's own change comes from
      // Black-Scholes, so a short put's loss on a large drop is no longer a
      // straight line capped at 8x. An option that cannot be priced adds
      // nothing and is reported, never estimated from a fixed figure.
      const repriced = repriceOptionUnderShock(pos, {
        underlyingMove,
        volChange: (scenario.volMove ?? 0) / 100,
        riskFreeRate,
      });
      if (repriced.modelled) {
        changePercent = repriced.changePercent;
        ivSource = repriced.ivSource;
      } else {
        changePercent = 0;
        unmodelledReason = repriced.reason;
      }
    } else {
      // The UNDERLYING can't fall below zero, i.e. changePercent can't go
      // below -100% — for longs AND shorts. A short's direction is already
      // carried by its negative market_value; estimatedChange = market_value *
      // changePercent still flips sign correctly.
      changePercent = Math.max(underlyingMove, -1);
    }
```
Delete the `reportedBeta` variable; in the returned object use `beta` (the underlying's beta for an option) and add `ivSource, unmodelledReason`.

In the final `return { scenario, … }` add `optionsUnmodelled: summarizeUnmodelledOptions(positionImpacts),`.

- [ ] **Step 7: Make the recipe engine compile**

`computeRecipeScenario` in `lib/compute/scenario-recipes.ts` returns a `ScenarioResult`. Add `optionsUnmodelled: { count: 0, valueShare: 0 },` to its return object for now (Task 3 replaces it with the real summary). Import nothing new there yet.

- [ ] **Step 8: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute tests/api/scenarios-route-validation.test.ts tests/contracts && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit`
Expected: PASS and no type errors. If `tests/compute/scenarios.test.ts`, `scenarios-composed.test.ts` or `scenarios-market-cap.test.ts` pinned an option's linear figure, update that expectation to the value `repriceOptionUnderShock` gives for the same fixture and say so in the commit message. If `tests/contracts/api-component-contracts.test.ts` lists `ScenarioResult` fields, add the new one.

- [ ] **Step 9: Commit**

```bash
git add tests/compute/scenarios-custom-option-repricing.test.ts
git commit -F <message-file> -- lib/compute/scenarios.ts lib/compute/scenario-recipes.ts lib/compute/option-elasticity.ts tests/compute tests/contracts
```
Message: `feat(scenarios): custom scenarios reprice options and report the ones they cannot`

---

### Task 3: Preset engine uses repricing; linear path removed

**Files:**
- Modify: `lib/compute/scenario-recipes.ts` (query WHERE near line 580; option branch near lines 667–672; return near line 700; imports near line 35)
- Modify: `lib/compute/option-elasticity.ts` (delete the two dead functions and the clamp constant)
- Modify: `tests/compute/scenario-recipes.test.ts`
- Create: `tests/compute/scenario-option-engine-parity.test.ts`
- Create: `tests/repo/scenario-option-no-linear-fallback.test.ts`

**Interfaces:**
- Consumes: Task 1's `repriceOptionUnderShock`, `summarizeUnmodelledOptions`; Task 2's `PositionImpact` fields, `ScenarioResult.optionsUnmodelled`, `OPTION_ROW_SQL`.
- Produces: `lib/compute/option-elasticity.ts` no longer exports `optionElasticity`, `leverUnderlyingMoveByElasticity` or `MAX_OPTION_ELASTICITY`. It still exports `DEFAULT_OPTION_ELASTICITY` (used by `lib/compute/exposure.ts` through the re-export in `scenario-recipes.ts`), `isOptionSecurityType`, `normalizeExpirationDate`, `OptionElasticityInputs`, `OPTION_PRICING_COLUMNS_SQL`, `OPTION_PRICING_JOINS_SQL`, `OPTION_ROW_SQL`.

- [ ] **Step 1: Write the parity test**

Create `tests/compute/scenario-option-engine-parity.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, PRESET_SCENARIOS } from "@/lib/compute/scenarios";
import { repriceOptionUnderShock } from "@/lib/compute/option-reprice";
import { putPrice } from "@/lib/compute/options-greeks";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import { todayET, addDays } from "@/lib/calendar/date-utils";

/**
 * Spec test 5 (engine parity). The preset engine and the custom engine derive
 * the UNDERLYING's move differently (factor buckets vs beta), so parity is
 * stated per engine: each option row equals the shared repricing function
 * applied to that engine's own move for the underlying. One function, two
 * callers — the defect class of 2026-09-11 (two option rules on one page)
 * cannot return. Synthetic figures only.
 */
let db: Database.Database;
const STOCK = 1;
const PUT = 2;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const today = todayET();
  const expiry = addDays(today, 90);
  db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
  db.prepare(`INSERT INTO securities (id, symbol, name, security_type, sector) VALUES (?, 'ZZUL', 'Zulu Systems', 'Stock', 'Technology')`).run(STOCK);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'test')`).run(STOCK, today);
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 100, 'h-stock')`).run(STOCK, today);
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
     VALUES (?, 'ZZUL P95', 'ZZUL put', 'Option', 'ZZUL', 95, ?, 'PUT', 100)`,
  ).run(PUT, expiry);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`).run(
    PUT, today, Number(putPrice(100, 95, 90 / 365, 0.04, 0.35).toFixed(4)),
  );
  db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, -2, 'h-put')`).run(PUT, today);
});

function optionInputs() {
  return db
    .prepare(
      `SELECT s.strike_price, s.expiration_date, s.option_type,
              (SELECT close_price FROM prices WHERE security_id = s.id) AS own_price,
              100 AS underlying_price, NULL AS underlying_iv
         FROM securities s WHERE s.id = ?`,
    )
    .get(PUT) as Parameters<typeof repriceOptionUnderShock>[0];
}

describe("both scenario engines price an option through the one shared function", () => {
  it("custom engine", () => {
    const res = computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: -0.3 });
    const stock = res.positionImpacts.find((p) => p.securityId === STOCK)!;
    const put = res.positionImpacts.find((p) => p.securityId === PUT)!;
    const expected = repriceOptionUnderShock(optionInputs(), { underlyingMove: stock.changePercent, riskFreeRate: getRiskFreeRate(db) });
    if (!expected.modelled) throw new Error("fixture must be modelled");
    expect(put.changePercent).toBeCloseTo(expected.changePercent, 10);
    expect(put.estimatedChange).toBeLessThan(0); // short put loses on a drop
  });

  it("every preset", () => {
    for (const preset of PRESET_SCENARIOS) {
      const res = computeScenario(db, preset);
      const stock = res.positionImpacts.find((p) => p.securityId === STOCK)!;
      const put = res.positionImpacts.find((p) => p.securityId === PUT)!;
      const expected = repriceOptionUnderShock(optionInputs(), { underlyingMove: stock.changePercent, riskFreeRate: getRiskFreeRate(db) });
      if (!expected.modelled) throw new Error("fixture must be modelled");
      expect(put.changePercent, preset.id).toBeCloseTo(expected.changePercent, 10);
      expect(res.estimatedChange, preset.id).toBeCloseTo(res.positionImpacts.reduce((s, p) => s + p.estimatedChange, 0), 8);
      expect(res.optionsUnmodelled, preset.id).toEqual({ count: 0, valueShare: 0 });
    }
  });
});
```
If the `securities` or `holdings` inserts fail on a NOT NULL column, copy the column list from `seed()` in `tests/compute/scenarios-custom-option-repricing.test.ts`; do not weaken the assertions. The test assumes the engine gives the option's underlying the same move it gives the stock row. If a preset's subject rule keys on something the option row does not inherit (so the two moves differ by design), assert that preset against the move the engine actually computed for the option's underlying, name the preset in a comment, and report it; do not skip the preset.

- [ ] **Step 2: Write the repo guard**

Create `tests/repo/scenario-option-no-linear-fallback.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex } from "../helpers/source-anchor";

/**
 * The scenario path never estimates an option from a fixed figure (spec
 * 2026-10-06, D4): no linear elasticity, no 2.5 fallback, no 30% volatility
 * default. An option that cannot be priced is unmodelled.
 */
const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("scenario engines reprice options and never fall back to a fixed figure", () => {
  for (const file of ["lib/compute/scenarios.ts", "lib/compute/scenario-recipes.ts"]) {
    it(`${file} calls the shared repricing function and no linear helper`, () => {
      const src = read(file);
      anchorIndex(src, "repriceOptionUnderShock(");
      expect(src).not.toContain("optionElasticity(");
      expect(src).not.toContain("leverUnderlyingMoveByElasticity(");
    });
  }
  it("the repricing module has no volatility or elasticity default", () => {
    const src = read("lib/compute/option-reprice.ts");
    anchorIndex(src, 'reason: "no-volatility"');
    expect(src).not.toContain("DEFAULT_OPTION_ELASTICITY");
    expect(src).not.toMatch(/\?\?\s*0\.30?\b/);
  });
  it("the linear helpers are gone from the shared module", () => {
    const src = read("lib/compute/option-elasticity.ts");
    expect(src).not.toContain("export function optionElasticity");
    expect(src).not.toContain("export function leverUnderlyingMoveByElasticity");
  });
});
```

- [ ] **Step 3: Run both and confirm they fail**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute/scenario-option-engine-parity.test.ts tests/repo/scenario-option-no-linear-fallback.test.ts`
Expected: the `every preset` test and three guard tests FAIL.

- [ ] **Step 4: Wire the preset engine**

In `lib/compute/scenario-recipes.ts`:

1. Imports: from `./option-elasticity` drop `optionElasticity` and `leverUnderlyingMoveByElasticity`, add `OPTION_ROW_SQL`; keep the `DEFAULT_OPTION_ELASTICITY` re-export exactly as it is. Add:
```ts
import {
  repriceOptionUnderShock,
  summarizeUnmodelledOptions,
  type OptionIvSource,
  type OptionUnmodelledReason,
} from "./option-reprice";
```
2. Query: change `WHERE COALESCE(lp.close_price, 0) > 0` to `WHERE (COALESCE(lp.close_price, 0) > 0 OR ${OPTION_ROW_SQL})`.
3. Replace the option block (`if (isOptionSecurityType(pos.security_type)) { const omega = …; changePercent = lever…; }`) with:
```ts
    // Options: the factor/sector math above describes the UNDERLYING's move
    // (factors are inherited via the COALESCE join). Reprice the contract at
    // that shocked underlying — volatility held at today's level for a
    // preset — through the same function the custom engine uses.
    let ivSource: OptionIvSource | undefined;
    let unmodelledReason: OptionUnmodelledReason | undefined;
    if (isOptionSecurityType(pos.security_type)) {
      const repriced = repriceOptionUnderShock(pos, { underlyingMove: changePercent, riskFreeRate });
      if (repriced.modelled) {
        changePercent = repriced.changePercent;
        ivSource = repriced.ivSource;
      } else {
        changePercent = 0;
        unmodelledReason = repriced.reason;
      }
    }
```
4. Add `ivSource, unmodelledReason,` to the returned impact object, and replace the placeholder from Task 2 with `optionsUnmodelled: summarizeUnmodelledOptions(impacts),`.

- [ ] **Step 5: Delete the dead linear helpers**

Run `grep -rn "optionElasticity\|leverUnderlyingMoveByElasticity\|MAX_OPTION_ELASTICITY" lib app workers --include=*.ts --include=*.tsx`. The only hits must be inside `lib/compute/option-elasticity.ts`. Then delete from that file: `MAX_OPTION_ELASTICITY`, `optionElasticity`, `leverUnderlyingMoveByElasticity`, and the now-unused `import { delta } from "./options-greeks";`. Rewrite the file's header comment to say it now holds the option row predicate, the pricing inputs type, the SQL fragments and the exposure fallback constant, and that scenario pricing lives in `option-reprice.ts`. If the grep shows any other production caller, stop and report it instead of deleting.

- [ ] **Step 6: Update the recipe tests**

In `tests/compute/scenario-recipes.test.ts`, find every expectation computed from `optionElasticity` or a literal elasticity (search the file for `elasticity`, `omega`, `2.5`). Replace each with the value from `repriceOptionUnderShock` for that fixture's inputs and the engine's move for the underlying, the same pattern as the parity test. A test asserting only direction (a held put gains on a down shock) stays as written.

- [ ] **Step 7: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/compute tests/repo tests/contracts && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 8: Commit**

```bash
git add tests/compute/scenario-option-engine-parity.test.ts tests/repo/scenario-option-no-linear-fallback.test.ts
git commit -F <message-file> -- lib/compute/scenario-recipes.ts lib/compute/option-elasticity.ts tests/compute tests/repo
```
Message: `feat(scenarios): presets reprice options through the shared function; linear elasticity removed`

---

### Task 4: API accepts the volatility change

**Files:**
- Modify: `app/api/compute/scenarios/route.ts` (POST handler and `buildCustomDescription`)
- Modify: `tests/api/scenarios-route-validation.test.ts`

**Interfaces:**
- Consumes: `ScenarioDefinition.volMove` from Task 2.
- Produces: `POST /api/compute/scenarios` body field `volMove?: number`, volatility points, finite, between −20 and 60 inclusive; 400 otherwise. Exported constants `VOL_MOVE_MIN = -20`, `VOL_MOVE_MAX = 60` in `lib/compute/option-reprice.ts` (the UI in Task 5 reads the same two).

This task can run in parallel with Task 3 (no shared file except the two constants added to `option-reprice.ts`; add them first, in their own commit, if both tasks run at once).

- [ ] **Step 1: Add the range constants**

In `lib/compute/option-reprice.ts`, below `MIN_SHOCKED_VOL`:
```ts
/** Range of the custom scenario's volatility slider, in points (spec §6). */
export const VOL_MOVE_MIN = -20;
export const VOL_MOVE_MAX = 60;
```

- [ ] **Step 2: Write the failing tests**

Read `tests/api/scenarios-route-validation.test.ts` first and follow its existing way of calling the POST handler and mocking `@/lib/db`. Add:

```ts
  it("accepts a volMove inside the range and passes it to the engine", async () => {
    const res = await post({ marketMove: -0.2, volMove: 15 });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.scenario.volMove).toBe(15);
    expect(json.data.scenario.description).toContain("vol +15 pts");
  });

  it("omits volMove from the scenario when it is absent or zero", async () => {
    const res = await post({ marketMove: -0.2, volMove: 0 });
    const json = await res.json();
    expect(json.data.scenario.volMove).toBeUndefined();
    expect(json.data.scenario.description).not.toContain("vol");
  });

  it("rejects a non-finite volMove", async () => {
    for (const bad of ["15", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = await post({ marketMove: -0.2, volMove: bad });
      if (bad === null) {
        expect(res.status).toBe(200); // null means "not set"
        continue;
      }
      expect(res.status, String(bad)).toBe(400);
      expect((await res.json()).error).toMatch(/volMove/);
    }
  });

  it("rejects a volMove outside the slider range", async () => {
    for (const bad of [-21, 61, 500]) {
      const res = await post({ marketMove: -0.2, volMove: bad });
      expect(res.status, String(bad)).toBe(400);
    }
  });
```
`post` stands for whatever helper the file already uses; if it has none, write `const post = (body: unknown) => POST(new NextRequest("http://localhost/api/compute/scenarios", { method: "POST", body: JSON.stringify(body) }))`. `NaN` and `Infinity` do not survive `JSON.stringify` (they become `null`); send those two as raw text bodies (`'{"marketMove":-0.2,"volMove":1e999}'`) or drop them from the loop and keep the string case, and note which you did.

- [ ] **Step 3: Run and confirm failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/api/scenarios-route-validation.test.ts`
Expected: the four new tests FAIL.

- [ ] **Step 4: Implement**

In `app/api/compute/scenarios/route.ts`:

1. Import `VOL_MOVE_MIN, VOL_MOVE_MAX` from `@/lib/compute/option-reprice`.
2. Add `volMove` to the destructured body and its type (`volMove?: number;`), and to the doc comment (`volMove?: number (volatility points, -20 to 60) — option repricing only`).
3. After the `rateMove` check:
```ts
    if (volMove != null) {
      if (typeof volMove !== "number" || !Number.isFinite(volMove)) {
        return NextResponse.json(
          { success: false, error: "volMove must be a finite number (volatility points)" },
          { status: 400 }
        );
      }
      if (volMove < VOL_MOVE_MIN || volMove > VOL_MOVE_MAX) {
        return NextResponse.json(
          { success: false, error: `volMove must be between ${VOL_MOVE_MIN} and ${VOL_MOVE_MAX} points` },
          { status: 400 }
        );
      }
    }
```
4. In the `scenario` object add `volMove: volMove || undefined,` and pass `volMove` to `buildCustomDescription(marketMove, rateMove, sectorMoves, volMove)`.
5. In `buildCustomDescription` add the fourth parameter `volMove?: number` and, after the rates line: `if (volMove) parts.push(`vol ${volMove > 0 ? "+" : ""}${volMove} pts`);`

- [ ] **Step 5: Run the tests**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/api/scenarios-route-validation.test.ts && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git commit -F <message-file> -- app/api/compute/scenarios/route.ts lib/compute/option-reprice.ts tests/api/scenarios-route-validation.test.ts
```
Message: `feat(scenarios): custom scenario API takes a volatility change in points`

---

### Task 5: The scenario card

**Files:**
- Modify: `app/dashboard/components/ScenarioModeling.tsx`
- Create: `tests/dashboard/scenario-option-repricing-ui.test.ts`
- Check and update if they pin changed text: `tests/dashboard/scenario-custom-result-invalidation.test.ts`, `tests/dashboard/overnight-ui-batch-a.test.ts`, `tests/contracts/api-component-contracts.test.ts`

**Interfaces:**
- Consumes: `ScenarioResult.optionsUnmodelled`, `PositionImpact.ivSource` / `unmodelledReason`, `VOL_MOVE_MIN` / `VOL_MOVE_MAX`, the API's `volMove` body field.
- Produces: nothing other tasks use.

This repo has no DOM test harness. UI tests are source-pin tests that read the component file; behaviour is proven in the browser in Task 6.

- [ ] **Step 1: Write the source-pin test**

Create `tests/dashboard/scenario-option-repricing-ui.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const src = readFileSync(join(__dirname, "../../app/dashboard/components/ScenarioModeling.tsx"), "utf8");

describe("scenario card: option repricing surface", () => {
  it("has a volatility slider bound to the shared range and sends it", () => {
    const builder = sliceBetween(src, "{/* Volatility change */}", "{/* Sector overrides */}");
    anchorIndex(builder, "min={VOL_MOVE_MIN}");
    anchorIndex(builder, "max={VOL_MOVE_MAX}");
    anchorIndex(builder, "setCustomVolMove(Number(e.target.value))");
    anchorIndex(src, "volMove: customVolMove || undefined");
    // The compute callback must re-read the slider (stale-closure guard).
    anchorIndex(src, "[customMarketMove, customRateMove, customVolMove, customSectorOverrides, scope]");
  });

  it("names the held-fixed assumptions and the preset volatility rule", () => {
    anchorIndex(src, "Options are repriced at the shocked price of their underlying");
    anchorIndex(src, "option volatility held at today");
  });

  it("lists options it could not model, with a reason, and a count line", () => {
    anchorIndex(src, "result.optionsUnmodelled.count > 0");
    anchorIndex(src, "UNMODELLED_REASON_LABEL[");
    for (const reason of ["no-option-terms", "expired", "no-option-price", "no-underlying-price", "no-volatility"]) {
      anchorIndex(src, `"${reason}":`);
    }
  });

  it("an option row shows its volatility source and no beta", () => {
    anchorIndex(src, "IV_SOURCE_LABEL[");
    expect(src).not.toContain("option elasticity");
    expect(src).not.toContain("legacy beta heuristic");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard/scenario-option-repricing-ui.test.ts`
Expected: FAIL, anchors not found.

- [ ] **Step 3: Labels and helpers (top of the file)**

Add the import `import { VOL_MOVE_MIN, VOL_MOVE_MAX, type OptionIvSource, type OptionUnmodelledReason } from "@/lib/compute/option-reprice";`.

Replace the `betaTooltip` function and its comment with:

```tsx
// An option row carries no beta: its move comes from repricing the contract
// at the shocked underlying, so the row names where its volatility came from.
const IV_SOURCE_LABEL: Record<OptionIvSource, string> = {
  "own-price": "vol from its price",
  "broker-underlying": "vol from IBKR",
};
const IV_SOURCE_TITLE: Record<OptionIvSource, string> = {
  "own-price": "Volatility solved from this contract's own last price.",
  "broker-underlying": "This contract's price gave no usable volatility, so IBKR's figure for the underlying was used.",
};
const UNMODELLED_REASON_LABEL: Record<OptionUnmodelledReason, string> = {
  "no-option-terms": "strike, expiry or type missing",
  "expired": "expired",
  "no-option-price": "no price for the contract",
  "no-underlying-price": "no price for the underlying",
  "no-volatility": "no usable volatility",
};
const BETA_TITLE = "Beta vs the market: 1.0 moves with the index.";
```

- [ ] **Step 4: State and request**

Next to `customRateMove`: `const [customVolMove, setCustomVolMove] = useState(0);`. In the POST body add `volMove: customVolMove || undefined,` after `rateMove`. Change the `useCallback` dependency array to `[customMarketMove, customRateMove, customVolMove, customSectorOverrides, scope]`.

- [ ] **Step 5: The slider**

Between the Rate move block and `{/* Sector overrides */}` insert:

```tsx
            {/* Volatility change */}
            <div>
              <label className="text-[10px] text-ink-faint uppercase tracking-wider block mb-1">
                Volatility Change (points, options only)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={VOL_MOVE_MIN}
                  max={VOL_MOVE_MAX}
                  step={1}
                  value={customVolMove}
                  onChange={(e) => setCustomVolMove(Number(e.target.value))}
                  aria-label="Volatility change in points"
                  className="flex-1 accent-gold"
                />
                <span className="font-mono text-sm tabular-nums w-14 text-right text-ink">
                  {customVolMove > 0 ? "+" : ""}{customVolMove}
                </span>
              </div>
              <p className="text-[11px] text-ink-faint mt-1">
                Added to each option&apos;s own implied volatility. 0 keeps volatility at today&apos;s level.
              </p>
            </div>
```

- [ ] **Step 6: Row chips in both Most Impacted lists**

In BOTH the losers and the winners list, replace the `{!findRecipe(result.scenario.id) && ( <span … title={betaTooltip(pos.securityType)}> β… </span> )}` block with:

```tsx
                              {pos.ivSource ? (
                                <span
                                  className="text-ink-faint text-[10px] shrink-0 whitespace-nowrap"
                                  title={IV_SOURCE_TITLE[pos.ivSource]}
                                >
                                  {IV_SOURCE_LABEL[pos.ivSource]}
                                </span>
                              ) : (
                                !findRecipe(result.scenario.id) &&
                                !isOptionSecurityType(pos.securityType) && (
                                  <span className="text-ink-faint text-[10px] shrink-0" title={BETA_TITLE}>
                                    {"β"}{pos.beta.toFixed(1)}
                                  </span>
                                )
                              )}
```
Keep the existing comment about recipe scenarios above it.

- [ ] **Step 7: The unmodelled list and the caption**

Inside the expanded card body, directly after the winners list block, add:

```tsx
                  {/* Options the scenario could not reprice: no figure is
                      estimated for them, so they are listed, not hidden. */}
                  {result.optionsUnmodelled.count > 0 && (
                    <div>
                      <h4 className="text-[10px] text-ink-faint uppercase tracking-wider mb-1.5">
                        Options Not Modelled
                      </h4>
                      <p className="text-xs text-ink-dim mb-1.5">
                        <PrivateText>
                          {result.optionsUnmodelled.count}{" "}
                          {result.optionsUnmodelled.count === 1 ? "option" : "options"} (
                          {(result.optionsUnmodelled.valueShare * 100).toFixed(0)}% of option value)
                        </PrivateText>{" "}
                        left out of this total. No figure is estimated for them.
                      </p>
                      <div className="space-y-1">
                        {result.positionImpacts
                          .filter((pos) => pos.unmodelledReason)
                          .map((pos) => (
                            <div key={pos.securityId} className="flex items-center justify-between gap-3 text-xs">
                              <span className="font-mono font-medium text-ink truncate whitespace-nowrap">
                                {formatCompactOptionSymbol(pos.symbol)}
                              </span>
                              <span className="text-ink-faint shrink-0">
                                {UNMODELLED_REASON_LABEL[pos.unmodelledReason!]}
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}

                  {result.positionImpacts.some((pos) => isOptionSecurityType(pos.securityType)) && (
                    <p className="text-[11px] text-ink-faint leading-relaxed">
                      Options are repriced at the shocked price of their underlying (Black-Scholes, never below
                      exercise value). Held fixed: time to expiry, the interest rate, dividends.
                      {findRecipe(result.scenario.id)
                        ? " Preset scenarios keep option volatility held at today’s level."
                        : " Volatility moves only by the amount you set."}
                    </p>
                  )}
```
The position count is portfolio-derived, which is why it sits inside `<PrivateText>`.

- [ ] **Step 8: Fix the card's intro sentence**

Replace `Custom what-if scenarios use the legacy beta heuristic.` with `Custom what-if scenarios use a market beta per position. Options are repriced in every scenario.`

- [ ] **Step 9: Run tests, lint and type-check**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run tests/dashboard tests/contracts && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit && PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint app/dashboard/components/ScenarioModeling.tsx`
Expected: PASS; no type errors; no NEW lint errors. To get the baseline without stashing, write `git show HEAD:app/dashboard/components/ScenarioModeling.tsx` to a temp file inside `app/dashboard/components/`, lint it with the same command, then delete that temp file by absolute path. If an older test pins the removed `betaTooltip` text or the "legacy beta heuristic" sentence, update the pin to the new text.

- [ ] **Step 10: Commit**

```bash
git add tests/dashboard/scenario-option-repricing-ui.test.ts
git commit -F <message-file> -- app/dashboard/components/ScenarioModeling.tsx tests/dashboard tests/contracts
```
Message: `feat(scenarios): volatility slider, per-option volatility source, and a not-modelled list`

---

### Task 6: Verification on real data, docs, landing gate

**Files:**
- Create: `scripts/compare-scenario-option-repricing.ts` (read-only; prints direction-only output)
- Modify: `docs/reference/conventions-detail.md`, `docs/plans/TODO.md`, `docs/DECISIONS.md`
- Local, gitignored: `qa/findings/ledger.json`

**Interfaces:**
- Consumes: everything above.
- Produces: the evidence the user needs before deploy (spec §9).

This task is run by the controlling session, not delegated: it touches the sandbox, the browser lock and the ledger.

- [ ] **Step 1: Build**

Run: `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit && PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run -s build`
Expected: both exit 0.

- [ ] **Step 2: Before/after on a database copy (read-only)**

Create `scripts/compare-scenario-option-repricing.ts`. It opens the database at `process.argv[2]` with `{ readonly: true }`, runs `computeAllScenarios(db)` and one custom scenario (`marketMove: -0.3`), and prints, per scenario: the count of option rows, the count modelled by each source, the count unmodelled by reason, and for option rows only the NUMBER of rows whose dollar change has each sign. It prints no dollar amount, no percentage of the book and no symbol. Run it from the repo root against the sandbox copy, once on `main` (`git worktree` at `main`, or before Task 2 lands) and once on the branch tip:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/compare-scenario-option-repricing.ts <path-to-sandbox>/vanguard.db
```
Expected on the branch: every live option row is either modelled or carries a reason; the unmodelled count matches the options whose underlying has no price; no row is `NaN`. Report the comparison to the user in words (how many options are repriced, how many are not and why, and that preset totals move) before any deploy.

- [ ] **Step 3: Sandbox, smoke, browser proof**

```bash
PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH npm run sandbox -- up --task <task-id>
PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH npm run smoke -- --task <task-id>
```
Then in a browser on the sandbox (set the `vgs_session` and `vgs_csrf` cookies from the sandbox's `session.env`), on `/dashboard/analysis?view=diagnostics`:
1. Open Build Custom Scenario. The Volatility Change slider is there, reads 0, and moves between −20 and +60.
2. Compute market −30%, slider 0. Expand the card. An account holding a short put shows that contract among the losers with a `vol from its price` or `vol from IBKR` chip and no β. The Options Not Modelled list appears if any option lacks a price.
3. Compute the same with the slider at +20. Option rows change; a stock row's figure does not.
4. Expand one preset card: the caption ends "keep option volatility held at today's level".
5. At 390px width the builder and the lists do not overflow sideways.
6. Toggle privacy mode: the figures and the unmodelled count are masked.

Take the sandbox down before the full suite: `npm run sandbox -- down --task <task-id>`.

- [ ] **Step 4: Docs**

- `docs/reference/conventions-detail.md`: in the valuation / analysis section add one paragraph: scenario option legs are priced by `repriceOptionUnderShock` (`lib/compute/option-reprice.ts`); both engines call it; an unpriceable option is unmodelled and counted; never reintroduce a fixed elasticity or volatility default on that path; `tests/repo/scenario-option-no-linear-fallback.test.ts` guards it.
- `docs/DECISIONS.md`: a dated entry recording the landing and anything the build decided that the spec did not.
- `docs/plans/TODO.md`: mark the scenario repricing item shipped with the commit id, and file any follow-up found.
- `qa/findings/ledger.json` (back it up first): for `analysis-scenarios--custom-scenario-prices-short-put-linearly-understates-large-drop-loss` and `analysis-scenarios--unpriced-option-hedges-omitted-while-greeks-counts-them-no-disclosure`, set `status: "fixed"`, `fixed_date`, `fix_commit` (the real commit id on `main`, read from `git log`), `fix_status: "merged"`.

- [ ] **Step 5: Full suite**

Commit the docs first (the runner's evidence binds the working tree), then:
```bash
PATH=/opt/homebrew/opt/node@24/bin:/usr/sbin:$PATH bash scripts/verify.sh full --base main
```
Expected: `verify: result=passed`, zero failed. Report the test count.

- [ ] **Step 6: Review, then land**

Dispatch one read-only whole-branch review (the diff `main...<branch>`, the spec and this plan as its brief). Fix every Important finding. Land under the integration lock (`npm run coord -- lock run integration --task <task-id> -- git merge --ff-only <branch>`), push, and deploy only through `npm run deploy` and only when the user has said to deploy.

---

## Task order

`1 → 2 → 3` are chained (each needs the previous one's types). Task 4 needs Task 2 and shares no file with Task 3 beyond two constants, so 3 and 4 can run as parallel subagents once those constants are committed. Task 5 needs 2, 3 and 4. Task 6 is last and is run by the controlling session.

## Self-review notes

- Spec §4 steps 1–5 → Task 1. D1 → Task 1 (`ivSource`). D2 → Tasks 2, 4, 5. D3 → Tasks 2, 3 and the parity test. D4 → Tasks 1, 2, 3, 5. §5 held-fixed caption → Task 5 Step 7. §6 code shape → Tasks 1–5. §7 beta label → Task 5 Step 6. §8 tests 1–9 → Task 1 (1, 2, 3, 4, 8, 9), Task 2 (6, 7), Task 3 (5, 6). §9 → Task 6.
- The spec was amended while planning, in three places: the `no-option-price` reason; the dollar change stated as `market_value × ΔV ÷ own_price`; and required test 2, whose first wording (loss at least the rise in exercise value) was not a true bound because it ignored the premium already in today's price. The corrected invariant is `V1 ≥ intrinsic(S')`.
