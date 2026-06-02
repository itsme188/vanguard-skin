# Significant Moves — Residual Z-Score + Magnitude Floor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat-day-over-firing `max(2x|expected|, 1.0)` anomaly threshold with a hybrid gate — a move must be both >=3% in raw terms AND >=2 standard deviations of the stock's own beta-residual noise — across the Mac engine, the Today-tab card, and the Worker cloud fallback.

**Architecture:** Persist a `residual_std` statistic (already computed-then-discarded inside the nightly beta regression) on `security_betas`. The anomaly engine reads it and applies the two-gate test. Missing `residual_std` degrades gracefully to the 3% floor alone. The Worker's ported copy + the R2 snapshot are updated in lockstep, guarded by a parity test.

**Tech Stack:** TypeScript, better-sqlite3 (SQLite, in-memory for tests), Vitest, Cloudflare Workers (separate Vitest project under `workers/cron/`).

**Spec:** `docs/superpowers/specs/2026-06-01-significant-moves-residual-zscore-design.md`

**Constants (single source, defined in Task 4, mirrored in Task 7):**
```
MIN_ABS_MOVE_PCT     = 3.0   // magnitude floor (percent)
MIN_RESIDUAL_Z       = 2.0   // statistical-rarity gate (std-devs)
RESIDUAL_STD_EPSILON = 0.1   // percent; at/below this, skip z-gate (treat residual_std as unavailable)
```

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `lib/db/migrations/056_security_betas_residual_std.sql` | add nullable `residual_std` column | Create |
| `lib/mutations/security-betas.ts` | `UpsertBetaInput` + insert carry `residualStd` | Modify |
| `scripts/refresh-vanguard-betas.ts` | regression returns `{beta, residualStd}`; persist it | Modify |
| `lib/digest/anomalies.ts` | two-gate test, read `residual_std`, `ratio`->`zScore`, constants, drop email cap | Modify |
| `app/dashboard/today/SignificantMovesCard.tsx` | chip -> sigma, EmptySection hint copy | Modify |
| `scripts/snapshot-state-to-r2.ts` | `getSecurityBetas` selects `residual_std` | Modify |
| `workers/cron/src/state.ts` | `Snapshot.securityBetas[]` type gains `residualStd?` | Modify |
| `workers/cron/src/fallback-evening.ts` | port two-gate logic, mirror constants, drop cap | Modify |
| `tests/digest/anomalies.test.ts` | rewrite for new logic + degraded mode + sort | Modify |
| `workers/cron/test/fallback-evening.test.ts` | new-logic coverage + parity intent | Modify |

---

## Task 1: Migration — add `residual_std` column

**Files:**
- Create: `lib/db/migrations/056_security_betas_residual_std.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Adds the residual standard deviation (idiosyncratic daily volatility) of each
-- security's beta regression vs SPY. Stored in PERCENT units (decimal std x 100)
-- so the anomaly engine can compare it directly against simple-percent daily moves.
--
-- This is the standard deviation of the regression residuals — the part of a
-- daily move NOT explained by beta x SPY — and is the basis for the z-score
-- "out-of-the-ordinary" test in lib/digest/anomalies.ts. Nullable so existing
-- rows survive until the next nightly refresh-vanguard-betas run backfills them.

ALTER TABLE security_betas ADD COLUMN residual_std REAL;
```

- [ ] **Step 2: Verify the migration applies cleanly**

Run: `npx vitest run tests/digest/anomalies.test.ts -t "returns \[\] when SPY"`
Expected: The existing test still runs (migrations execute in `beforeEach` without error). It may FAIL on assertions later — that's fine; we only care the migration itself doesn't throw a SQL error here.

- [ ] **Step 3: Commit**

```bash
git add lib/db/migrations/056_security_betas_residual_std.sql
git commit -m "feat(db): migration 056 — add residual_std to security_betas"
```

---

## Task 2: Mutation — carry `residualStd` through `upsertBeta`

**Files:**
- Modify: `lib/mutations/security-betas.ts`
- Test: `tests/digest/anomalies.test.ts` (the `seedBeta` helper, updated in Task 4)

- [ ] **Step 1: Update `UpsertBetaInput` and the insert**

Replace the `UpsertBetaInput` interface and `upsertBeta` body in `lib/mutations/security-betas.ts` with:

