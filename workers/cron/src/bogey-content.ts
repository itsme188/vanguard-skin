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

// ── What the cloud email PRINTS from a row ──────────────────────────────────
//
// Review follow-up (2026-10-08): "holds something" is not "prints something".
// A row can pass the content rule above on a column the cloud email did not
// print, and the email then listed an entry with nothing under it while its
// footer said the curated bogeys were included. So the composer's rule is
// about printing: build the row's printed text first, and a row with none is
// not an entry. `resolveBogeysForEvent`, `hasBogeys` and `renderBogeysBlock`
// (fallback-earnings.ts) all go through `snapshotBogeysPrinted`, so the count
// and the rendering cannot disagree.
//
// PARITY (Mac: lib/earnings/bogey-prompt-entries.ts::bogeysPrintedInPrompt).
// Both sides agree on which rows count for every column the snapshot carries.
// The one documented difference: `extra_metrics_json` is not in the snapshot,
// so an extras-only row is an entry on the Mac and not here.
// tests/earnings/bogey-content-worker-parity.test.ts (Mac suite) pins both.

/** The snapshot columns the cloud email prints from. */
export interface SnapshotBogeyPrintFields {
  eps_consensus?: number | null;
  eps_whisper?: number | null;
  revenue_consensus_usd?: number | null;
  revenue_whisper_usd?: number | null;
  expected_move_pct?: number | null;
  eps_consensus_vendor?: number | null;
  segment_breakdown_json?: string | null;
  guidance_notes?: string | null;
  notes?: string | null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const hasText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Compact USD for bogey figures (no Mac lib import). 92e9 → "$92.00B". */
export function formatBogeyUSD(n: number): string {
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

/** One piece per segment that carries a figure. A segment with none is not printed. */
function segmentPieces(json: string | null | undefined): string[] {
  if (!hasText(json)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const pieces: string[] = [];
  for (const [name, vals] of Object.entries(parsed as Record<string, unknown>)) {
    if (!vals || typeof vals !== "object") continue;
    const v = vals as { consensus?: unknown; whisper?: unknown };
    const figures: string[] = [];
    if (finite(v.consensus)) figures.push(`consensus ${formatBogeyUSD(v.consensus)}`);
    if (finite(v.whisper)) figures.push(`whisper ${formatBogeyUSD(v.whisper)}`);
    if (figures.length > 0) pieces.push(`${name} ${figures.join(", ")}`);
  }
  return pieces;
}

/**
 * Everything the cloud email prints under one entry's heading, each line led by
 * a newline. "" when the row has nothing the email prints: such a row is not an
 * entry. For a row of curated consensus / whisper / guidance / notes the text
 * is unchanged from before this helper existed.
 *
 * The vendor's EPS consensus is printed as the vendor's (its basis is not
 * stated), never as "EPS consensus".
 */
export function snapshotBogeyEntryBody(b: SnapshotBogeyPrintFields): string {
  const fields: string[] = [];
  if (finite(b.eps_consensus)) fields.push(`EPS consensus ${b.eps_consensus.toFixed(2)}`);
  if (finite(b.eps_whisper)) fields.push(`EPS **whisper ${b.eps_whisper.toFixed(2)}**`);
  if (finite(b.eps_consensus_vendor))
    fields.push(`Vendor EPS consensus ${b.eps_consensus_vendor.toFixed(2)} (basis unspecified)`);
  if (finite(b.revenue_consensus_usd))
    fields.push(`Rev consensus ${formatBogeyUSD(b.revenue_consensus_usd)}`);
  if (finite(b.revenue_whisper_usd))
    fields.push(`Rev **whisper ${formatBogeyUSD(b.revenue_whisper_usd)}**`);
  if (finite(b.expected_move_pct)) fields.push(`Expected move ±${b.expected_move_pct.toFixed(1)}%`);
  const head = fields.length > 0 ? `\n${fields.join(" · ")}` : "";
  const segPieces = segmentPieces(b.segment_breakdown_json);
  const segs = segPieces.length > 0 ? `\nSegments: ${segPieces.join("; ")}` : "";
  const guidance = hasText(b.guidance_notes) ? `\nGuidance: ${b.guidance_notes}` : "";
  const notes = hasText(b.notes) ? `\nNotes: ${b.notes}` : "";
  return `${head}${segs}${guidance}${notes}`;
}

/**
 * The rows the cloud email lists, in the order given, each with the text it
 * prints. THE one reader for "does this event have bogeys, as far as the cloud
 * email is concerned": a row with an empty body is left out.
 */
export function snapshotBogeysPrinted<T extends SnapshotBogeyPrintFields>(
  rows: readonly T[],
): Array<{ bogey: T; body: string }> {
  return rows
    .map((bogey) => ({ bogey, body: snapshotBogeyEntryBody(bogey) }))
    .filter((e) => e.body !== "");
}
