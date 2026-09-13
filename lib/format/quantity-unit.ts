/**
 * Singularises the quantity-unit noun shown next to a holding's quantity
 * (e.g. Quantity column on the Accounts Holdings table). "Security type"
 * comparisons are case-insensitive per repo convention (see CLAUDE.md
 * "Case sensitivity trap").
 *
 * "face value" (bonds) is uncountable and is never singular/plural branched.
 * "contract"/"share" branch on the ABSOLUTE quantity being exactly 1, so a
 * short 1-contract position (-1) also reads "1 contract", not "-1 contracts".
 */
export function quantityUnitLabel(
  securityType: string | null | undefined,
  quantity: number
): string {
  const type = securityType?.toLowerCase();
  const isSingular = Math.abs(quantity) === 1;

  if (type === "option") return isSingular ? "contract" : "contracts";
  if (type === "bond") return "face value";
  return isSingular ? "share" : "shares";
}
