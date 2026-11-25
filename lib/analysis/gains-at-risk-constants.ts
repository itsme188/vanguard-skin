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
