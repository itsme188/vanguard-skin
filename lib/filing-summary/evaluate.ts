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
import { FIGURE_REASON_CODES } from "./figures";
import {
  bindBogeyFigure,
  bindQuoteFigure,
  emptyResolved,
  reason,
  valueTextHasExtraDigit,
  type ResolvedFigure,
} from "./evaluate-figures";
import { evalComparison, evalComputed } from "./evaluate-arith";
import { sectionAnchors, type SectionAnchors } from "./evaluate-periods";
import type {
  BogeySnapshotFigure,
  CheckReason,
  CheckedClaim,
  CheckedSection,
  ClaimStatus,
  DocText,
  FigureCheck,
  Footnote,
  ModelClaim,
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
  unbound_value_text: "figure_not_bound",
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
  within_rounding: "unconfirmed",
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

/** Worst first, in the declaration order of `ClaimStatus` (types.ts). */
const PRECEDENCE: ClaimStatus[] = [
  "contradicted", "figure_not_bound", "periods_differ", "not_in_filing", "quote_not_found", "ambiguous_quote", "unconfirmed",
];

// ---------------------------------------------------------------------------
// R1: rendering a template
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{([A-Za-z][\w.-]*)\}/g;
// Digits that are identifiers, not quantities: a year, an Item number, an
// exhibit number, an SEC form name ("8-K", "10-Q", "PRE 14C", "424B3").
const ALLOWED_DIGITS: RegExp[] = [
  /\b(?:19|20)\d\d\b/g,
  /\bItem \d{1,2}(?:\.\d{2})?(?!\d)(?!\.\d)/g, // a sentence period may follow ("Item 7.")
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
 * names no figure of the claim, a placed figure's valueText carries a digit
 * beyond its one number, or a digit sits outside the placeholders that is not
 * a year, an Item / exhibit number or a form name (R1). An unknown placeholder
 * is left as written.
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
    if (valueTextHasExtraDigit(f.valueText)) unbound = true;
    return f.valueText;
  });
  if (hasStrayDigit(claim.text.replace(PLACEHOLDER, " "))) unbound = true;
  return { text, unbound };
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
  anchors: SectionAnchors;
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
  for (const id of new Set(placeholderIds(claim.text))) {
    const f = claim.figures.find((x) => x.id === id);
    if (f && valueTextHasExtraDigit(f.valueText)) {
      claimReasons.push(reason("unbound_value_text", f.id, `the shown text "${f.valueText}" carries a number besides the figure`));
    }
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
      r = bindBogeyFigure(f, ctx.bogeys, ctx.anchors);
    } else if (f.citationId === null) {
      r = emptyResolved(f, [reason("no_source", f.id, "a quoted figure with no citation")]);
    } else {
      const loc = located.get(f.citationId);
      r = loc
        ? bindQuoteFigure(f, loc, ctx.docs, ctx.eventDate)
        : emptyResolved(f, [reason("dangling_citation", f.id, `citation ${f.citationId} is not a citation of this claim`)]);
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
    anchors: sectionAnchors(input.docs, input.eventDate),
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