```typescript
export interface UpsertBetaInput {
  securityId: number;
  lookbackDays: number;
  beta: number;
  /** Residual std-dev of the regression, in PERCENT units. Optional for
   *  callers that only have beta (degraded mode); stored as NULL when absent. */
  residualStd?: number | null;
}

/**
 * Insert or update a beta value (and optional residual std-dev) for a given
 * security and lookback window.
 *
 * The (security_id, lookback_days) pair is unique — updating via ON CONFLICT
 * ensures exactly one row exists per pair. `computed_at` is set automatically.
 */
export function upsertBeta(db: Database.Database, input: UpsertBetaInput): void {
  db.prepare(
    `INSERT INTO security_betas (security_id, lookback_days, beta, residual_std, computed_at)
       VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(security_id, lookback_days) DO UPDATE SET
       beta = excluded.beta,
       residual_std = excluded.residual_std,
       computed_at = excluded.computed_at`,
  ).run(
    input.securityId,
    input.lookbackDays,
    input.beta,
    input.residualStd ?? null,
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "security-betas" || echo "no security-betas type errors"`
Expected: `no security-betas type errors`

- [ ] **Step 3: Commit**

```bash
git add lib/mutations/security-betas.ts
git commit -m "feat(betas): upsertBeta carries optional residualStd"
```

---

## Task 3: Nightly regression — compute and persist `residualStd`

**Files:**
- Modify: `scripts/refresh-vanguard-betas.ts:52-100` (the `computeBeta` helper) and its single caller at `scripts/refresh-vanguard-betas.ts:203-211`

- [ ] **Step 1: Change `computeBeta` to return beta + residual std**

Replace the entire `computeBeta` function (currently returns `number | null`) with:

```typescript
interface BetaResult {
  beta: number;
  /** Residual std-dev of the regression, in PERCENT units (decimal x 100). */
  residualStdPct: number;
}

/**
 * Compute beta = cov(stock_returns, spy_returns) / var(spy_returns) using log
 * daily returns on the aligned date pairs, plus the residual standard deviation
 * (idiosyncratic daily volatility) of that regression.
 *
 * residual_i = (sLog_i - meanS) - beta x (bLog_i - meanB)
 * residualStd = sqrt( sum residual_i^2 / (n - 2) )   [n-2 = regression dof]
 * Returned in PERCENT units so the anomaly engine compares it directly to
 * simple-percent daily moves.
 *
 * Returns null when there are insufficient aligned data points.
 */
function computeBeta(
  stockPrices: Map<string, number>,
  spyPrices: Map<string, number>
): BetaResult | null {
  const dates = [...stockPrices.keys()]
    .filter((d) => spyPrices.has(d))
    .sort();

  if (dates.length < MIN_DATA_POINTS + 1) return null;

  const stockReturns: number[] = [];
  const spyReturns: number[] = [];

  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1];
    const curr = dates[i];

    const sPrev = stockPrices.get(prev)!;
    const sCurr = stockPrices.get(curr)!;
    const bPrev = spyPrices.get(prev)!;
    const bCurr = spyPrices.get(curr)!;

    if (sPrev > 0 && sCurr > 0 && bPrev > 0 && bCurr > 0) {
      stockReturns.push(Math.log(sCurr / sPrev));
      spyReturns.push(Math.log(bCurr / bPrev));
    }
  }

  if (stockReturns.length < MIN_DATA_POINTS) return null;

  const n = stockReturns.length;
  const meanS = stockReturns.reduce((s, v) => s + v, 0) / n;
  const meanB = spyReturns.reduce((s, v) => s + v, 0) / n;

  let covSB = 0;
  let varB = 0;

  for (let i = 0; i < n; i++) {
    const dS = stockReturns[i] - meanS;
    const dB = spyReturns[i] - meanB;
    covSB += dS * dB;
    varB += dB * dB;
  }

  if (varB === 0) return null;

  const beta = covSB / varB;

  // Residual (idiosyncratic) std-dev around the regression line.
  let residSumSq = 0;
  for (let i = 0; i < n; i++) {
    const resid = (stockReturns[i] - meanS) - beta * (spyReturns[i] - meanB);
    residSumSq += resid * resid;
  }
  const dof = n - 2;
  const residualStd = dof > 0 ? Math.sqrt(residSumSq / dof) : 0; // decimal log-return
  const residualStdPct = residualStd * 100;

  return { beta, residualStdPct };
}
```

