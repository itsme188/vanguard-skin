/**
 * Watch metrics: the company-specific figures a print is judged on, read out
 * of a preview (newsletter or uploaded bogey sheet) and stored as desk extra
 * metric lines (`earnings_bogeys.extra_metrics_json`, spec §4.7).
 *
 * Total revenue and EPS always have a line on the sheet. What a preview adds is
 * the rest: Micron's gross margin and its gross-margin guide, Nike's Greater
 * China revenue, a software name's net new ARR. Before this module the two
 * extractors folded those into free-text `guidance_notes`, so the live sheet
 * never had a line for them and the release parser never looked for them.
 *
 * A line may carry the author's numbers (consensus = Street, whisper = the
 * buyside figure) or none: a topic the author flags ("China recovery") becomes
 * a line for the printed figure that measures it, with no bogey. Either way
 * `compileContracts` (lib/print-watch/contracts.ts) turns it into a sheet line
 * the extractor fills at print time.
 *
 * WHAT THIS MODULE GUARANTEES
 *   - Every spec it returns passes `parseExtraMetrics`, the validator the
 *     bogeys route and the modal use, so a stored value never fails on read.
 *   - Labels and definitions reach the release-extraction prompt
 *     (`LineContract.label` / `.definition`), which must stay value-free: a
 *     label carrying a figure is dropped and a definition carrying one is
 *     replaced (`carriesFigure`).
 *   - The id is DERIVED from the line's identity (name, period, unit, basis),
 *     so two issues of one newsletter, or two newsletters, that name the same
 *     figure land on one sheet line (`mergeExtraMetrics` merges by id).
 *   - A merge into a stored row never drops or rewrites a stored spec: the
 *     desk's edits win, and an unreadable stored value is left untouched.
 */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { parseLargeUSD } from "@/lib/format";
import {
  parseExtraMetrics,
  MAX_LABEL,
  type ExtraMetricBasis,
  type ExtraMetricKind,
  type ExtraMetricPeriod,
  type ExtraMetricSpec,
  type ExtraMetricUnit,
} from "@/lib/print-watch/extra-metrics";

/** Lines one extraction may add for one company. A preview that names more is
 *  listing everything, not flagging what matters. */
export const MAX_WATCH_METRICS_PER_EXTRACTION = 6;
/** Lines one stored row may hold after merging later issues into it. */
export const MAX_WATCH_METRICS_PER_ROW = 10;
/** Shorter than the validator's 300: the definition is prompt text. */
const MAX_WATCH_DEFINITION = 200;

const UNITS: readonly ExtraMetricUnit[] = ["usd", "per_share", "pct", "count"];
const PERIODS: readonly ExtraMetricPeriod[] = ["Q", "NQ_guide", "FY_guide"];
const BASES: readonly ExtraMetricBasis[] = ["gaap", "non_gaap", "na"];

const PERIOD_TEXT: Record<ExtraMetricPeriod, string> = {
  Q: "the quarter being reported",
  NQ_guide: "next-quarter guidance",
  FY_guide: "full-year guidance",
};

/**
 * The prompt block both extractors append. One copy, so the newsletter scan and
 * the PDF upload ask for the same thing in the same words.
 */
