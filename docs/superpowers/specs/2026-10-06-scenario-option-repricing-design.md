# Scenario option repricing — design

**Date:** 2026-10-06
**Status:** design approved in conversation by the user; awaiting review of this written spec. No plan or code yet.
**Origin:** user ruling 2026-10-06 on QA finding `analysis-scenarios--custom-scenario-prices-short-put-linearly-understates-large-drop-loss` (option 2, full repricing). Also settles `analysis-scenarios--unpriced-option-hedges-omitted-while-greeks-counts-them-no-disclosure`.

## 1. Purpose

A stress scenario must not make a short option look safer than it is. Today both scenario engines move an option by one number measured at today's price, so a large move is drawn as a straight line. On a large drop a short put's loss is understated several times over, and a long put's protection is understated the same way.

Success: on any scenario, an option position's change is the change in its model value at the shocked underlying price, the inputs behind it are broker-derived and named on screen, and nothing is filled in with a guessed figure.

## 2. What happens today

`lib/compute/option-elasticity.ts` is the one option treatment shared by `lib/compute/scenarios.ts` (Build Custom Scenario) and `lib/compute/scenario-recipes.ts` (the presets):

- elasticity Ω = delta × underlying price ÷ option price, capped at |Ω| ≤ 8;
- option move = underlying move × Ω, floored at −100%;
- missing inputs fall back to Ω = ±2.5, and a missing volatility falls back to 30%.

Worked example with synthetic numbers: short one put, strike 50, underlying 60, put at 1.00, delta −0.15. Ω = −9, capped to −8. A 50% drop takes the underlying to 30. The engine moves the put +400% to 5.00, a loss of 4.00 a share. At 30 the put is worth at least 20, a loss of about 19 a share.

## 3. Decisions (user, 2026-10-06)

| # | Question | Ruling |
|---|---|---|
| D1 | Volatility source per option | Solve from the contract's own last price. If that cannot be solved, use the broker's implied volatility for the underlying (`security_quotes.iv_underlying`). If neither exists, the option is unmodelled. The source is shown per option. |
| D2 | Volatility under a shock | The user sets it. Custom scenarios get a "Volatility change" slider in volatility points, default 0, added to every option's own volatility. Presets hold volatility at today's level and say so. No coefficient linking volatility to the market move exists anywhere in the code. |
| D3 | Scope | Presets and custom scenarios together, through one shared function. |
| D4 | Options that cannot be repriced | Excluded from the scenario total, shown as "not modelled" with the reason, and counted on the card with their share of option value. |

Rejected: the broker's underlying volatility as the only source (ignores strike and expiry); an automatic volatility rule (the app stores no volatility history to derive a coefficient from); per-preset volatility figures (a hand-kept table); repricing the custom path only (the two cards would disagree again, the 2026-09-11 defect class); keeping the ±2.5 fallback behind a label.

## 4. The calculation

For each option position in a scenario:

1. **Shocked underlying price.** `S' = S × (1 + m)`, where `S` is the underlying's last close and `m` is the underlying's scenario move, exactly as each engine computes it today (market leg plus rate leg for the custom engine; the factor-derived move for the recipe engine). `m` is floored at −100%.
2. **Volatility σ (D1).**
   - `impliedVolatility(ownPrice, S, K, T, r, type)` from `lib/compute/options-greeks.ts`. Source label `own-price`. A quote below exercise value is never accepted: these contracts are American, so such a quote is stale and no volatility explains it.
   - If that returns null: `iv_underlying` when it is a positive finite number. Source label `broker-underlying`.
   - Otherwise the option is unmodelled, reason `no-volatility`.
3. **Shocked volatility (D2).** `σ' = max(σ + Δvol, 0.01)`, where `Δvol` is the scenario's volatility change as a decimal (15 points = 0.15) and is 0 when the scenario does not set one.
4. **Values.** `V0 = max(BS(S, K, T, r, σ), intrinsic(S))` and `V1 = max(BS(S', K, T, r, σ'), intrinsic(S'))`. `BS` is the existing `callPrice` / `putPrice`. The exercise-value floor is the early-exercise treatment for American-style contracts.
5. **Change.** Per-share change `ΔV = V1 − V0`. The position's market value already equals `ownPrice × quantity × multiplier × FX factor`, so the change in dollars is `marketValue × ΔV ÷ ownPrice`; no second quantity or FX path is introduced. The displayed percent is `ΔV ÷ ownPrice`, floored at −100% (with the fallback volatility source the model's value today can sit above the market price, and a position cannot lose more than it is worth).

Notes:

- With the `own-price` source and `Δvol = 0`, `V0` equals the market price, so a zero move gives a zero change.
- With the `broker-underlying` source `V0` can differ from the market price. The change is still `V1 − V0` (model to model); it is never `V1 − market price`.
- Working in dollars per contract means a short position needs no special case and no cap: a negative quantity turns a rising value into a loss. A value cannot go below zero, so a long option cannot lose more than its value.

### Unmodelled reasons (D4)

| Reason | Condition |
|---|---|
| `no-option-price` | the contract has no last close of its own (its position value is zero in the scenario, and the dollar change cannot be scaled without it) |
| `no-underlying-price` | the underlying has no last close, or it is not positive |
| `no-option-terms` | strike, expiry or option type missing or unparseable |
| `expired` | not live per `isOptionLive` (`lib/compute/option-expiry.ts`) |
| `no-volatility` | neither volatility source is available |