- [ ] **Step 2: Update the caller to persist residualStd**

In the per-security loop (around `scripts/refresh-vanguard-betas.ts:203-211`), replace:

```typescript
      const beta = computeBeta(stockPrices, spyPrices);

      if (beta === null) {
        // Insufficient aligned data after matching with SPY dates
        result.skipped.push(sec.symbol);
        continue;
      }

      upsertBeta(db, { securityId: sec.id, lookbackDays: LOOKBACK_DAYS, beta });
      result.computed++;
```

with:

```typescript
      const regression = computeBeta(stockPrices, spyPrices);

      if (regression === null) {
        // Insufficient aligned data after matching with SPY dates
        result.skipped.push(sec.symbol);
        continue;
      }

      upsertBeta(db, {
        securityId: sec.id,
        lookbackDays: LOOKBACK_DAYS,
        beta: regression.beta,
        residualStd: regression.residualStdPct,
      });
      result.computed++;
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "refresh-vanguard-betas" || echo "no refresh-vanguard-betas type errors"`
Expected: `no refresh-vanguard-betas type errors`

- [ ] **Step 4: Commit**

```bash
git add scripts/refresh-vanguard-betas.ts
git commit -m "feat(betas): nightly regression persists residual std-dev"
```

---

## Task 4: Anomaly engine — hybrid two-gate test (TDD)

This is the core change. We write the new tests first (replacing the old-threshold tests), watch them fail, then implement.

**Files:**
- Modify: `tests/digest/anomalies.test.ts`
- Modify: `lib/digest/anomalies.ts`

- [ ] **Step 1: Update the test `seedBeta` helper to carry residualStd**

In `tests/digest/anomalies.test.ts`, replace the `seedBeta` helper:

```typescript
function seedBeta(securityId: number, beta: number, residualStd?: number): void {
  upsertBeta(db, { securityId, lookbackDays: 60, beta, residualStd });
}
```

- [ ] **Step 2: Replace the old-threshold tests with new-logic tests**

Delete the existing `it("flags GOOG (-3.4%) and TER (+5.1%) but NOT NVDA (+1.0%) ...")` test and any other test that asserts the old `max(2x|expected|, 1.0)` behavior. Add this block inside the `describe("computeAnomalies", ...)`:

