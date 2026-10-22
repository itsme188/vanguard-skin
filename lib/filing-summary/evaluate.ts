/**
 * App-side claim evaluation for the armed-print filing summary (spec §Figure
 * checking, Codex round 2 R1–R9, R17).
 *
 * The model returns claims as templates with typed figures, citations and
 * comparisons. This module decides, from the filing text and the frozen bogey
 * snapshot alone, what each claim's status is. It is the only place that may
 * say Checked or Contradicted, and it says them only on established evidence:
 *
 * - Checked: every figure bound (number, scale, period and label found in the
 *   cited line, or the bogey row), every computed figure recomputes, every
 *   comparison holds.
 * - Contradicted: a comparison or a computed figure whose operands are ALL
 *   established and whose arithmetic disagrees. A sourced number that does not
 *   match its quote is never contradicted (unconfirmed).
 *
 * Figure binding lives in `evaluate-figures.ts`. Pure: no database, no clock.
 */
import { locateQuote, toFootnote, type LocatedQuote } from "./locate";
import { FIGURE_REASON_CODES, checkRelation, computeOp, matchesWithRounding, type Operand } from "./figures";
import {
  basisCompat,
  bindBogeyFigure,
  bindQuoteFigure,
  figurePeriod,
  periodsEqual,
  reason,
  statedNumber,
  type ResolvedFigure,
  type SourcePeriod,
} from "./evaluate-figures";
import type {
  BogeySnapshotFigure,
  CheckReason,
  CheckedClaim,
  CheckedSection,
  ClaimStatus,
  ComparisonCheck,
  DocText,
  FigureCheck,
  Footnote,
  ModelClaim,
  ModelComparison,
  ModelFigure,
  ModelSectionOutput,
  StatusCounts,
} from "./types";
import { STATUS_SEVERITY } from "./types";

export const CHECKER_VERSION = 1;

// ---------------------------------------------------------------------------
// Reason codes and the status each one implies
// ---------------------------------------------------------------------------

/** The status a reason pushes its claim to; "info" never changes the status. */
const REASON_STATUS: Record<string, ClaimStatus | "info"> = {
  // contradicted (emitted only when every operand is established)
  relation_contradicted: "contradicted",
  computed_mismatch: "contradicted",
  // figure not bound (R1, controller ruling 8)
  unbound_digit: "figure_not_bound",
  dangling_placeholder: "figure_not_bound",
  dangling_citation: "figure_not_bound",
  dangling_operand: "figure_not_bound",
  dangling_input: "figure_not_bound",
  // periods differ (R5, R9: a warning, never contradicted)
  periods_differ: "periods_differ",
  bases_differ: "periods_differ",
  // not in the filing
  no_source: "not_in_filing",
  no_inputs: "not_in_filing",
  bogey_not_found: "not_in_filing",
  bogey_value_mismatch: "not_in_filing",
  // quotes
  quote_not_found: "quote_not_found",
  ambiguous_quote: "ambiguous_quote",
  // unconfirmed
  value_not_in_quote: "unconfirmed",
  value_text_mismatch: "unconfirmed",
  label_missing: "unconfirmed",
  label_not_in_quote: "unconfirmed",
  metric_unconfirmed: "unconfirmed",
  scale_unconfirmed: "unconfirmed",
  period_unconfirmed: "unconfirmed",
  column_ambiguous: "unconfirmed",
  basis_unconfirmed: "unconfirmed",
  operand_unconfirmed: "unconfirmed",
  input_unconfirmed: "unconfirmed",
  input_not_sourced: "unconfirmed",
  inputs_not_shown: "unconfirmed",
  no_operation: "unconfirmed",
  compute_undefined: "unconfirmed",
  no_citation: "unconfirmed",
  zero_comparator: "unconfirmed",
  unit_mismatch: "unconfirmed",
  range_operand_unsupported: "unconfirmed",
  non_finite_operand: "unconfirmed",
  // information only
  computed: "info",
  correction_unresolved: "info",
};

/** Every reason code this checker can emit (figures.ts codes included), de-duplicated. */
export const REASON_CODES: readonly string[] = [...new Set([...Object.keys(REASON_STATUS), ...FIGURE_REASON_CODES])];

/** The status a stored reason code implies (unknown codes read as unconfirmed). */
export function reasonStatus(code: string): ClaimStatus | "info" {
  return REASON_STATUS[code] ?? "unconfirmed";
}

/** Worst first. Warnings in the order the brief lists them (step 7). */
const PRECEDENCE: ClaimStatus[] = [
  "contradicted", "periods_differ", "not_in_filing", "quote_not_found", "ambiguous_quote", "figure_not_bound", "unconfirmed",
];