An unmodelled option contributes zero to the scenario total. An option with no own price at all still appears as an unmodelled row; it is not dropped from the list.

## 5. Held fixed, and stated on the card

- **Time to expiry.** The shock is instantaneous; `T` is today's.
- **Interest rate.** `r` is `getRiskFreeRate(db)`, unchanged even when the scenario carries a rate move.
- **Dividends.** The existing pricer has no dividend yield; this design does not add one.

These are model limits. The card lists them in one caption line. Adding rate and dividend sensitivity would change the shared pricer the Greeks card uses and is out of scope.

## 6. Code shape

- **New:** `lib/compute/option-reprice.ts`. One pure function, roughly `repriceOptionUnderShock(inputs, { underlyingMove, volChange, riskFreeRate, now }) → { modelled: true, v0, v1, perShareChange, sigma, sigmaShocked, ivSource } | { modelled: false, reason }`. It imports the pricers and the solver from `options-greeks.ts` and the expiry helpers from `option-expiry.ts`. It takes no `db`.
- **`lib/compute/scenarios.ts` and `lib/compute/scenario-recipes.ts`:** the option branch calls `repriceOptionUnderShock` in place of `optionElasticity` + `leverUnderlyingMoveByElasticity`. Both position queries already select the needed columns through `OPTION_PRICING_COLUMNS_SQL`; the quantity and multiplier are added if a query lacks them.
- **`ScenarioDefinition`** gains `volMove?: number` (volatility points). `PositionImpact` gains `ivSource`, `unmodelledReason` and, for option rows, `underlyingMove` (the underlying's scenario move before repricing). `ScenarioResult` gains `optionsUnmodelled: { count, valueShare }`.
- **`app/api/compute/scenarios/route.ts`:** accepts and validates `volMove` for a custom scenario (finite, within the slider's range).
- **`app/dashboard/components/ScenarioModeling.tsx`** (the card lists only the five largest losers and winners, so an unmodelled option, whose change is zero, never appears there; the card therefore carries its own short "not modelled" list with each contract and its reason)**:** a third slider "Volatility change" (points, default 0, step 1; range −20 to +60 is this spec's proposal and the one figure here the user may want to adjust); per-option-row source chip and "not modelled" state; the unmodelled count line; the caption from §5; the preset note "option volatility held at today's level". Portfolio-derived figures keep rendering through the privacy components.
- **`lib/compute/option-elasticity.ts`:** `optionElasticity` and `leverUnderlyingMoveByElasticity` lose their two scenario callers. `DEFAULT_OPTION_ELASTICITY`, `isOptionSecurityType` and the SQL fragments stay (the delta-exposure column in `lib/compute/exposure.ts` and both queries use them). Functions left with no production caller are deleted in the same change.
- **No schema change. No Worker mirror** (the Worker has no scenario code).

## 7. What does not change

The delta-exposure column on the sector view, the Greeks card, and every non-option position in a scenario.

One label does change: an option row today prints a levered beta (the underlying's beta times the elasticity). With the elasticity gone from this path, an option row prints its volatility source chip in that place and no beta.

## 8. Required tests (named)

1. **Zero-shock identity.** Own-price source, move 0, `volMove` 0 → change is 0 to within solver tolerance.
2. **Short-put floor (the finding).** For any option and any move, the shocked value is at least the exercise value at the shocked price: `V1 ≥ intrinsic(S')`. For a short put on a downward move this means the loss per share is at least `intrinsic(S') − today's price`. (Amended at plan time: the first draft compared against the rise in exercise value, which ignores the premium already in today's price and is not a true bound.)
3. **Sign.** On a downward move a long put gains and a long call loses; reversed on an upward move; a short position has the opposite dollar sign of the long.
4. **Monotonic in volatility.** Raising `volMove` never lowers a long option's shocked value.
5. **Engine parity.** A preset and a custom scenario with identical moves and `volMove` 0 give identical per-option results (one shared function, pinned by a test that runs both engines on one fixture).
6. **Unmodelled.** Each reason in §4 yields `modelled: false`, a zero contribution and a count; no ±2.5 or 30% figure appears on the scenario path (a repo test fails on either constant being read there).
7. **Total ties.** The scenario total equals the sum of the row changes shown, unmodelled rows contributing zero.
8. **Fallback source.** With no solvable own-price volatility and a broker figure present, the source is `broker-underlying` and the change is `V1 − V0`, not `V1 − market price`.
9. **Legacy expiry spelling.** A `YYYYMMDD` expiration reprices the same as its ISO form.

Fixtures are synthetic. The existing elasticity tests that pin the linear behaviour on the scenario path are replaced, not kept alongside.

## 9. Verification beyond unit tests

- On the sandbox (a database copy): the finding's repro, a large downward custom scenario on an account holding a short put, shows a loss at or above the exercise-value change; the slider changes option rows only; preset and custom agree at slider 0.
- A read-only before/after of preset totals on a database copy, reported to the user in direction-only terms before deploy, since every preset result for an account holding options will move.

## 10. Out of scope

Rate and dividend sensitivity in the option formula; a volatility surface or per-expiry term structure; any volatility history store; per-preset volatility figures; changes to the Greeks card or the exposure column.