```typescript
  it("does NOT flag an ordinary 1% wiggle on a flat market day", () => {
    seedSpy(530, 530 * 1.001); // SPY +0.1% (flat)
    const acctId = seedAccount("Vanguard Brokerage");

    // ACME +1.0%, beta 1.2, residualStd 1.5% -> fails the 3% magnitude floor.
    const id = seedSecurity("ACME");
    seedHolding(acctId, id);
    seedPrice(id, "2026-05-07", 100);
    seedPrice(id, "2026-05-08", 101.0); // +1.0%
    seedBeta(id, 1.2, 1.5);

    expect(computeAnomalies(db).map((f) => f.symbol)).not.toContain("ACME");
  });

  it("flags a quiet fund that jumps 3% on a flat day (large z for a low-vol name)", () => {
    seedSpy(530, 530 * 1.001); // SPY +0.1%
    const acctId = seedAccount("Vanguard Brokerage");

    // QFND +3.2%, beta 0.3, residualStd 0.5% -> expected ~ 0.03%, residual ~ 3.17%,
    // z ~ 6.3 (>=2) AND |move| 3.2% >= 3% -> flagged.
    const id = seedSecurity("QFND");
    seedHolding(acctId, id);
    seedPrice(id, "2026-05-07", 100);
    seedPrice(id, "2026-05-08", 103.2); // +3.2%
    seedBeta(id, 0.3, 0.5);

    expect(computeAnomalies(db).map((f) => f.symbol)).toContain("QFND");
  });

  it("does NOT flag a volatile name moving 3% (within its own normal noise)", () => {
    seedSpy(530, 530 * 1.001); // SPY +0.1%
    const acctId = seedAccount("Vanguard Brokerage");

    // VOLA +3.1%, beta 1.5, residualStd 2.5% -> expected ~ 0.15%, residual ~ 2.95%,
    // z ~ 1.18 (<2) -> NOT flagged even though |move| >= 3%.
    const id = seedSecurity("VOLA");
    seedHolding(acctId, id);
    seedPrice(id, "2026-05-07", 100);
    seedPrice(id, "2026-05-08", 103.1); // +3.1%
    seedBeta(id, 1.5, 2.5);

    expect(computeAnomalies(db).map((f) => f.symbol)).not.toContain("VOLA");
  });

  it("degraded mode: with null residual_std, enforces only the 3% floor", () => {
    seedSpy(530, 530 * 1.001);
    const acctId = seedAccount("Vanguard Brokerage");

    // No residualStd seeded -> z-gate skipped. 3.5% >= 3% -> flagged; 2% < 3% -> not.
    const big = seedSecurity("BIG");
    seedHolding(acctId, big);
    seedPrice(big, "2026-05-07", 100);
    seedPrice(big, "2026-05-08", 103.5); // +3.5%
    seedBeta(big, 1.0); // residualStd omitted -> NULL

    const small = seedSecurity("SML");
    seedHolding(acctId, small);
    seedPrice(small, "2026-05-07", 100);
    seedPrice(small, "2026-05-08", 102.0); // +2.0%
    seedBeta(small, 1.0); // residualStd omitted -> NULL

    const symbols = computeAnomalies(db).map((f) => f.symbol);
    expect(symbols).toContain("BIG");
    expect(symbols).not.toContain("SML");
  });

  it("exposes zScore and sorts by it descending", () => {
    seedSpy(530, 530 * 1.001);
    const acctId = seedAccount("Vanguard Brokerage");

    // HIGHZ: +4% move, residualStd 0.5% -> z ~ 8.
    const hi = seedSecurity("HIGHZ");
    seedHolding(acctId, hi);
    seedPrice(hi, "2026-05-07", 100);
    seedPrice(hi, "2026-05-08", 104.0);
    seedBeta(hi, 0.5, 0.5);

    // LOWZ: +3.1% move, residualStd 1.2% -> z ~ 2.5.
    const lo = seedSecurity("LOWZ");
    seedHolding(acctId, lo);
    seedPrice(lo, "2026-05-07", 100);
    seedPrice(lo, "2026-05-08", 103.1);
    seedBeta(lo, 0.5, 1.2);

    const flags = computeAnomalies(db);
    expect(flags[0].symbol).toBe("HIGHZ");
    expect(flags[0].zScore).not.toBeNull();
    expect(flags[0].zScore! > flags[1].zScore!).toBe(true);
  });
```

Also review the remaining pre-existing tests in the file (e.g. the consecutive-trading-day-pair tests, phantom-row-ignored, stale-skipped). Those exercise `resolveTradingDayPair`, which is UNCHANGED — leave them, but if any seed a move <3% and expect a flag, update the move to >=3% and add a `residualStd` small enough to clear z>=2 (e.g. `seedBeta(id, 1.0, 0.5)`), preserving the test's original intent.

- [ ] **Step 3: Run the new tests — verify they FAIL**

Run: `npx vitest run tests/digest/anomalies.test.ts`
Expected: FAIL — the new tests fail because `anomalies.ts` still uses the old threshold and `AnomalyFlag` has no `zScore` field (TS error or assertion failure).

- [ ] **Step 4: Update `AnomalyFlag` and the engine**

In `lib/digest/anomalies.ts`, update the `AnomalyFlag` interface — replace `thresholdPct` and `ratio` with `zScore`:

```typescript
export interface AnomalyFlag {
  securityId: number;
  symbol: string;
  companyName: string | null;
  actualPct: number;    // today's % move
  spyPct: number;       // SPY's % move today
  beta: number;
  expectedPct: number;  // spyPct x beta
  residualPct: number;  // actualPct - expectedPct (move the market doesn't explain)
  zScore: number | null; // |residualPct| / residualStd; null in degraded mode
  directionFlipped: boolean;
}
```

Add the constants near the top of the file (after imports):

