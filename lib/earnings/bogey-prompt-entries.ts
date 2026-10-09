/**
 * What the earnings email's PROMPT prints from one bogey row, and therefore
 * which rows count for it.
 *
 * Owner ruling 2026-08-12 said an all-empty row is not coverage. The review of
 * that fix (2026-10-08) found the class was wider: a row can hold something the
 * composer does not print (a vendor EPS figure, an extra metric line, a segment
 * with no number), and the prompt then listed an entry with nothing under it,
 * possibly as entry [1], the one it calls "the primary consensus reference".
 *
 * So the rule here is about printing, not holding: build the row's printed
 * lines first, and a row with none is not an entry. `renderBogeysBlock`
 * (lib/digest/send-earnings-email.ts) renders from `bogeysPrintedInPrompt` and
 * the prompt context is filtered through it, so the count and the rendering
 * cannot disagree.
 *
 * PARITY (Worker: workers/cron/src/bogey-content.ts::snapshotBogeysPrinted).
 * The two sides agree on which rows count for every column both carry. The one
 * documented difference: `extra_metrics_json` is not in the nightly snapshot,
 * so an extras-only row counts here and not in the cloud.
 * tests/earnings/bogey-content-worker-parity.test.ts pins both.
 *
 * Every figure here is public market data (consensus, whisper, expected move).
 * Nothing portfolio-derived is read.
 */
import { formatLargeUSD } from "@/lib/format";
import {
  parseExtraMetrics,
  type ExtraMetricSpec,
} from "@/lib/print-watch/extra-metrics";
import type { EarningsBogey } from "@/lib/queries/earnings-bogeys";

/** The columns the prompt block prints from. */
export type BogeyPromptFields = Pick<
  EarningsBogey,
  | "eps_consensus"
  | "eps_whisper"
  | "revenue_consensus_usd"
  | "revenue_whisper_usd"
  | "expected_move_pct"
  | "eps_consensus_vendor"
  | "segment_breakdown_json"
  | "guidance_notes"
  | "notes"
  | "extra_metrics_json"
>;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const hasText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** One line per segment that carries a figure. A segment with none is not a line. */
function segmentLines(json: string | null): string[] {
  if (!hasText(json)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return []; // Stored JSON malformed: nothing to print.
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const lines: string[] = [];
  for (const [name, vals] of Object.entries(parsed as Record<string, unknown>)) {
    if (!vals || typeof vals !== "object") continue;
    const v = vals as { consensus?: unknown; whisper?: unknown };
    const segFields: string[] = [];
    if (finite(v.consensus)) segFields.push(`consensus ${formatLargeUSD(v.consensus)}`);
    if (finite(v.whisper)) segFields.push(`whisper ${formatLargeUSD(v.whisper)}`);
    if (segFields.length > 0) lines.push(`  - ${name}: ${segFields.join(", ")}`);
  }
  return lines;
}

const PERIOD_LABEL: Record<ExtraMetricSpec["period"], string> = {
  Q: "this quarter",
  NQ_guide: "next-quarter guide",
  FY_guide: "full-year guide",
};

function formatExtraValue(n: number, unit: ExtraMetricSpec["unit"]): string {
  if (unit === "usd") return formatLargeUSD(n);
  if (unit === "per_share") return n.toFixed(2);
  if (unit === "pct") return `${n}%`;
  return n.toLocaleString("en-US");
}

/** One line per desk-defined extra metric that carries a figure. Read through
 *  `parseExtraMetrics` (all-or-nothing: an invalid stored value prints nothing). */
function extraMetricLines(json: string | null): string[] {
  const lines: string[] = [];
  for (const spec of parseExtraMetrics(json).specs) {
    const figures: string[] = [];
    if (finite(spec.consensus)) figures.push(`consensus ${formatExtraValue(spec.consensus, spec.unit)}`);
    if (finite(spec.whisper)) figures.push(`whisper ${formatExtraValue(spec.whisper, spec.unit)}`);
    if (figures.length === 0) continue;
    const basis = spec.basis === "gaap" ? ", GAAP" : spec.basis === "non_gaap" ? ", non-GAAP" : "";
    lines.push(`  - ${spec.label} (${PERIOD_LABEL[spec.period]}${basis}): ${figures.join(", ")}`);
  }
  return lines;
}

/** The vendor's EPS consensus, labelled as the vendor's (D1: its basis is not
 *  stated, so it is never printed as "EPS consensus"). */
function vendorEpsField(b: BogeyPromptFields): string | null {
  return finite(b.eps_consensus_vendor)
    ? `vendor EPS consensus ${b.eps_consensus_vendor.toFixed(2)} (basis unspecified)`
    : null;
}

/** True when the entry prints the vendor EPS line. */
export function bogeyPrintsVendorEps(b: BogeyPromptFields): boolean {
  return vendorEpsField(b) !== null;
}

/**
 * Everything the prompt prints under one entry's heading, each line led by a
 * newline. "" when the row has nothing the prompt prints: such a row is not an
 * entry. For a row of curated figures the text is unchanged from before this
 * helper existed.
 */
export function bogeyPromptEntryBody(b: BogeyPromptFields): string {
  const fields: string[] = [];
  if (finite(b.eps_consensus)) fields.push(`EPS consensus ${b.eps_consensus.toFixed(2)}`);
  if (finite(b.eps_whisper)) fields.push(`EPS **whisper ${b.eps_whisper.toFixed(2)}**`);
  const vendor = vendorEpsField(b);
  if (vendor) fields.push(vendor);
  if (finite(b.revenue_consensus_usd)) fields.push(`revenue consensus ${formatLargeUSD(b.revenue_consensus_usd)}`);
  if (finite(b.revenue_whisper_usd)) fields.push(`revenue **whisper ${formatLargeUSD(b.revenue_whisper_usd)}**`);
  if (finite(b.expected_move_pct)) fields.push(`expected move ±${b.expected_move_pct.toFixed(1)}%`);
  const head = fields.length > 0 ? `\n${fields.join(" · ")}` : "";

  const segLines = segmentLines(b.segment_breakdown_json);
  const segs = segLines.length > 0 ? `\nSegment splits:\n${segLines.join("\n")}` : "";
  const extraLines = extraMetricLines(b.extra_metrics_json);
  const extras = extraLines.length > 0 ? `\nExtra metrics:\n${extraLines.join("\n")}` : "";
  const guidance = hasText(b.guidance_notes) ? `\nGuidance: ${b.guidance_notes}` : "";
  const notes = hasText(b.notes) ? `\nNotes: ${b.notes}` : "";
  return `${head}${segs}${extras}${guidance}${notes}`;
}

/**
 * The rows the prompt block lists, in the order given, each with the text it
 * prints. THE one reader for "does this event have bogeys, as far as the email
 * prompt is concerned": a row with an empty body is left out.
 */
export function bogeysPrintedInPrompt<T extends BogeyPromptFields>(
  rows: readonly T[],
): Array<{ bogey: T; body: string }> {
  return rows
    .map((bogey) => ({ bogey, body: bogeyPromptEntryBody(bogey) }))
    .filter((e) => e.body !== "");
}
