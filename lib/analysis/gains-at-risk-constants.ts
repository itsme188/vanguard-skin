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