// ---------------------------------------------------------------------------
// R1: rendering a template
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{([A-Za-z][\w.-]*)\}/g;
// Digits that are identifiers, not quantities: a year, an Item number, an
// exhibit number, an SEC form name ("8-K", "10-Q", "PRE 14C", "424B3").
const ALLOWED_DIGITS: RegExp[] = [
  /\b(?:19|20)\d\d\b/g,
  /\bItems?\s+\d+(?:\.\d+)?/gi,
  /\bEX-\d+(?:\.\d+)*/gi,
  /\bExhibits?\s+\d+(?:\.\d+)*/gi,
  /\b(?:8-K|10-K|10-Q|6-K|20-F|40-F|S-[1348](?:ASR)?|F-[13]|424B\d)(?:\/A)?(?![\w])/gi,
  /\b(?:PRE|DEF|DEFA|DEFM)\s*14[AC]\b/gi,
  /\bSC\s+(?:TO-[IT]|13[DG])\b/gi,
  /\bForms?\s+(?:144|[345])\b/gi,
];

function hasStrayDigit(text: string): boolean {
  let t = text;
  for (const re of ALLOWED_DIGITS) t = t.replace(re, " ");
  return /\d/.test(t);
}

/** Placeholder ids a template uses, in order. */
function placeholderIds(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/**
 * Fill `{fN}` with that figure's `valueText`. `unbound` when a placeholder
 * names no figure of the claim, or a digit sits outside the placeholders that
 * is not a year, an Item / exhibit number or a form name (R1). An unknown
 * placeholder is left as written.
 */
export function renderClaimText(claim: ModelClaim): { text: string; unbound: boolean } {
  const byId = new Map(claim.figures.map((f) => [f.id, f]));
  let unbound = false;
  const text = claim.text.replace(PLACEHOLDER, (whole: string, id: string) => {
    const f = byId.get(id);
    if (!f) {
      unbound = true;
      return whole;
    }
    return f.valueText;
  });
  if (hasStrayDigit(claim.text.replace(PLACEHOLDER, " "))) unbound = true;
  return { text, unbound };
}

// ---------------------------------------------------------------------------
// Computed figures (R8)
// ---------------------------------------------------------------------------

function addMonths(iso: string, months: number): Date {
  const [y, m, d] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  const wasLast = d === new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, wasLast ? last : Math.min(d, last)));
}

/** Within a week: a 52/53-week fiscal calendar moves its period ends by a day or two. */
function withinWeek(a: Date, iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.abs(a.getTime() - Date.UTC(y, m - 1, d)) <= 7 * 86_400_000;
}

/** R8: `old` ends one year (or, for a quarter, one quarter) before `new`. Null = cannot tell. */
function isPriorPeriod(nw: SourcePeriod, old: SourcePeriod): boolean | null {
  if (nw.kind !== old.kind || nw.role !== old.role) return false;
  if (nw.endDate && old.endDate) {
    if (withinWeek(addMonths(nw.endDate, -12), old.endDate)) return true;
    return nw.kind === "quarter" && withinWeek(addMonths(nw.endDate, -3), old.endDate);
  }
  if (nw.endDate || old.endDate || nw.fiscalYear === null || old.fiscalYear === null) return null;
  if (nw.kind === "fiscal_year") return old.fiscalYear === nw.fiscalYear - 1;
  if (nw.fiscalQuarter === null || old.fiscalQuarter === null) return null;
  if (old.fiscalYear === nw.fiscalYear - 1 && old.fiscalQuarter === nw.fiscalQuarter) return true;
  if (nw.kind !== "quarter") return false;
  const prevQ = nw.fiscalQuarter === 1 ? { y: nw.fiscalYear - 1, q: 4 } : { y: nw.fiscalYear, q: nw.fiscalQuarter - 1 };
  return old.fiscalYear === prevQ.y && old.fiscalQuarter === prevQ.q;
}

