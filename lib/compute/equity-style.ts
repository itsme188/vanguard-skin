/**
 * Does this security carry an equity style (growth or value)? The ONE rule
 * (owner decision 2026-11-01, QA finding on the Growth vs Value split).
 *
 * A bond, a cash fund or a bond fund has no growth-or-value style. Before this
 * rule the classifier stored a hard-coded "Value" default for bonds and cash,
 * and kept an AI "Value" for bond funds, so the Growth vs Value breakdown, the
 * factor heatmap, the macro growth-to-value exposure, the hub factor profile
 * and the chat breakdown all counted cash and Treasuries as value stocks.
 *
 * Every Growth vs Value reader goes through this module: a security the rule
 * excludes reports NO growth/value (null) as a factor value and sits in the
 * "Not equity" bucket (NOT_EQUITY_STYLE_LABEL) in a breakdown. The classifier
 * stores no style for it either. Stored rows written before the rule are left
 * in place; the read side neutralises them.
 *
 * Excluded:
 *   - security type bond (case-insensitive);
 *   - a cash equivalent (`isCashEquivalentSecurity`);
 *   - a fixed-income fund (`isFixedIncomeFund`, which already leaves
 *     leveraged and inverse funds out, so those keep their stored style).
 * An option is judged by its underlying when the reader has the underlying's
 * row (`styleIdentityOf`); with no underlying row it keeps its stored value.
 *
 * Plain module: no database import.
 */
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { isFixedIncomeFund } from "@/lib/compute/bond-duration";
import { NOT_EQUITY_STYLE_LABEL } from "@/lib/factors";

export interface StyleIdentity {
  security_type: string | null;
  fund_category: string | null;
  sector: string | null;
}

function normalizedType(type: string | null | undefined): string {
  return (type ?? "").trim().toLowerCase();
}

/** False for a bond, a cash equivalent or a fixed-income fund. */
export function carriesEquityStyle(sec: StyleIdentity): boolean {
  if (normalizedType(sec.security_type) === "bond") return false;
  if (isCashEquivalentSecurity(sec)) return false;
  if (isFixedIncomeFund(sec)) return false;
  return true;
}

/**
 * The row the rule judges: an option's underlying when the reader has it
 * (pass null when the underlying row is missing), otherwise the security's
 * own row.
 */
export function styleIdentityOf<T extends StyleIdentity>(own: T, underlying: T | null | undefined): T {
  if (underlying && normalizedType(own.security_type) === "option") return underlying;
  return own;
}

/** The growth/value a reader may report: the stored value, or null for a non-equity. */
export function equityGrowthValue(
  stored: string | null,
  own: StyleIdentity,
  underlying?: StyleIdentity | null,
): string | null {
  return carriesEquityStyle(styleIdentityOf(own, underlying)) ? stored : null;
}

/** A breakdown bucket: "Not equity" for a non-equity, else the stored value or "Unknown". */
export function growthValueBucket(
  stored: string | null,
  own: StyleIdentity,
  underlying?: StyleIdentity | null,
): string {
  if (!carriesEquityStyle(styleIdentityOf(own, underlying))) return NOT_EQUITY_STYLE_LABEL;
  return stored ?? "Unknown";
}
