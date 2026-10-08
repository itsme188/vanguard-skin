/**
 * Copy for the pending-statement state (spec 2026-10-02 statement-only
 * synthetic closes §2.2), shared by the Tax Lots summary line, the Open Lots
 * chip, the security detail chip and the data-confidence popover so they read
 * as one thing. Plain module (no JSX) so client and server components can
 * both import it.
 *
 * The chip text must stand alone (the title is a supplement, never the only
 * carrier of meaning — hover is unavailable on touch).
 */
export const PENDING_STATEMENT_CHIP_LABEL = "pending statement";

/** Popover label for an integrity hit of kind "statement-lag". */
export const STATEMENT_LAG_LABEL = "awaiting statement";

export const PENDING_STATEMENT_TITLE =
  "Closed per live broker data — the closing trade is not imported yet. Awaiting the broker statement; until then these lots are excluded from Unrealized and add nothing to Realized.";

/**
 * The same explanation as visible text for the Tax Lots summary line. A
 * `title` never shows on a phone, so the line carries the words itself (QA:
 * mobile-tax-lots-pending-statement--explanation-hover-only-banner-names-no-positions).
 * It follows the count sentence, so it does not repeat "excluded from
 * Unrealized".
 */
export const PENDING_STATEMENT_EXPLANATION =
  "The closing trade is not imported yet. These lots stay listed in Open Lots, marked \u201cpending statement\u201d, and add nothing to Realized until the broker statement is imported.";

export const PENDING_STATEMENT_FILTER_ON_LABEL = "Show pending only";
export const PENDING_STATEMENT_FILTER_OFF_LABEL = "Show all open lots";
