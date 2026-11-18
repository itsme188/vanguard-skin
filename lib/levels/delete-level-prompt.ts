/**
 * The question the Levels panel asks before deleting a level. It names the
 * level (kind, price, source) so a mis-aimed click on a long list can be
 * caught. No React or client imports; the one dependency is the pure,
 * currency-aware price label. A level price is NATIVE currency: labelled in
 * the security's own currency, never converted.
 */
import { formatLevelPrice } from "@/lib/chart/price-formatter";

export interface DeleteLevelPromptInput {
  /** The label the row shows for the level kind (e.g. "Resistance"). */
  typeLabel: string;
  price: number;
  /** "static" for a fixed price; any other value is a moving-average level. */
  priceSource: string;
  /** Named source (newsletter author); null/empty for the owner's own. */
  sourceAuthor: string | null;
}

export interface DeleteLevelPrompt {
  title: string;
  message: string;
  confirmLabel: string;
  variant: "danger";
}

export function deleteLevelPrompt(
  level: DeleteLevelPromptInput,
  currency: string | null | undefined,
): DeleteLevelPrompt {
  const at = level.priceSource === "static" ? ` at ${formatLevelPrice(currency, level.price)}` : "";
  const author = level.sourceAuthor?.trim();
  const source = author ? ` (${author})` : "";
  return {
    title: "Delete level",
    message: `Delete the ${level.typeLabel} level${at}${source}? This cannot be undone.`,
    confirmLabel: "Delete",
    variant: "danger",
  };
}
