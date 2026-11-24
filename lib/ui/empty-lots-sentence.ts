/**
 * Wording for the security hub's empty Open Tax Lots card. A long position
 * comes from a purchase, a short one from a short sale. Plain module (no
 * "use client") so a server page may import it.
 */
export function emptyLotsCounterpartNoun(
  positionQuantities: readonly number[],
): "purchase" | "short sale" {
  return positionQuantities.length > 0 && positionQuantities.every((q) => q < 0)
    ? "short sale"
    : "purchase";
}