```typescript
// --- Trigger constants ---
// A move is "out of the ordinary" only if it is BOTH large in raw terms AND
// statistically rare for that specific security. See design doc 2026-06-01.
const MIN_ABS_MOVE_PCT = 3.0;     // magnitude floor (percent)
const MIN_RESIDUAL_Z = 2.0;       // std-devs of the stock's own residual noise
const RESIDUAL_STD_EPSILON = 0.1; // percent; at/below this, skip the z-gate
```

Add `residual_std` to `HeldSecurityRow`:

```typescript
interface HeldSecurityRow {
  security_id: number;
  symbol: string;
  name: string | null;
  today_close: number;
  prior_close: number;
  beta: number | null;
  residual_std: number | null;
}
```

In the held-securities query, add the column to the SELECT (it already LEFT JOINs `security_betas sb` on `lookback_days = 60`):

```typescript
              sb.beta,
              sb.residual_std
```
(replace the bare `sb.beta` line with these two lines).

Replace the per-row flag loop (from `const actualPct = ...` through the `flags.push({...})`) with:

```typescript
    const actualPct = ((row.today_close - row.prior_close) / row.prior_close) * 100;
    const expectedPct = spyPct * row.beta;
    const residualPct = actualPct - expectedPct;

    // Gate 1: magnitude floor — always enforced.
    if (Math.abs(actualPct) < MIN_ABS_MOVE_PCT) continue;

    // Gate 2: statistical rarity — enforced only when residual_std is usable.
    // Degraded mode (null/tiny residual_std) falls through on the floor alone.
    let zScore: number | null = null;
    if (row.residual_std != null && row.residual_std > RESIDUAL_STD_EPSILON) {
      zScore = Math.abs(residualPct) / row.residual_std;
      if (zScore < MIN_RESIDUAL_Z) continue;
    }

    const directionFlipped =
      Math.abs(expectedPct) > 0.1 &&
      Math.sign(actualPct) !== 0 &&
      Math.sign(expectedPct) !== 0 &&
      Math.sign(actualPct) !== Math.sign(expectedPct);

    flags.push({
      securityId: row.security_id,
      symbol: row.symbol,
      companyName: row.name,
      actualPct,
      spyPct,
      beta: row.beta,
      expectedPct,
      residualPct,
      zScore,
      directionFlipped,
    });
```

Replace the sort (degraded flags with null z sort by magnitude relative to the floor, after real z-scored flags):

```typescript
  // Sort by z-score desc (most statistically extreme first). Degraded flags
  // (null z) rank by how far they cleared the magnitude floor.
  const sortKey = (f: AnomalyFlag): number =>
    f.zScore ?? Math.abs(f.actualPct) / MIN_ABS_MOVE_PCT;
  flags.sort((a, b) => sortKey(b) - sortKey(a));

  return flags;
```

- [ ] **Step 5: Update `formatVanguardAnomaliesBlock` — drop the cap, use sigma**

Replace the body of `formatVanguardAnomaliesBlock` (from `const allFlags = ...` to `return lines.join("\n");`) with:

```typescript
  const flags = computeAnomalies(db);
  if (flags.length === 0) return "";

  const lines: string[] = [
    "## Significant Moves in Vanguard Holdings (vs. expected)",
    "",
  ];

  for (const flag of flags) {
    const signedActual = signedPct(flag.actualPct);
    const signedExpected = signedPct(flag.expectedPct);
    const signedSpy = signedPct(flag.spyPct);
    const reason = flag.directionFlipped
      ? "Direction flipped."
      : flag.zScore != null
        ? `${flag.zScore.toFixed(1)}σ move.`
        : `${signedActual} move.`;

    lines.push(
      `- **${flag.symbol}** ${signedActual} — expected ${signedExpected} (beta ${flag.beta.toFixed(1)} × SPY ${signedSpy}). ${reason}`
    );
  }

  lines.push("");

  return lines.join("\n");
```

If `formatVanguardAnomaliesBlock` is the only user of the now-unused `MAX_DISPLAY` constant, ensure no stray references remain (search the file for `MAX_DISPLAY` and `extras` and delete leftovers).

- [ ] **Step 6: Run the tests — verify they PASS**

Run: `npx vitest run tests/digest/anomalies.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 7: Typecheck the whole project for fallout**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -iE "anomalies|ratio|thresholdPct" || echo "no anomalies-related type errors"`
Expected: `no anomalies-related type errors` (this catches any other consumer that referenced `flag.ratio`/`flag.thresholdPct` — only the card in Task 5, which we fix next).

