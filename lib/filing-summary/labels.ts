/**
 * The one copy of every word the filing summary shows the owner about a
 * claim status, a count, a model choice, a cost, a checker reason, a section
 * failure and a comparison. The full page, the print-row panel and the
 * shareable page all read it, so they cannot drift.
 *
 * Plain module: no client directive, no server import (value imports from
 * `types.ts` only; everything else is type-only), so client components may
 * import it.
 */
import { STATUS_SEVERITY, type ClaimStatus, type Relation, type StatusCounts, type SummaryChoice } from "./types";
import type { ChoiceOption, OperandDescriptor, ViewComparisonCheck } from "./view";

// ---------------------------------------------------------------- poll faults

/** Stored as the event's poll detail while the runner module cannot be loaded. */
export const RUNNER_LOAD_FAILED_DETAIL = "summary runner failed to load — report this";
/**
 * The settings key that records a runner load fault (its own record, so no
 * stored poll detail is ever overwritten by the fault).
 */
export const RUNNER_FAULT_SETTING_KEY = "filing_summary_runner_fault";
/** A late arm whose discovery pass failed `MAX_DISCOVERY_ATTEMPTS` times. */
export const DISCOVERY_GAVE_UP_DETAIL = "SEC discovery kept failing — Run summary unavailable";
/** A print still waiting when it left the tick's window (the app was not running at 9 pm). */
export const STALE_WAITING_DETAIL = "polling stopped before 9 pm (the app was not running) — nothing more will run on its own";
/** SEC was unreachable and the print has left the tick's window (today and yesterday). */
export const SEC_GAVE_UP_TEXT = "SEC was not reachable; nothing more will run on its own";

// ---------------------------------------------------------------- statuses

const STATUS_LABELS: Record<ClaimStatus, string> = {
  contradicted: "Contradicted",
  figure_not_bound: "Figure not tied to the filing",
  periods_differ: "Periods differ",
  not_in_filing: "Not in the filing",
  quote_not_found: "Quote not found",
  ambiguous_quote: "Quote matches more than once",
  unconfirmed: "Unconfirmed",
  checked: "Checked",
  qualitative: "Qualitative",
};

/** The status word on a claim's chip. */
export function statusLabel(status: ClaimStatus): string {
  return STATUS_LABELS[status] ?? "Unconfirmed";
}

/** The Chip tones a status can take (a subset of the app's `ChipTone`). */
export type StatusTone = "down" | "warn" | "neutral" | "up";

const TONE_BY_SEVERITY: Record<"danger" | "warning" | "muted" | "ok", StatusTone> = {
  danger: "down",
  warning: "warn",
  muted: "neutral",
  ok: "up",
};

/** The severity of a status (`STATUS_SEVERITY`; unknown reads muted). */
export function statusSeverity(status: ClaimStatus): "danger" | "warning" | "muted" | "ok" {
  return Object.prototype.hasOwnProperty.call(STATUS_SEVERITY, status) ? STATUS_SEVERITY[status] : "muted";
}

/** The Chip tone for a claim status: danger → down, warning → warn, muted → neutral, ok → up. */
export function statusTone(status: ClaimStatus): StatusTone {
  return TONE_BY_SEVERITY[statusSeverity(status)];
}

