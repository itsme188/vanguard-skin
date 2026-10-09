/**
 * Element ids for the Giving page, built only from stored data so the server
 * render and the browser always produce the same string. No React here.
 *
 * The page draws one year section per year, and inside a section one basis
 * control per flagged lot of each gift. A fixed id would repeat across
 * sections (a label could then point at another section's input), and a
 * generated one was the subject of an intermittent hydration mismatch
 * (2026-10-09), so every id carries what makes its element the only one.
 */

/** The "Reversed date" field of one year section's reverse confirm. */
export function reverseDateInputId(year: string): string {
  return `giving-reverse-date-${year}`;
}

export type LotBasisFieldIds = { input: string; hint: string };

/**
 * The source field and its hint in the "Mark basis verified" dialog.
 * One lot can feed several gifts and one gift can hold several flagged lots,
 * so the pair of ids is what is unique on the page.
 */
export function lotBasisFieldIds(donationId: number, acquisitionTransactionId: number): LotBasisFieldIds {
  const key = `d${donationId}-t${acquisitionTransactionId}`;
  return { input: `lot-basis-source-${key}`, hint: `lot-basis-hint-${key}` };
}