- [ ] **Step 8: Commit**

```bash
git add lib/digest/anomalies.ts tests/digest/anomalies.test.ts
git commit -m "feat(anomalies): hybrid 3%+2sigma residual-zscore gate; show all flags"
```

---

## Task 5: Today-tab card — sigma chip + hint copy

**Files:**
- Modify: `app/dashboard/today/SignificantMovesCard.tsx`

- [ ] **Step 1: Update the chip and EmptySection hint**

Replace the `EmptySection` `hint` prop value with:

```tsx
        hint="A name is flagged when its daily move is at least 3% AND at least 2 standard deviations beyond that stock's own normal day-to-day noise (after adjusting for SPY). Needs cached betas, a residual volatility, and two consecutive closes."
```

Replace the `Chip` usage (currently `{f.directionFlipped ? "Direction flipped" : `${f.ratio.toFixed(1)}× expected`}`) with:

```tsx
                  <Chip tone={f.directionFlipped ? "warn" : up ? "up" : "down"}>
                    {f.directionFlipped
                      ? "Direction flipped"
                      : f.zScore != null
                        ? `${f.zScore.toFixed(1)}σ`
                        : signedPct(f.actualPct)}
                  </Chip>
```

- [ ] **Step 2: Typecheck the card**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "SignificantMovesCard" || echo "no card type errors"`
Expected: `no card type errors`

- [ ] **Step 3: Commit**

```bash
git add app/dashboard/today/SignificantMovesCard.tsx
git commit -m "feat(today): Significant Moves card shows zScore (sigma) chip + updated hint"
```

---

## Task 6: R2 snapshot — carry `residualStd` to the Worker

**Files:**
- Modify: `scripts/snapshot-state-to-r2.ts` (the `getSecurityBetas` function ~line 177, and its type annotation ~line 81)

- [ ] **Step 1: Select `residual_std` and widen the return type**

Replace the `getSecurityBetas` function with:

```typescript
function getSecurityBetas(
  db: Database.Database
): Array<{ securityId: number; lookbackDays: number; beta: number; residualStd: number | null; computedAt: string }> {
  const rows = db
    .prepare(
      `SELECT security_id AS securityId,
              lookback_days AS lookbackDays,
              beta,
              residual_std AS residualStd,
              computed_at AS computedAt
         FROM security_betas
        ORDER BY security_id, lookback_days`
    )
    .all() as Array<{ securityId: number; lookbackDays: number; beta: number; residualStd: number | null; computedAt: string }>;
  return rows;
}
```

- [ ] **Step 2: Update the snapshot type if locally declared**

Search the file for the `securityBetas` field on the snapshot type (around line 81). Update it to include `residualStd: number | null`:

```typescript
  securityBetas: Array<{ securityId: number; lookbackDays: number; beta: number; residualStd: number | null; computedAt: string }>;
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i "snapshot-state-to-r2" || echo "no snapshot type errors"`
Expected: `no snapshot type errors`

- [ ] **Step 4: Commit**

```bash
git add scripts/snapshot-state-to-r2.ts
git commit -m "feat(snapshot): include residual_std in R2 securityBetas payload"
```

---

## Task 7: Worker fallback-evening — port the two-gate logic (TDD)

The Worker has a hand-ported copy of the engine. It must match the Mac engine. Worker tests run in a separate Vitest project under `workers/cron/`.

**Files:**
- Modify: `workers/cron/src/state.ts:174` (Snapshot type)
- Modify: `workers/cron/src/fallback-evening.ts`
- Modify: `workers/cron/test/fallback-evening.test.ts`

- [ ] **Step 1: Widen the Snapshot type for `residualStd`**

In `workers/cron/src/state.ts`, update the `securityBetas` field (line ~174):

```typescript
  securityBetas?: Array<{ securityId: number; lookbackDays: number; beta: number; residualStd?: number | null; computedAt: string }>;