/** "12 claims · 9 checked · 1 contradicted · 2 unconfirmed" (zero parts left out). */
export function countsText(c: StatusCounts): string {
  const parts = [`${c.claims} ${c.claims === 1 ? "claim" : "claims"}`];
  if (c.checked) parts.push(`${c.checked} checked`);
  if (c.contradicted) parts.push(`${c.contradicted} contradicted`);
  if (c.warning) parts.push(`${c.warning} with warnings`);
  if (c.unconfirmed) parts.push(`${c.unconfirmed} unconfirmed`);
  if (c.qualitative) parts.push(`${c.qualitative} qualitative`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------- choices and cost

/** A stable `<option>` value for a choice: "opus·high". */
export function choiceValue(c: SummaryChoice): string {
  return `${c.family}·${c.effort}`;
}

/**
 * Rough cost by choice, keyed by `choiceValue`. Only Opus · high was measured
 * with the current prompt: about $0.80 for one 8-K section (Meta replay,
 * 2026-10-22). The other choices say how they compare, by list price per token.
 */
export const ROUGH_COST_BY_CHOICE: Record<string, string> = {
  "sonnet·medium": "Sonnet costs half as much per token as Opus",
  "opus·medium": "less than Opus · high",
  "opus·high": "about $0.80 per 8-K (measured); long filings cost more",
  "fable·medium": "Fable costs 2.5 times as much per token as Opus",
  "fable·high": "Fable costs 2.5 times as much per token as Opus",
};

export function roughCostText(c: SummaryChoice): string {
  return ROUGH_COST_BY_CHOICE[choiceValue(c)] ?? "cost not known";
}

/** "Fable · now 5.1" → "now 5.1"; "Fable · not available" → "not available". */
export function nowPart(nowLabel: string): string {
  const at = nowLabel.indexOf(" · ");
  return at === -1 ? nowLabel : nowLabel.slice(at + 3);
}

/** "Fable · high — now 5.1" (or "— not available"). */
export function optionText(o: Pick<ChoiceOption, "label" | "nowLabel"> & Partial<ChoiceOption>): string {
  return `${o.label} — ${nowPart(o.nowLabel)}`;
}

// ---------------------------------------------------------------- reasons

/** One owner-facing sentence per checker reason code (`REASON_CODES` in evaluate.ts). */
const REASON_SENTENCES: Record<string, string> = {
  relation_contradicted: "The filing's own figures do not support the stated comparison.",
  computed_mismatch: "The app's own calculation from the filing gives a different result.",
  unbound_digit: "The text has a number that is not tied to a checked figure.",
  unbound_value_text: "A figure's shown text carries a number besides the figure itself.",
  dangling_placeholder: "The text refers to a figure that was not supplied.",
  dangling_citation: "A figure points to a quote that was not supplied.",
  dangling_operand: "A comparison refers to a figure that was not supplied.",
  dangling_input: "A calculation refers to a figure that was not supplied.",
  periods_differ: "The figures compared cover different periods.",
  bases_differ: "The figures compared are on different bases (for example GAAP and adjusted).",
  no_source: "No quote or bogey backs this figure.",
  no_inputs: "A calculated figure lists no inputs.",
  bogey_not_found: "The bogey this figure cites is not in the pre-print snapshot.",
  bogey_value_mismatch: "The figure does not match the bogey it cites.",
  quote_not_found: "The quoted words were not found in the filing.",
  ambiguous_quote: "The quoted words appear more than once in the filing.",
  value_not_in_quote: "The number was not found in the quoted line.",
  value_text_mismatch: "The number as written does not match its value.",
  label_missing: "The figure has no line label to check against.",
  label_not_in_quote: "The line label was not found in the quote.",
  metric_unconfirmed: "The number is in the cited line, but the line's label does not name this metric.",
  scale_unconfirmed: "The scale (thousands, millions, billions) could not be confirmed.",
  period_unconfirmed: "The period could not be confirmed from the filing.",
  column_ambiguous: "The table column the number sits in could not be told apart.",
  basis_unconfirmed: "The basis (GAAP, adjusted, constant currency) could not be confirmed.",
  operand_unconfirmed: "A figure in the comparison could not be confirmed.",
  input_unconfirmed: "An input to the calculation could not be confirmed.",
  input_not_sourced: "An input to the calculation is not backed by a quote or bogey.",
  inputs_not_shown: "The inputs to the calculation are not shown.",
  no_operation: "A calculated figure does not say how it was calculated.",
  compute_undefined: "The calculation cannot be done (for example a division by zero).",
  no_citation: "The figure cites no quote.",
  zero_comparator: "The comparison is against zero, so a percentage difference is undefined.",
  unit_mismatch: "The figures compared are in different units.",
  range_operand_unsupported: "A range cannot be used in this kind of comparison.",
  non_finite_operand: "A figure in the comparison is not a usable number.",
  within_rounding: "The printed figures' rounding is too coarse to decide this either way.",
  range_bound: "The number is one end of a range the filing states, not a reported figure.",
  loss_sign_double: "The figure names a loss and is also written as a negative number; a loss is already negative.",
  computed: "The app calculated this figure from the filing.",
  correction_unresolved: "A later amendment says it corrects this, but its correcting quote was not found.",
};

/** A plain sentence for a reason code; an unknown code gets a neutral sentence. */
export function reasonText(code: string): string {
  return REASON_SENTENCES[code] ?? "This could not be confirmed against the filing.";
}

/** True when the code has its own sentence (a test iterates `REASON_CODES`). */
export function hasReasonText(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(REASON_SENTENCES, code);
}

// ---------------------------------------------------------------- section failures

/** What went wrong, per section error class, as a clause ("the model call timed out"). */
const ERROR_WORDS: Record<string, string> = {
  model_error: "the model call failed",
  timeout: "the model call timed out",
  refusal: "the model declined to answer",
  truncated: "the answer was cut off at the length limit",
  invalid_output: "the model's answer was not in the expected shape",
  model_unavailable: "the model is no longer available",
  input_too_large: "the filing is over the input cap",
  attempt_cap: "both attempts failed",
  takeover: "the attempt was interrupted",
  cancelled: "the summary was stopped",
  awaiting_retry: "waits for Retry",
};

/** Stored-text tokens that name the LAST failure of an attempt_cap section (never the cap itself or a wait). */
function lastFailureWords(errorText: string | null | undefined): string | null {
  if (!errorText || errorText === "attempt_cap" || errorText === "awaiting_retry") return null;
  return Object.prototype.hasOwnProperty.call(ERROR_WORDS, errorText) ? ERROR_WORDS[errorText] : null;
}

/**
 * The clause for an error class; null reads "no reason recorded", an unknown class is named as stored.
 * For `attempt_cap` the runner stores the last failure's class token as the error text; when that
 * token is a known class its clause is added ("both attempts failed — the model call failed").
 * Any other stored text is never printed.
 */
export function errorWords(errorClass: string | null, errorText?: string | null): string {
  if (!errorClass) return "no reason recorded";
  if (!Object.prototype.hasOwnProperty.call(ERROR_WORDS, errorClass)) return errorClass;
  return withLastFailure(errorClass, errorText);
}

function withLastFailure(errorClass: string, errorText: string | null | undefined): string {
  const base = ERROR_WORDS[errorClass];
  if (errorClass !== "attempt_cap") return base;
  const last = lastFailureWords(errorText);
  return last ? `${base} — ${last}` : base;
}

/**
 * The sentence for a section that is not summarised. The stored error text
 * is never printed: it is internal wording and the shareable page leaves the app.
 * Only for `attempt_cap`, a stored text that is a known class token is turned
 * into its clause (the last failure's reason).
 */
export function sectionErrorSentence(errorClass: string | null, errorText?: string | null): string {
  if (errorClass === "awaiting_retry") return "Waiting for Retry: this filing arrived after the run failed.";
  if (errorClass && Object.prototype.hasOwnProperty.call(ERROR_WORDS, errorClass)) {
    return `Not summarised: ${withLastFailure(errorClass, errorText)}.`;
  }
  return "Not summarised.";
}

// ---------------------------------------------------------------- bogeys

/** A bogey value as text: "$64.57B", "$1.85", "26.0%", or the plain number. */
export function bogeyValueText(b: { value: number; unit: string }): string {
  const v = b.value;
  const n = (x: number, d: number) =>
    x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  switch (b.unit) {
    case "usd": {
      const a = Math.abs(v);
      if (a >= 1e9) return `$${n(v / 1e9, 2)}B`;
      if (a >= 1e6) return `$${n(v / 1e6, 1)}M`;
      return `$${n(v, 0)}`;
    }
    case "usd_per_share":
      return `$${n(v, 2)}`;
    case "percent":
      return `${n(v, 1)}%`;
    default:
      return v.toLocaleString("en-US");
  }
}

// ---------------------------------------------------------------- comparisons

const STATED_RELATION: Record<Relation, string> = {
  above: "above",
  below: "below",
  in_line: "in line with",
  raised: "raised from",
  lowered: "lowered from",
  narrowed: "narrowed from",
  unchanged: "unchanged from",
};

/** An operand as text: "$64.601B", a range "$1.10–$1.20", plus "(Finnhub consensus, 2026-10-20)" for a bogey. */
export function operandText(low: OperandDescriptor | null, high?: OperandDescriptor | null): string {
  if (!low) return "a figure that was not supplied";
  const value = high ? `${low.displayText}–${high.displayText}` : low.displayText;
  const bogey = low.bogey ?? high?.bogey;
  return bogey ? `${value} (${bogey.provenance}, ${bogey.asOf})` : value;
}

/**
 * The relation words for a comparison line, from the app's arithmetic, never
 * from the model's claim when the claim is contradicted (figures.ts):
 * - narrowed: `difference` is the change in range WIDTH → wider / same width / narrower;
 * - unchanged: matches → "is unchanged from"; contradicted → "differs from";
 * - raised / lowered: by the MIDPOINT sign → raised from / lowered from;
 * - above / below / in line (points): by the sign → above / below / in line with.
 * An undecided comparison (periods differ, unconfirmed, no difference) only compares.
 */
function comparisonRelationWords(cc: ViewComparisonCheck): string {
  const decided = cc.verdict === "matches" || cc.verdict === "contradicted";
  const d = cc.difference;
  if (!decided) return "compared with";
  switch (cc.relation) {
    case "narrowed":
      if (d === null) return "compared with";
      return d > 0 ? "is wider than" : d < 0 ? "is narrower than" : "is the same width as";
    case "unchanged":
      return cc.verdict === "matches" ? "is unchanged from" : "differs from";
    case "raised":
    case "lowered":
      if (cc.verdict === "matches") return `is ${STATED_RELATION[cc.relation]}`;
      if (d === null) return "compared with";
      return d > 0 ? "is raised from" : d < 0 ? "is lowered from" : "has the same midpoint as";
    case "above":
    case "below":
    case "in_line":
      if (cc.verdict === "matches") return `is ${STATED_RELATION[cc.relation]}`;
      if (d === null) return "compared with";
      return d > 0 ? "is above" : d < 0 ? "is below" : "is in line with";
    default:
      return "compared with";
  }
}

/**
 * The app's own reading of a comparison (spec, What the owner sees):
 * "filing: $64.601B is above $64.57B (Finnhub consensus, 2026-10-20), +0.05%".
 * A matching comparison repeats the stated relation; a contradicted one says
 * what the arithmetic shows; otherwise the two are only "compared with".
 * The model's own text is never rewritten.
 */
export function comparisonLine(cc: ViewComparisonCheck): string {
  if (!cc.left && !cc.right) {
    // Neither operand could be described (the model named figures it did not supply).
    return cc.shownText ? `filing difference: ${cc.shownText}` : "filing: the compared figures were not supplied";
  }
  const relation = comparisonRelationWords(cc);
  const left = operandText(cc.left, cc.leftHigh);
  const right = operandText(cc.right, cc.rightHigh);
  return `filing: ${left} ${relation} ${right}${cc.shownText ? `, ${cc.shownText}` : ""}`;
}

/** The line under an unlocated footnote: "Quote as the model gave it: “…”". */
export function modelQuoteLine(quote: string): string {
  return `Quote as the model gave it: “${quote}”`;
}

// ---------------------------------------------------------------- request keys

/**
 * A fresh request key for one paid click. `crypto.randomUUID` exists only in
 * a secure context; the phone over the private network reaches the app on
 * plain http, so fall back to `getRandomValues` (16 bytes as hex), which
 * exists everywhere.
 */
export function newRequestKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