function evalComputed(fig: ModelFigure, byId: Map<string, ResolvedFigure>, shownIds: Set<string>): ResolvedFigure {
  const out: ResolvedFigure = {
    figure: fig, established: false, contradicted: false, units: null, unit: fig.unit,
    period: null, basis: fig.basis, table: null, reasons: [],
  };
  const add = (code: string, detail: string) => out.reasons.push(reason(code, fig.id, detail));
  if (fig.inputs.length === 0) { add("no_inputs", "a computed figure with no inputs is not from the filing"); return out; }
  if (!fig.operation) { add("no_operation", "a computed figure must name its operation"); return out; }

  const inputs: ResolvedFigure[] = [];
  for (const id of fig.inputs) {
    const r = byId.get(id);
    if (!r) { add("dangling_input", `input ${id} is not a figure of this claim`); continue; }
    if (r.figure.sourceKind === "computed") { add("input_not_sourced", `input ${id} is itself computed`); continue; }
    if (!r.established) add("input_unconfirmed", `input ${id} is not established`);
    if (!shownIds.has(id)) add("inputs_not_shown", `input ${id} is not shown in the claim text`);
    inputs.push(r);
  }
  if (out.reasons.length > 0) return out;

  const op = fig.operation;
  const unit = inputs[0].unit;
  if (inputs.some((r) => r.unit !== unit)) { add("unit_mismatch", "the inputs are in different units"); return out; }
  const wantUnit = op === "growth" || op === "ratio" ? "percent" : unit;
  if (fig.unit !== wantUnit) { add("unit_mismatch", `${op} gives ${wantUnit}, the figure says ${fig.unit}`); return out; }

  // Periods: difference / sum / ratio need one period; growth needs new vs the prior year (or quarter).
  if (op === "growth") {
    if (inputs.length !== 2) { add("compute_undefined", "growth takes exactly two inputs (new, old)"); return out; }
    const [nw, old] = inputs;
    const prior = nw.period && old.period ? isPriorPeriod(nw.period, old.period) : null;
    if (prior === false) add("periods_differ", "the old input does not end a year (or quarter) before the new one");
    if (prior === null) add("period_unconfirmed", "the inputs' periods cannot be placed a year apart");
  } else {
    for (const r of inputs.slice(1)) {
      const same = periodsEqual(inputs[0], r);
      if (same === false) add("periods_differ", `inputs ${inputs[0].figure.id} and ${r.figure.id} are for different periods`);
      if (same === null) add("period_unconfirmed", `inputs ${inputs[0].figure.id} and ${r.figure.id} cannot be matched by period`);
    }
  }
  const basis = basisCompat(inputs);
  if (basis === "differ") add("bases_differ", "the inputs are on different bases");
  if (basis === "unknown") add("basis_unconfirmed", "an input's basis is unknown");

  // The result's period: the shared period, or the NEW input's for growth.
  out.period = inputs[0].period;
  out.table = inputs.find((r) => r.table)?.table ?? null;
  out.basis = inputs.find((r) => !r.basis.startsWith("guidance_"))?.basis ?? inputs[0].basis;
  // The claim's own period label for the result must agree with the inputs.
  if (out.period) {
    const self = periodsEqual({ ...out, period: { ...figurePeriod(fig), anchor: null } }, out);
    if (self === false) add("periods_differ", `the inputs are for another period than ${fig.period.label}`);
    if (self === null) add("period_unconfirmed", `${fig.period.label} cannot be matched to the inputs' period`);
  }

  const result = computeOp(op, inputs.map((r) => r.units as number));
  if (result === null) { add("compute_undefined", `${op} is undefined for these inputs`); return out; }
  const stated = statedNumber(fig);
  if (!stated) { add("value_text_mismatch", `the shown text "${fig.valueText}" does not state the typed value`); return out; }
  const blocking = out.reasons.length > 0;
  if (matchesWithRounding(stated, result)) {
    out.units = result;
    out.established = !blocking;
    if (!blocking) add("computed", `computed: ${op} of ${fig.inputs.join(", ")}`);
    return out;
  }
  // Every input established and of one unit; a period or basis doubt keeps it from contradicted.
  if (!blocking) {
    out.contradicted = true;
    add("computed_mismatch", `recomputed ${formatNumber(result, wantUnit)}; stated ${fig.valueText}`);
  }
  return out;
}

function formatNumber(units: number, unit: string): string {
  return unit === "percent" ? `${units.toFixed(2)}%` : String(Math.round(units * 100) / 100);
}

// ---------------------------------------------------------------------------
// Comparisons (R7)
// ---------------------------------------------------------------------------

