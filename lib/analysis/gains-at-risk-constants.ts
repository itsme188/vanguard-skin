/**
 * Gains at risk: limits shared by the engine, the route's input check and the
 * page (addendum ruling C12, 2026-11-24).
 *
 * IMPORT-FREE on purpose: the page (a client component) and the route's input
 * module read these bounds without pulling the engine, the database or any
 * server-only module into the browser build. Add no import here.
 */

/**
 * The owner's own figure for a name: how much it moves per unit of driver
 * move. Accepted between `min` and `max` (inclusive); at most `maxEntries`
 * figures per request.
 */
export const BETA_OVERRIDE_BOUNDS = Object.freeze({ min: -5, max: 5, maxEntries: 200 });

/**
 * Trial positions (step 2): the contract multiplier of a trial option. An
 * adjusted contract with another multiplier is out of scope.
 */
export const TRIAL_OPTION_MULTIPLIER = 100;

/**
 * Trial positions (step 2): at most `maxPositions` per request; contracts and
 * shares are positive whole numbers up to `maxContracts` / `maxShares`; a
 * price (paid, typed, or the underlying's at the click) and a strike are
 * positive and at most `maxPrice` / `maxStrike`; an id is 1 to `idMaxLength`
 * characters; a trial option's volatility solved at the click is above 0 and
 * at most `maxVolatility` (10 = 1,000%).
 */
export const TRIAL_POSITION_BOUNDS = Object.freeze({
  maxPositions: 12,
  maxContracts: 500,
  maxShares: 1_000_000,
  maxPrice: 100_000,
  maxStrike: 100_000,
  idMaxLength: 40,
  maxVolatility: 10,
});

/** Step 3 (P5): a single-name driver can fall or rise. Index drivers keep GAINS_AT_RISK_BOUNDS.moveAbsMax, down only. */
export const SINGLE_NAME_MOVE_BOUNDS = Object.freeze({ min: -0.8, max: 1.0 });
/** Step 3: the default single-name sweep, -40% to +40% in 5% steps. */
export const SINGLE_NAME_DEFAULT_SWEEP = Object.freeze({ from: -0.4, to: 0.4, step: 0.05 });
/** Step 3 (P10, P11, D4, D9). */
export const CANDIDATE_BOUNDS = Object.freeze({
  maxContractsPerPull: 15,
  maxExpiriesPerPull: 3,
  defaultStrikesPerExpiry: 5,
  maxCandidates: 30,
  maxBudgetUsd: 10_000_000,
});
/** Step 3 (P15): a quote this old is flagged "old quote". */
export const CANDIDATE_QUOTE_OLD_AFTER_MINUTES = 15;
/** Step 3 (D6): the largest gap between the underlying's and the option's arrival times. */
export const CANDIDATE_MAX_OBSERVATION_GAP_SECONDS = 30;
/** Step 3 (D9): money is computed in whole units of 1/10,000 of a dollar. */
export const MONEY_UNITS_PER_DOLLAR = 10_000;
