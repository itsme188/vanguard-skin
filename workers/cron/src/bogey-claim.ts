/**
 * What the cloud earnings email may SAY about the bogey entries it prints.
 * No imports on purpose: the Mac suite pins this file against its twin.
 *
 * The vendor consensus row (source `finnhub`) is a printed entry since
 * 2026-10-08, but it is not something the user curated. So the wording follows
 * the printed entries:
 *
 *   - "curated"      at least one printed entry is NOT the vendor's;
 *   - "vendor_only"  every printed entry is the vendor's: the text says the
 *                    vendor consensus is shown and no curated bogeys are shown here;
 *   - "none"         nothing is printed: no block, no claim.
 *
 * Callers pass the SAME list of printed rows the block renders
 * (`snapshotBogeysPrinted` output), so the claim and the content cannot
 * disagree. The source decides, not the column.
 *
 * PARITY (Mac: lib/earnings/bogey-claim.ts::bogeyClaim), pinned in
 * tests/earnings/bogey-content-worker-parity.test.ts. Change both together.
 */
export type SnapshotBogeyClaim = "none" | "curated" | "vendor_only";

/** The `source` of the engine-owned vendor consensus row. */
export const VENDOR_BOGEY_SOURCE = "finnhub";

export function snapshotBogeyClaim(printed: ReadonlyArray<{ source: string }>): SnapshotBogeyClaim {
  if (printed.length === 0) return "none";
  return printed.every((b) => b.source === VENDOR_BOGEY_SOURCE) ? "vendor_only" : "curated";
}