function evalComparison(cmp: ModelComparison, byId: Map<string, ResolvedFigure>): ComparisonCheck {
  const check: ComparisonCheck = {
    relation: cmp.relation, verdict: "unconfirmed", difference: null, differencePct: null, shownText: null, reasons: [],
  };
  const add = (code: string, detail: string) => check.reasons.push(reason(code, null, detail));
  const ids = [cmp.left, cmp.leftHigh, cmp.right, cmp.rightHigh].filter((x): x is string => x !== null);
  for (const id of ids) {
    if (!byId.has(id)) check.reasons.push(reason("dangling_operand", id, `comparison operand ${id} is not a figure of this claim`));
  }
  if (check.reasons.length > 0) return check;
  const get = (id: string | null) => (id === null ? null : (byId.get(id) as ResolvedFigure));
  const [L, LH, R, RH] = [get(cmp.left), get(cmp.leftHigh), get(cmp.right), get(cmp.rightHigh)] as [
    ResolvedFigure, ResolvedFigure | null, ResolvedFigure, ResolvedFigure | null,
  ];
  const ops = [L, LH, R, RH].filter((x): x is ResolvedFigure => x !== null);
  const unsettled = ops.filter((r) => !r.established);
  if (unsettled.length > 0) {
    for (const r of unsettled) add("operand_unconfirmed", `operand ${r.figure.id} is not established`);
    return check;
  }

  let differ = false;
  let unsure = false;
  const pairs: Array<[ResolvedFigure, ResolvedFigure]> = [[L, R]];
  if (LH) pairs.push([L, LH]);
  if (RH) pairs.push([R, RH]);
  for (const [a, b] of pairs) {
    const same = periodsEqual(a, b);
    if (same === false) { differ = true; add("periods_differ", `${a.figure.id} and ${b.figure.id} are for different periods`); }
    if (same === null) { unsure = true; add("period_unconfirmed", `${a.figure.id} and ${b.figure.id} cannot be matched by period`); }
  }
  const basis = basisCompat(ops);
  if (basis === "differ") { differ = true; add("bases_differ", "the operands are on different bases"); }
  if (basis === "unknown") { unsure = true; add("basis_unconfirmed", "an operand's basis is unknown"); }
  if ((LH && LH.unit !== L.unit) || (RH && RH.unit !== R.unit)) { unsure = true; add("unit_mismatch", "a range's ends are in different units"); }
  if (differ) { check.verdict = "periods_differ"; return check; }
  if (unsure) return check;

  const operand = (lo: ResolvedFigure, hi: ResolvedFigure | null): Operand =>
    hi ? { units: lo.units as number, unit: lo.unit, low: lo.units as number, high: hi.units as number }
      : { units: lo.units as number, unit: lo.unit };
  const rel = checkRelation(cmp.relation, operand(L, LH), operand(R, RH));
  check.verdict = rel.verdict;
  check.difference = rel.difference;
  check.differencePct = rel.differencePct;
  check.shownText = rel.shownText;
  check.reasons.push(...rel.reasons);
  if (rel.verdict === "contradicted") {
    add("relation_contradicted", `the filing's figures do not support "${cmp.relation}"${rel.shownText ? ` (${rel.shownText})` : ""}`);
  }
  return check;
}

// ---------------------------------------------------------------------------
// One claim
// ---------------------------------------------------------------------------

interface ClaimContext {
  docs: Array<{ fileName: string; text: DocText }>;
  cik: string;
  accession: string;
  eventDate: string;
  bogeys: BogeySnapshotFigure[];
  priorIds: Set<string>;
}

function deriveStatus(claim: ModelClaim, reasons: CheckReason[]): ClaimStatus {
  const hit = new Set<ClaimStatus>();
  for (const r of reasons) {
    const s = reasonStatus(r.code);
    if (s !== "info") hit.add(s);
  }
  for (const s of PRECEDENCE) if (hit.has(s)) return s;
  return claim.figures.length === 0 && claim.comparisons.length === 0 ? "qualitative" : "checked";
}

