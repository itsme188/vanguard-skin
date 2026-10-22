/**
 * One owner-facing sentence per checker reason code (`REASON_CODES` in
 * `lib/filing-summary/evaluate.ts`), for the full summary page.
 *
 * Plain module: no client directive and no server import, so the client view
 * can read it. The sentences are the same words as the shareable page
 * (`shareReasonText` in `lib/filing-summary/share-page.ts`), so the page and
 * the downloaded file say the same thing;
 * tests/dashboard/filing-summary-page-source.test.ts fails when a code has no
 * sentence here or the two tables differ.
 */

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
  computed: "The app calculated this figure from the filing.",
  correction_unresolved: "A later amendment says it corrects this, but its correcting quote was not found.",
};

/** A plain sentence for a reason code; an unknown code gets a neutral sentence. */
export function reasonText(code: string): string {
  return REASON_SENTENCES[code] ?? "This could not be confirmed against the filing.";
}

/** True when the code has its own sentence (the test iterates `REASON_CODES`). */
export function hasReasonText(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(REASON_SENTENCES, code);
}
