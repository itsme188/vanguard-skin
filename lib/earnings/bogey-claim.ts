/**
 * What an earnings email may SAY about the bogey entries it prints.
 *
 * The vendor consensus row (source `finnhub`, written by the consensus-row
 * prepare step) is a printed entry since 2026-10-08, but it is not something
 * the user curated. So the wording follows the printed entries:
 *
 *   - "curated"      at least one printed entry is NOT the vendor's;
 *   - "vendor_only"  every printed entry is the vendor's: the text says the
 *                    vendor consensus is shown and no curated bogeys are on file
 *                    (the cloud twin words it "no curated bogeys are shown here");
 *   - "none"         nothing is printed: no block, no claim.
 *
 * Callers pass the SAME list of printed rows the block renders (the Mac's
 * `bogeysPrintedInPrompt` output), so the claim and the content cannot
 * disagree. The source decides, not the column: a hand-entered row that fills
 * only the vendor column is still the user's entry.
 *
 * PARITY (Worker: workers/cron/src/bogey-claim.ts::snapshotBogeyClaim), pinned
 * in tests/earnings/bogey-content-worker-parity.test.ts. Change both together.
 */
export type BogeyClaim = "none" | "curated" | "vendor_only";

/** The `earnings_bogeys.source` of the engine-owned vendor consensus row. */
export const VENDOR_BOGEY_SOURCE = "finnhub";

export function bogeyClaim(printed: ReadonlyArray<{ source: string }>): BogeyClaim {
  if (printed.length === 0) return "none";
  return printed.every((b) => b.source === VENDOR_BOGEY_SOURCE) ? "vendor_only" : "curated";
}
