# Significant Moves — residual z-score + magnitude floor redesign

**Date:** 2026-06-01
**Status:** Approved (design), pending implementation plan
**Surfaces affected:** Evening email anomaly block, Today-tab `SignificantMovesCard`, Worker `fallback-evening` cloud path

## Problem

`lib/digest/anomalies.ts::computeAnomalies` flags a Vanguard (non-Roth) holding when its
daily move exceeds `thresholdPct = max(2 × |expectedPct|, 1.0)`, where
`expectedPct = spyPct × beta`.

On a day where the indexes are near flat, `spyPct ≈ 0` ⇒ `expectedPct ≈ 0` ⇒
`2 × |expectedPct| ≈ 0`, so the **1.0% floor wins every time**. The test degenerates
into "did this name move more than 1%?" — and a 1% daily move is ordinary idiosyncratic
noise for nearly every security. Result: flat days over-fire badly.

Root cause: the model only measures a move against its **systematic** (market-implied)
component (`beta × SPY`). It has no notion of each stock's own **idiosyncratic**
volatility, so a stable bond fund and a volatile growth name are judged against the same
flat 1% bar. "Unusual" is fundamentally a statement about idiosyncratic risk, which the
current logic ignores.

## Solution

Judge each move two ways at once (hybrid gate), per eligible name:

```
expectedPct   = spyPct × beta                 # systematic component (also displayed)
residualPct   = actualPct − expectedPct       # the part the market does NOT explain
z             = |residualPct| / residualStdPct # how many "normal days" that is, for THIS stock

FLAGGED if   |actualPct| ≥ 3.0   (magnitude floor — actually moved enough to matter)
       AND   z ≥ 2.0             (statistically rare for this specific name)
```

- `z ≥ 2.0` — at least 2 standard deviations beyond the stock's own residual noise.
- `|actualPct| ≥ 3.0` — minimum raw daily move.

`residualStdPct` is the standard deviation of the residuals from the **same 60-day OLS
beta regression already run nightly** — currently computed-then-discarded.

### Why the pairing works
- **Flat day, ordinary 1% wiggle** → fails the 3% floor → not flagged.
- **Flat day, a quiet fund jumps 3%** → 3% is many σ for it → flagged.
- **Flat day, a volatile name moves 3%** → within its normal ~2% daily noise → `z < 2` → not flagged.
- **Big market day** → only names moving beyond their own beta-adjusted normal surface,
  instead of everything with `beta > 1`.

## Statistic extraction

In `scripts/refresh-vanguard-betas.ts::computeBeta`, after solving for `beta`
(`cov(s,b)/var(b)` on log daily returns), do one more pass over the aligned returns:

```
residual_i  = (stockReturn_i − meanS) − beta × (spyReturn_i − meanB)
residualVar = Σ residual_i² / (n − 2)        # n−2 = regression degrees of freedom
residualStdPct = sqrt(residualVar) × 100      # stored in PERCENT units
```

**Unit decision:** store `residual_std` in percent (decimal residual std × 100) so
`anomalies.ts` stays in a single unit system — it reuses the `actualPct` / `expectedPct`
it already computes in simple-percent and divides by `residualStdPct` directly. The
regression is fit on log returns while the daily move is simple-percent; at daily scale
(~1–2%) the log-vs-simple difference is negligible for a notification heuristic. The
regression intercept (alpha) is likewise omitted from the flag-time residual (~5 bps/day,
dwarfed by a 3% move) so we don't have to persist alpha.

## Schema change — migration `056`

```sql
ALTER TABLE security_betas ADD COLUMN residual_std REAL;   -- percent units, nullable
```

Nullable so existing rows survive until the next nightly refresh backfills them.

## Graceful degradation

A row may have `beta` but `residual_std = NULL` — transiently after the migration before
the nightly run, or in an **old R2 snapshot** the Worker reads.

- The **3% magnitude floor is ALWAYS enforced.**
- The **z-score gate is applied only when `residual_std` is present** and above a small
  epsilon (`> ~0.1%`, to avoid divide-by-tiny blowups on near-perfect index trackers).
- Degraded mode therefore behaves as "flag moves ≥ 3%" — strictly better than today's 1%
  floor — and self-heals the moment `refresh-vanguard-betas` next runs / the snapshot
  refreshes.

## Display / sort changes

- `ratio` (the sort key and the chip text) becomes the **z-score**. Sorting by z is more
  meaningful than sorting by a multiple of a near-zero expected number. Chip reads e.g.
  `4.1σ` instead of `4.1× expected`.
- `directionFlipped` stays as a descriptive label only (already not an independent
  trigger); a true flip produces a large residual and gets caught by the z-gate anyway.
- **Email caps removed:** `formatVanguardAnomaliesBlock` (`MAX_DISPLAY = 5` + overflow
  line) and the Worker's `formatAnomalyBlock` now render **all** flags — the new gates
  make flags rare enough that the cap is unnecessary, and the user wants to see all.

## Files touched

| File | Change |
|------|--------|
| `lib/db/migrations/056_security_betas_residual_std.sql` | add `residual_std` column |
| `scripts/refresh-vanguard-betas.ts` | compute + persist `residualStdPct` |
| `lib/mutations/security-betas.ts` | `UpsertBetaInput` + insert gain `residualStd` |
| `lib/digest/anomalies.ts` | two-gate test; read `residual_std`; `ratio`→z; update `AnomalyFlag`; drop `MAX_DISPLAY` cap; `signedPct`/chip → σ |
| `app/dashboard/today/SignificantMovesCard.tsx` | chip text (`Nσ`), `EmptySection` hint copy |
| `scripts/snapshot-state-to-r2.ts` | add `residualStd` to `securityBetas[]` |
| `workers/cron/src/fallback-evening.ts` | port identical two-gate logic; read `residualStd` from snapshot; drop cap |
| `tests/digest/anomalies.test.ts` | flat-day-no-fire, low-vol-fund-fires-at-3%, high-vol-3%-does-NOT-fire, degraded-mode (null residual_std → 3% floor only), z-score sort |
| Worker test | parity: same inputs → same flags as Mac engine |

## Constants (single source)

```
MIN_ABS_MOVE_PCT      = 3.0   # magnitude floor
MIN_RESIDUAL_Z        = 2.0   # statistical-rarity gate
RESIDUAL_STD_EPSILON  = 0.1   # percent; below this, skip z-gate (treat as unavailable)
```

Defined in `lib/digest/anomalies.ts` and mirrored in `workers/cron/src/fallback-evening.ts`
(kept in sync by the parity test, matching the existing market-holidays mirror pattern).

## Out of scope

- Changing the beta lookback window (stays 60-day).
- Multi-factor residuals (single-factor vs SPY is sufficient).
- IBKR / Roth scope (Vanguard-non-Roth only, unchanged).