function evaluateClaim(claim: ModelClaim, top: boolean, routine: boolean, ctx: ClaimContext): CheckedClaim {
  const claimReasons: CheckReason[] = [];
  const rendered = renderClaimText(claim);
  const figureIds = new Set(claim.figures.map((f) => f.id));
  for (const id of placeholderIds(claim.text)) {
    if (!figureIds.has(id)) claimReasons.push(reason("dangling_placeholder", null, `placeholder {${id}} names no figure`));
  }
  if (hasStrayDigit(claim.text.replace(PLACEHOLDER, " "))) {
    claimReasons.push(reason("unbound_digit", null, "the claim text has a number outside a typed figure"));
  }
  if (claim.citations.length === 0) claimReasons.push(reason("no_citation", null, "the claim cites nothing"));

  // Footnotes: one per citation; page breaks are the LOCATED document's (ruling 5).
  const located = new Map<string, LocatedQuote>();
  const footnotes: Footnote[] = [];
  for (const c of claim.citations) {
    const loc = locateQuote(ctx.docs, c);
    located.set(c.id, loc);
    const reliable = ctx.docs.find((d) => d.fileName === loc.fileName)?.text.pageBreaksReliable ?? false;
    footnotes.push(toFootnote(ctx.cik, ctx.accession, c, loc, reliable));
    if (loc.status === "not_found") claimReasons.push(reason("quote_not_found", null, `citation ${c.id} is not in the filing`));
    if (loc.status === "ambiguous") claimReasons.push(reason("ambiguous_quote", null, `citation ${c.id} matches more than one place`));
  }

  // Quote and bogey figures first; computed figures read them.
  const byId = new Map<string, ResolvedFigure>();
  for (const f of claim.figures) {
    if (f.sourceKind === "computed") continue;
    let r: ResolvedFigure;
    if (f.sourceKind === "bogey") {
      r = bindBogeyFigure(f, ctx.bogeys);
    } else if (f.citationId === null) {
      r = { figure: f, established: false, contradicted: false, units: null, unit: f.unit, period: null, basis: f.basis, table: null,
        reasons: [reason("no_source", f.id, "a quoted figure with no citation")] };
    } else {
      const loc = located.get(f.citationId);
      r = loc
        ? bindQuoteFigure(f, loc, ctx.docs, ctx.eventDate)
        : { figure: f, established: false, contradicted: false, units: null, unit: f.unit, period: null, basis: f.basis, table: null,
          reasons: [reason("dangling_citation", f.id, `citation ${f.citationId} is not a citation of this claim`)] };
    }
    byId.set(f.id, r);
  }
  const shownIds = new Set(placeholderIds(claim.text));
  for (const f of claim.figures) {
    if (f.sourceKind === "computed") byId.set(f.id, evalComputed(f, byId, shownIds));
  }

  const figureChecks: FigureCheck[] = claim.figures.map((f) => {
    const r = byId.get(f.id) as ResolvedFigure;
    return { figureId: f.id, established: r.established, foundValue: r.units, reasons: r.reasons };
  });
  const comparisonChecks = claim.comparisons.map((c) => evalComparison(c, byId));

  // R17: a correction resolves only when its own citation is found and the earlier claim exists.
  let correction: CheckedClaim["correction"] = null;
  if (claim.corrects) {
    const fn = footnotes.find((x) => x.citationId === claim.corrects?.citationId) ?? null;
    const resolved = fn !== null && fn.status === "found" && ctx.priorIds.has(claim.corrects.claimId);
    correction = { claimId: claim.corrects.claimId, resolved, footnote: fn };
    if (!resolved) claimReasons.push(reason("correction_unresolved", null, `the correction of ${claim.corrects.claimId} is unresolved`));
  }

  const reasons = [
    ...claimReasons,
    ...figureChecks.flatMap((f) => f.reasons),
    ...comparisonChecks.flatMap((c) => c.reasons),
  ];
  return {
    claimId: claim.id,
    renderedText: rendered.text,
    status: deriveStatus(claim, reasons),
    top,
    routine,
    footnotes,
    figureChecks,
    comparisonChecks,
    reasons,
    correction,
  };
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export interface EvaluateSectionInput {
  output: ModelSectionOutput;
  docs: Array<{ fileName: string; text: DocText }>;
  cik: string;
  accession: string;
  eventDate: string;
  bogeys: BogeySnapshotFigure[];
  priorClaims: CheckedClaim[];
}

/** Check every claim of one section. A headline carrying a stray digit is blanked (ruling 7). */
export function evaluateSection(input: EvaluateSectionInput): CheckedSection {
  const ctx: ClaimContext = {
    docs: input.docs,
    cik: input.cik,
    accession: input.accession,
    eventDate: input.eventDate,
    bogeys: input.bogeys,
    priorIds: new Set(input.priorClaims.map((c) => c.claimId)),
  };
  const claims: CheckedClaim[] = [];
  for (const b of input.output.bullets) {
    for (const c of b.claims) claims.push(evaluateClaim(c, b.top, b.routine, ctx));
  }
  const headline = hasStrayDigit(input.output.headline) ? "" : input.output.headline;
  return { headline, claims, counts: countStatuses(claims) };
}

/** Counts for the panel heading, the push and the export. `warning` = every warning-colour status. */
export function countStatuses(claims: CheckedClaim[]): StatusCounts {
  const counts: StatusCounts = { claims: claims.length, checked: 0, contradicted: 0, warning: 0, unconfirmed: 0, qualitative: 0 };
  for (const c of claims) {
    if (c.status === "checked") counts.checked++;
    else if (c.status === "contradicted") counts.contradicted++;
    else if (c.status === "unconfirmed") counts.unconfirmed++;
    else if (c.status === "qualitative") counts.qualitative++;
    else if (STATUS_SEVERITY[c.status] === "warning") counts.warning++;
  }
  return counts;
}