```
(`residualStd?` optional so older v3 snapshots without the field still typecheck -> degraded mode.)

- [ ] **Step 2: Write/adjust the failing Worker tests**

In `workers/cron/test/fallback-evening.test.ts`, locate the test(s) that exercise `computeAnomaliesFromSnapshot` (or the exported anomaly path). Add/replace with cases mirroring the Mac engine. Use the file's existing snapshot-builder/seed helpers; the shape below shows intent — adapt to the helpers already in the file:

```typescript
  it("does not flag a 1% wiggle on a flat day (fails 3% floor)", async () => {
    // SPY +0.1%; ACME +1.0%, beta 1.2, residualStd 1.5
    const flags = await runAnomalyHelper({
      spy: { prior: 530, today: 530 * 1.001 },
      holdings: [{ securityId: 1, symbol: "ACME", prior: 100, today: 101.0 }],
      betas: [{ securityId: 1, lookbackDays: 60, beta: 1.2, residualStd: 1.5 }],
    });
    expect((flags ?? []).map((f) => f.symbol)).not.toContain("ACME");
  });

  it("flags a quiet fund up 3.2% on a flat day (high z)", async () => {
    const flags = await runAnomalyHelper({
      spy: { prior: 530, today: 530 * 1.001 },
      holdings: [{ securityId: 1, symbol: "QFND", prior: 100, today: 103.2 }],
      betas: [{ securityId: 1, lookbackDays: 60, beta: 0.3, residualStd: 0.5 }],
    });
    expect((flags ?? []).map((f) => f.symbol)).toContain("QFND");
  });

  it("does not flag a volatile name up 3.1% (z < 2)", async () => {
    const flags = await runAnomalyHelper({
      spy: { prior: 530, today: 530 * 1.001 },
      holdings: [{ securityId: 1, symbol: "VOLA", prior: 100, today: 103.1 }],
      betas: [{ securityId: 1, lookbackDays: 60, beta: 1.5, residualStd: 2.5 }],
    });
    expect((flags ?? []).map((f) => f.symbol)).not.toContain("VOLA");
  });

  it("degraded mode: missing residualStd enforces only the 3% floor", async () => {
    const flags = await runAnomalyHelper({
      spy: { prior: 530, today: 530 * 1.001 },
      holdings: [
        { securityId: 1, symbol: "BIG", prior: 100, today: 103.5 },
        { securityId: 2, symbol: "SML", prior: 100, today: 102.0 },
      ],
      betas: [
        { securityId: 1, lookbackDays: 60, beta: 1.0 }, // no residualStd
        { securityId: 2, lookbackDays: 60, beta: 1.0 },
      ],
    });
    const syms = (flags ?? []).map((f) => f.symbol);
    expect(syms).toContain("BIG");
    expect(syms).not.toContain("SML");
  });
```

> Note: `runAnomalyHelper` above is a stand-in for whatever the existing test uses to drive `computeAnomaliesFromSnapshot` (the function is currently file-private and Yahoo-backed). If it is not exported, EITHER (a) export `computeAnomaliesFromSnapshot` and a pure inner helper that takes pre-resolved `(latest, prior)` closes so Yahoo can be bypassed in tests, OR (b) mirror the existing mocking approach already used in `fallback-evening.test.ts` for Yahoo. Prefer (a): extract a pure `evaluateAnomalies(closesBySymbol, spyPct, holdings, betas)` and unit-test that directly — it removes the Yahoo dependency from these assertions entirely.

- [ ] **Step 3: Run the Worker tests — verify they FAIL**

Run: `cd workers/cron && npx vitest run test/fallback-evening.test.ts`
Expected: FAIL (old threshold still in place / new helper not yet present).

- [ ] **Step 4: Port the constants + two-gate logic**

In `workers/cron/src/fallback-evening.ts`:

(a) Add constants near the top (mirroring Mac — keep values identical):

```typescript
// Mirror of lib/digest/anomalies.ts trigger constants. Kept in sync with the
// Mac engine; values MUST match. See design doc 2026-06-01.
const MIN_ABS_MOVE_PCT = 3.0;
const MIN_RESIDUAL_Z = 2.0;
const RESIDUAL_STD_EPSILON = 0.1;
```

(b) Update the local `AnomalyFlag` type — replace `thresholdPct` + `ratio` with `residualPct` + `zScore: number | null`.

(c) Build a residual-std map alongside `betaMap`:

```typescript
  const residualStdMap = new Map<number, number | null>(
    securityBetas
      .filter((b) => b.lookbackDays === 60)
      .map((b) => [b.securityId, b.residualStd ?? null]),
  );
