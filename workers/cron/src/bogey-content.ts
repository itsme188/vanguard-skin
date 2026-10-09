/**
 * "Does this bogey row hold anything?" for the Worker.
 *
 * PARITY (Mac: lib/mutations/earnings-bogeys.ts::bogeyHasContent). Owner ruling
 * 2026-08-12: a bogey row with every content column empty is not coverage, so
 * it must not count on any surface. The Mac's nightly snapshot already leaves
 * such rows out; this is the same rule applied again on arrival, so a snapshot
 * written before that filter cannot make the cloud email claim bogeys it has
 * none of.
 *
 * A number counts when it is a finite number (0 is a real consensus). Text
 * counts when it is not blank and not an empty JSON container.
 *
 * The column list is the Mac's CONTENT_COLUMNS. `extra_metrics_json` is in it
 * although the snapshot does not carry that column today: a row whose only
 * content is an extra metric line reaches the Worker with nothing the Worker
 * can show, and reads here as empty. tests/earnings/bogey-content-worker-
 * parity.test.ts (Mac suite) pins both the list and the rule against the Mac's.
 *
 * No imports: the Mac suite loads this file directly.
 */

export const SNAPSHOT_BOGEY_CONTENT_COLUMNS = [
  "eps_consensus",
  "eps_whisper",
  "revenue_consensus_usd",
  "revenue_whisper_usd",
  "expected_move_pct",
  "eps_consensus_vendor",
  "segment_breakdown_json",
  "guidance_notes",
  "notes",
  "extra_metrics_json",
] as const;

const EMPTY_TEXT_VALUES = ["", "[]", "{}"];

export function snapshotBogeyHasContent(
  row: Partial<Record<(typeof SNAPSHOT_BOGEY_CONTENT_COLUMNS)[number], unknown>>,
): boolean {
  return SNAPSHOT_BOGEY_CONTENT_COLUMNS.some((c) => {
    const v = row[c];
    if (v == null) return false;
    if (typeof v === "string") return !EMPTY_TEXT_VALUES.includes(v.trim());
    return typeof v !== "number" || Number.isFinite(v);
  });
}