export const WATCH_METRICS_INSTRUCTIONS = [
  `WATCH METRICS ("watch_metrics", an array, [] when none):`,
  `The sheet always has lines for total revenue and total EPS for the quarter, and for next-quarter total revenue and EPS guidance. List the OTHER specific figures the author says this print will be judged on: margins (gross, operating), segment or region revenue or growth, KPIs (ARR, net new ARR, NRR, cRPO, RPO, bookings, subscribers, units, deliveries, same-store sales), and full-year or next-quarter guidance for those figures.`,
  `- A TOPIC the author flags without a number still counts when the press release prints a figure that measures it: "China recovery" -> Greater China revenue growth; "margins are the debate" -> gross margin for the quarter AND the next-quarter gross margin guide. Give that line with consensus and whisper null. Skip a topic no printed figure measures (management tone, call commentary, buybacks talk).`,
  `- Never list total revenue or total EPS for the quarter, or total revenue / EPS guidance for the next quarter: those lines already exist.`,
  `- Each element: {"label": string, "definition": string, "unit": "usd"|"pct"|"per_share"|"count", "period": "Q"|"NQ_guide"|"FY_guide", "basis": "gaap"|"non_gaap"|"na", "consensus": number|null, "whisper": number|null}`,
  `  - label: the figure's plain name, at most 60 characters, with NO numbers in it ("Gross margin", "Greater China revenue growth", "Net new ARR").`,
  `  - definition: one sentence on how the company's press release states the figure, at most 200 characters, with NO bogey numbers in it.`,
  `  - period: "Q" = the quarter being reported; "NQ_guide" = guidance for the next quarter; "FY_guide" = full-year guidance.`,
  `  - basis: "non_gaap" for adjusted figures, "gaap" for GAAP, "na" when the distinction does not apply (revenue, units, ARR).`,
  `  - unit: "usd" figures are RAW dollars (1500000000, not "$1.5B"); "pct" figures are percent points as printed (56.5, never 0.565), and a growth rate is "pct"; use the unit the author's number is in.`,
  `  - consensus = the Street / sell-side number; whisper = the buyside or author's number. null when not given.`,
  `- At most ${MAX_WATCH_METRICS_PER_EXTRACTION} per company, most important first. When a line listed as already on the sheet is the same figure, reuse its label exactly.`,
].join("\n");

/**
 * A figure in prompt-bound text: a number with a unit or scale word attached,
 * a currency amount, an approximate number, or a decimal. Quarter and year
 * tokens ("FQ2", "FY27", "Q4") and model names ("H100", "5G") are not figures.
 */
export function carriesFigure(text: string): boolean {
  return (
    /\d[\d,]*(?:\.\d+)?\s*(?:%|bps?\b|bp\b|x\b|[bmk]\b|bn\b|mm\b|billion|million|thousand|percent|pts?\b)/i.test(text) ||
    /[$€£¥]\s*\d/.test(text) ||
    /[~≈]\s*\d/.test(text) ||
    /\d\.\d/.test(text)
  );
}

/** Words that name the basis or the period: both are separate fields of the
 *  spec, so they are left out of the identity key ("Gross margin (non-GAAP)"
 *  and "Non-GAAP gross margin" are one line). */
const KEY_NOISE = new Set([
  "gaap", "non", "nongaap", "adj", "adjusted", "reported", "guide", "guidance",
  "next", "quarter", "qtr", "q", "fq", "fy", "full", "year", "outlook", "the",
  "for", "of", "and", "y", "yoy",
]);

function identityTokens(label: string): string[] {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t !== "" && !KEY_NOISE.has(t) && !/^(?:f?q[1-4]|fy\d+|\d{2,4}|q\d)$/.test(t));
}

/**
 * Names that are the built-in total revenue / EPS lines. A watch metric under
 * one of these for the quarter or the next-quarter guide would be a second,
 * bogey-less copy of a line the sheet already has.
 */
const BUILT_IN_KEYS = new Set([
  "revenue", "revenues", "total revenue", "total revenues", "net revenue",
  "net revenues", "sales", "net sales", "total sales", "total net sales",
  "top line", "eps", "diluted eps", "earnings per share",
  "diluted earnings per share", "net income per share",
]);

function isBuiltInLine(label: string, period: ExtraMetricPeriod): boolean {
  if (period === "FY_guide") return false;
  return BUILT_IN_KEYS.has(identityTokens(label).join(" "));
}

/**
 * A uuid-v4-shaped id derived from the line's identity. Deterministic, so the
 * same figure named by two sources gets the same id and `mergeExtraMetrics`
 * folds them into one sheet line; the version and variant bits are set so the
 * validator's v4 check holds.
 */
