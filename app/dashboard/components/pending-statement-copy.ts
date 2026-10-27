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

/* ------------------------------------------------------------------ */
/* Options and shorts: one reason per pending lot (plan Task 4).      */
/* Plain English, owner-facing. No code names, no file paths, and no  */
/* sentence promises that a particular script will fix anything.      */
/* ------------------------------------------------------------------ */

import type { PendingFigureKind, PendingReason } from "@/lib/queries/pending-statement-types";

export const CLOSING_ENTRY_MISSING_CHIP_LABEL = "closing entry missing";
export const RESYMBOL_REPAIR_PENDING_CHIP_LABEL = "re-symbolled — repair pending";

export const CLOSING_ENTRY_MISSING_TITLE =
  "The broker statement shows this position closed, but the ledger has no closing trade (a sale, a purchase to close or cover, an expiry or an assignment). These lots are left out of Unrealized and add nothing to Realized until that entry is imported.";

export const RESYMBOL_REPAIR_PENDING_TITLE =
  "This option was renamed to a new contract after a split, and the position is still held under the new symbol. The ledger entries must be moved to the new symbol before these lots are valued. Until then they are left out of Unrealized and add nothing to Realized.";

/** The chip text for a pending lot. It stands alone; the title is a supplement. */
export function pendingChipLabel(reason: PendingReason): string {
  switch (reason) {
    case "closing_entry_missing":
      return CLOSING_ENTRY_MISSING_CHIP_LABEL;
    case "resymbol_repair_pending":
      return RESYMBOL_REPAIR_PENDING_CHIP_LABEL;
    default:
      return PENDING_STATEMENT_CHIP_LABEL;
  }
}

/** Hover text for the chip. */
export function pendingChipTitle(reason: PendingReason): string {
  switch (reason) {
    case "closing_entry_missing":
      return CLOSING_ENTRY_MISSING_TITLE;
    case "resymbol_repair_pending":
      return RESYMBOL_REPAIR_PENDING_TITLE;
    default:
      return PENDING_STATEMENT_TITLE;
  }
}

/** The start of a Tax Lots summary line, before the count. */
export function pendingLineLead(reason: PendingReason): string {
  switch (reason) {
    case "closing_entry_missing":
      return "Positions the statement shows closed with no closing entry";
    case "resymbol_repair_pending":
      return "Options renamed after a split, ledger not yet moved";
    default:
      return "Positions closed per live data";
  }
}

/** The sentence after the count and bracket on a summary line. */
export function pendingLineAction(reason: PendingReason): string {
  switch (reason) {
    case "closing_entry_missing":
      return "Import or enter the closing trade. Nothing is realized until then.";
    case "resymbol_repair_pending":
      return "Still held under the new symbol. The ledger entries must be moved to the new symbol before these lots are valued.";
    default:
      return PENDING_STATEMENT_EXPLANATION;
  }
}

/**
 * The words for a figure in the bracket of a summary line. A short side is
 * never called cost basis: it is what the sale brought in.
 */
export function pendingFigureWords(kind: PendingFigureKind): string {
  return kind === "short_sale_proceeds" ? "short-sale proceeds on short lots" : "cost basis on long lots";
}

// Owner ruling 2026-10-26 (pending lots): a short side's figure is short-sale
// proceeds (money received), never called cost basis.
export function lotFigureHeader(hasShortLots: boolean): string {
  return hasShortLots ? "Cost Basis / Proceeds" : "Cost Basis";
}

/** Per-row label under a short lot's figure. */
export function shortLotFigureNote(): string {
  return "short-sale proceeds";
}

/** The security page note when the broker shows no current position. */
export function lotsWithoutPositionNote(reason: PendingReason | "mixed"): string {
  switch (reason) {
    case "closing_entry_missing":
      return "The broker statement shows the position closed, but the ledger has no closing trade. The lots stay open and unvalued until it is imported.";
    case "resymbol_repair_pending":
      return "This option was renamed to a new contract after a split. It is still held under the new symbol, and the ledger entries must be moved there before these lots are valued.";
    case "mixed":
      return "Some of these lots are waiting for a statement and some are missing a closing entry. They stay open and unvalued until the ledger is brought up to date.";
    default:
      return "The broker's live data shows the position closed; the lots stay open until the statement with the closing trade is imported.";
  }
}

/** Popover chip labels and Data Health suffixes, by integrity hit kind. */
export type PendingIntegrityKind =
  | "statement-lag"
  | "closing-entry-missing"
  | "resymbol-repair-pending"
  | "closing-entry-account-mismatch"
  | "closing-entry-account-undecidable"
  | "exercise-price-missing"
  | "exercise-leg-missing";

export const PENDING_INTEGRITY_CHIP_LABEL: Record<PendingIntegrityKind, string> = {
  "statement-lag": STATEMENT_LAG_LABEL,
  "closing-entry-missing": "closing entry missing",
  "resymbol-repair-pending": "re-symbolled — repair pending",
  "closing-entry-account-mismatch": "closing entry in another account",
  "closing-entry-account-undecidable": "closing entry may be in another account",
  "exercise-price-missing": "exercise has no price",
  "exercise-leg-missing": "exercise has no stock leg",
};

export const PENDING_INTEGRITY_SUFFIX: Record<PendingIntegrityKind, string> = {
  "statement-lag": "closed per live data — awaiting statement",
  "closing-entry-missing": "statement shows closed — closing trade not in the ledger",
  "resymbol-repair-pending": "renamed to a new contract — the ledger entries must be moved",
  "closing-entry-account-mismatch": "a closing entry for this position sits in another account",
  "closing-entry-account-undecidable":
    "a closing entry in another account may belong to this position, but the ledger cannot tell",
  "exercise-price-missing": "import the exercise or assignment again with its strike price",
  "exercise-leg-missing":
    "import the stock trade from the exercise or assignment, or record the option's underlying and call/put",
};