```

(d) Replace the per-holding flag computation (the block containing `const thresholdPct = Math.max(2 * Math.abs(expectedPct), 1.0);` through the `flags.push(...)`) with:

```typescript
    const expectedPct = spyPct * beta;
    const residualPct = actualPct - expectedPct;

    if (Math.abs(actualPct) < MIN_ABS_MOVE_PCT) continue;

    let zScore: number | null = null;
    const residualStd = residualStdMap.get(holding.securityId) ?? null;
    if (residualStd != null && residualStd > RESIDUAL_STD_EPSILON) {
      zScore = Math.abs(residualPct) / residualStd;
      if (zScore < MIN_RESIDUAL_Z) continue;
    }

    const directionFlipped =
      Math.abs(expectedPct) > 0.1 &&
      Math.sign(actualPct) !== 0 &&
      Math.sign(expectedPct) !== 0 &&
      Math.sign(actualPct) !== Math.sign(expectedPct);

    flags.push({ symbol: holding.symbol, actualPct, spyPct, beta, expectedPct, residualPct, zScore, directionFlipped });
```

(e) Update the sort to match Mac:

```typescript
  const sortKey = (f: AnomalyFlag): number =>
    f.zScore ?? Math.abs(f.actualPct) / MIN_ABS_MOVE_PCT;
  flags.sort((a, b) => sortKey(b) - sortKey(a));
```

(f) In `formatAnomalyBlock`, remove any `MAX_DISPLAY`/slice cap so all flags render, and update the reason text to mirror Mac:

```typescript
    const reason = flag.directionFlipped
      ? "Direction flipped."
      : flag.zScore != null
        ? `${flag.zScore.toFixed(1)}σ move.`
        : `${signedPct(flag.actualPct)} move.`;
```

- [ ] **Step 5: Run the Worker tests — verify they PASS**

Run: `cd workers/cron && npx vitest run test/fallback-evening.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/cron/src/state.ts workers/cron/src/fallback-evening.ts workers/cron/test/fallback-evening.test.ts
git commit -m "feat(worker): port 3%+2sigma residual-zscore anomaly gate to fallback-evening"
```

---

## Task 8: Full verification

- [ ] **Step 1: Mac test suite**

Run: `npx vitest run`
Expected: All pass (~2211 + the new anomaly tests, minus removed old ones). Report the count.

- [ ] **Step 2: Worker test suite**

Run: `cd workers/cron && npx vitest run`
Expected: All pass (~162 + new). Report the count.

- [ ] **Step 3: Full typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | tail -20`
Expected: No NEW errors. (Pre-existing `tests/api/cron-evening.test.ts:143` error is known/unrelated — do not fix here.)

- [ ] **Step 4: Backfill residual_std on the real DB (manual, post-merge)**

Operational note, not a code step — run once on the Mac after merge so live data has residual_std before the next nightly cron:

Run: `npx tsx scripts/refresh-vanguard-betas.ts`
Expected: JSON result with `computed: N`, then verify via a read-only query that the `residual_std IS NOT NULL` count is > 0.

- [ ] **Step 5: E2E sanity (per project convention — test as a real user)**

Start the dev server (`npm run dev`) and load `/dashboard/today`; confirm the Significant Moves card renders without error and chips read `Nσ` (or the empty-state hint if nothing qualifies). Per CLAUDE.md, unit tests alone are not sufficient.

---

## Self-Review Notes

- **Spec coverage:** trigger rule (T4), residual_std stat (T3), migration (T1), graceful degradation (T4 degraded test + T7), display/sigma + cap removal (T4/T5/T7), snapshot+Worker parity (T6/T7), constants single-source (T4 def, T7 mirror) — all mapped.
- **Type consistency:** `AnomalyFlag` drops `thresholdPct`/`ratio`, adds `residualPct` + `zScore` everywhere it's defined (Mac T4, Worker T7); `UpsertBetaInput.residualStd` (T2) matches `computeBeta` return `residualStdPct` (T3) and the snapshot field `residualStd` (T6). `BetaResult.residualStdPct` is internal to T3.
- **Known non-blocker:** existing `tests/api/cron-evening.test.ts:143` tsc error is pre-existing and out of scope (per TODO).