export function watchMetricId(spec: {
  label: string;
  period: ExtraMetricPeriod;
  unit: ExtraMetricUnit;
  basis: ExtraMetricBasis;
}): string {
  const key = [identityTokens(spec.label).join(" "), spec.period, spec.unit, spec.basis].join("|");
  const h = createHash("sha256").update(`watch-metric:${key}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** One model-supplied figure, read for its unit. Anything unreadable is null:
 *  a missing bogey, never a guessed one. */
function readFigure(v: unknown, unit: ExtraMetricUnit): number | null {
  if (v == null) return null;
  if (unit === "usd") {
    if (typeof v !== "number" && typeof v !== "string") return null;
    const n = parseLargeUSD(v);
    return n != null && Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/%$/, "").trim();
  return /^[-+]?\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}

/**
 * Model output (any JSON) -> validated specs. Elements that fail any check are
 * dropped one by one; what survives is capped at
 * MAX_WATCH_METRICS_PER_EXTRACTION and deduplicated by id.
 */
export function parseWatchMetrics(raw: unknown): ExtraMetricSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtraMetricSpec[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_WATCH_METRICS_PER_EXTRACTION) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;

    const label = typeof o.label === "string" ? o.label.replace(/\s+/g, " ").trim() : "";
    if (label === "" || label.length > MAX_LABEL || carriesFigure(label)) continue;
    if (identityTokens(label).length === 0) continue;

    const unit = pick(o.unit, UNITS);
    const period = pick(o.period, PERIODS);
    const basis = pick(o.basis, BASES) ?? "na";
    if (!unit || !period) continue;
    // Kind follows the period and is never the model's call: it is one of the
    // fields `detectExtraMetricConflicts` compares, and the id does not carry
    // it, so two sources that guessed differently would block the line. A
    // guide read as a range still takes a point ("approximately 56%" is the
    // low end with no high end, extractor rule 8).
    const kind: ExtraMetricKind = period === "Q" ? "point" : "range";
    if (isBuiltInLine(label, period)) continue;

    let definition = typeof o.definition === "string" ? o.definition.replace(/\s+/g, " ").trim() : "";
    if (definition === "" || definition.length > MAX_WATCH_DEFINITION || carriesFigure(definition)) {
      definition = `${label}, ${PERIOD_TEXT[period]}.`;
    }

    const spec: ExtraMetricSpec = {
      id: watchMetricId({ label, period, unit, basis }),
      label,
      definition,
      unit,
      kind,
      period,
      basis,
      consensus: readFigure(o.consensus, unit),
      whisper: readFigure(o.whisper, unit),
    };
    if (seen.has(spec.id)) continue;
    // The validator the route and the modal use is the last word.
    if (parseExtraMetrics(JSON.stringify([spec])).errors.length > 0) continue;
    seen.add(spec.id);
    out.push(spec);
  }
  return out;
}

/**
 * Merge freshly extracted specs into a row's stored `extra_metrics_json`.
 *
 *   - A stored spec is never removed or rewritten, except that a figure it
 *     lacks is filled from an incoming spec with the same id.
 *   - A stored value that does not parse is returned unchanged: the desk sees
 *     the error in the modal, and nothing here overwrites what it cannot read.
 *   - Returns null when there is nothing at all to store.
 */
export function mergeWatchMetricsJson(
  storedJson: string | null,
  incoming: ExtraMetricSpec[],
): string | null {
  const stored = parseExtraMetrics(storedJson);
  if (stored.errors.length > 0) return storedJson;
  if (incoming.length === 0) return storedJson && stored.specs.length > 0 ? storedJson : null;

  const merged = stored.specs.map((s) => ({ ...s }));
  const byId = new Map(merged.map((s) => [s.id, s]));
  for (const spec of incoming) {
    const have = byId.get(spec.id);
    if (have) {
      if (have.consensus == null && spec.consensus != null) have.consensus = spec.consensus;
      if (have.whisper == null && spec.whisper != null) have.whisper = spec.whisper;
      continue;
    }
    if (merged.length >= MAX_WATCH_METRICS_PER_ROW) continue;
    merged.push({ ...spec });
    byId.set(spec.id, merged[merged.length - 1]);
  }
  if (merged.length === 0) return null;
  const json = JSON.stringify(merged);
  // Belt and braces: never hand the row a value its own reader would refuse.
  return parseExtraMetrics(json).errors.length > 0 ? storedJson : json;
}

/**
 * The extra metric lines already stored for an event, across every bogey row,
 * as prompt text ("Gross margin" [pct, Q, non_gaap]). Given to the newsletter
 * extractor so a later issue reuses the label and lands on the same line.
 */
export function existingWatchLinesForEvent(db: Database.Database, eventId: number): string[] {
  const rows = db
    .prepare(`SELECT extra_metrics_json FROM earnings_bogeys WHERE event_id = ? ORDER BY id ASC`)
    .all(eventId) as Array<{ extra_metrics_json: string | null }>;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const s of parseExtraMetrics(row.extra_metrics_json).specs) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      lines.push(`"${s.label}" [${s.unit}, ${s.period}, ${s.basis}]`);
    }
  }
  return lines;
}
