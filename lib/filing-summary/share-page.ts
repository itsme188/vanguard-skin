/**
 * The shareable page (spec §10, Hardening 6, 7, 8, 14, R15): one
 * self-contained HTML document built from a stored run, for the owner to send
 * to one or two people.
 *
 * Contract:
 *   - Every text that reaches the page goes through `escapeHtml`, once, at the
 *     point it is written into markup. Filing text and model output are data.
 *   - No `<script>`, no app links: the only links are sec.gov archive links
 *     rebuilt here from the filing's stored CIK, accession and file name
 *     through `secArchiveUrl` / `textFragmentUrl`.
 *   - Inline `<style>` with light and dark themes (`prefers-color-scheme`);
 *     readable at phone width (no fixed widths, long words wrap).
 *   - Privacy (R15): built only from a `FullView`, which carries filing text,
 *     checked claims, the bogey snapshot's public fields and dates. No
 *     portfolio field exists on that input.
 */
import { STATUS_SEVERITY, type ClaimStatus, type Footnote, type StatusCounts } from "./types";
import { secArchiveUrl, textFragmentUrl } from "./locate";
import type { FullRun, FullSection, FullView, PublicBogey, ViewClaim } from "./view";

// ---------------------------------------------------------------- escaping

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** The one escaper: every text and attribute value on the page goes through it. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// ---------------------------------------------------------------- words

/** One short sentence per reason code the checker can emit (`REASON_CODES`). */
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

/** A plain sentence for a reason code; unknown codes get a neutral sentence. */
export function shareReasonText(code: string): string {
  return REASON_SENTENCES[code] ?? "This could not be confirmed against the filing.";
}

/** True when the code has its own sentence (the test iterates `REASON_CODES`). */
export function hasShareReasonText(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(REASON_SENTENCES, code);
}

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

/** "12 claims · 9 checked · 1 contradicted · 2 unconfirmed" (zero parts left out). */
export function shareCountsText(c: StatusCounts): string {
  const parts = [`${c.claims} ${c.claims === 1 ? "claim" : "claims"}`];
  if (c.checked) parts.push(`${c.checked} checked`);
  if (c.contradicted) parts.push(`${c.contradicted} contradicted`);
  if (c.warning) parts.push(`${c.warning} with warnings`);
  if (c.unconfirmed) parts.push(`${c.unconfirmed} unconfirmed`);
  if (c.qualitative) parts.push(`${c.qualitative} qualitative`);
  return parts.join(" · ");
}

/** "META · Q3 filing summary · Opus 5.5 high · 12 claims · 9 checked · …" */
export function shareHeaderLine(view: FullView, run: FullRun): string {
  const who = view.event.symbol ?? "Filing";
  const title = run.quarterLabel ? `${run.quarterLabel} filing summary` : "filing summary";
  return `${who} · ${title} · ${run.modelLabel} ${run.effort} · ${shareCountsText(run.counts)}`;
}

function formatBogeyValue(b: PublicBogey): string {
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

/**
 * A fixed sentence per section error class. The stored error text is never
 * printed: it is internal wording and the page leaves the app.
 */
const ERROR_SENTENCES: Record<string, string> = {
  model_error: "Not summarised: the model call failed.",
  timeout: "Not summarised: the model call timed out.",
  refusal: "Not summarised: the model declined to answer.",
  truncated: "Not summarised: the answer was cut off at the length limit.",
  invalid_output: "Not summarised: the model's answer was not in the expected shape.",
  model_unavailable: "Not summarised: the model is no longer available.",
  input_too_large: "Not summarised: the filing is over the input cap.",
  attempt_cap: "Not summarised: both attempts failed.",
  takeover: "Not summarised: the attempt was interrupted.",
  cancelled: "Not summarised: the summary was stopped.",
  awaiting_retry: "Waiting for Retry: this filing arrived after the run failed.",
};

export function sectionErrorSentence(errorClass: string | null): string {
  if (errorClass && Object.prototype.hasOwnProperty.call(ERROR_SENTENCES, errorClass)) {
    return ERROR_SENTENCES[errorClass];
  }
  return "Not summarised.";
}

// ---------------------------------------------------------------- links

/** sec.gov link from the section's stored identity only (Hardening 8); null when any part is invalid. */
function footnoteUrl(section: FullSection, f: Footnote): string | null {
  try {
    const base = secArchiveUrl(section.cik, section.accession, f.document);
    return f.status === "found" && f.sentence ? textFragmentUrl(base, f.sentence) : base;
  } catch {
    return null;
  }
}

function link(url: string | null, text: string): string {
  if (!url) return escapeHtml(text);
  return `<a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(text)}</a>`;
}

// ---------------------------------------------------------------- blocks

const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1a1a1a;--dim:#4a4a4a;--edge:#d6d6d6;--panel:#f5f5f2;
--danger:#a3141d;--warn:#7a4b00;--muted:#4d4d4d;--ok:#1d6b35;--link:#0b4fa8;--banner:#fff3d6}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ececec;--dim:#b8b8b8;--edge:#3a3a3a;--panel:#1d1d1d;
--danger:#ff8a8a;--warn:#f2c46b;--muted:#bdbdbd;--ok:#7fd69a;--link:#8fbfff;--banner:#3a2d0f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:52rem;margin:0 auto;padding:16px}
h1{font-size:1.25rem;line-height:1.3;margin:0 0 4px}
h2{font-size:1.1rem;margin:28px 0 8px;border-bottom:1px solid var(--edge);padding-bottom:4px}
h3{font-size:1rem;margin:16px 0 6px}
p,li,td,th{overflow-wrap:anywhere}
.sub{color:var(--dim);margin:0 0 12px}
.banner{background:var(--banner);border:1px solid var(--edge);padding:8px 12px;border-radius:6px;margin:12px 0}
.claims{list-style:none;padding:0;margin:0}
.claim{border:1px solid var(--edge);border-radius:6px;padding:10px 12px;margin:8px 0;background:var(--panel)}
.status{font-weight:600;font-size:0.9rem}
.s-danger{color:var(--danger)}.s-warning{color:var(--warn)}.s-muted{color:var(--muted)}.s-ok{color:var(--ok)}
.reasons{margin:4px 0 0;padding-left:20px;color:var(--dim);font-size:0.95rem}
.fn{font-size:0.85rem;vertical-align:super}
.notes{font-size:0.95rem;color:var(--dim)}
a{color:var(--link)}
table{border-collapse:collapse;width:100%;font-size:0.95rem}
th,td{text-align:left;border-bottom:1px solid var(--edge);padding:6px 4px;vertical-align:top}
footer{margin-top:32px;color:var(--dim);font-size:0.9rem}
`;

function claimBlock(section: FullSection, claim: ViewClaim, fnNumbers: Map<string, number>): string {
  const severity = Object.prototype.hasOwnProperty.call(STATUS_SEVERITY, claim.status)
    ? STATUS_SEVERITY[claim.status]
    : "muted";
  const markers = claim.footnotes
    .map((f) => {
      const n = fnNumbers.get(`${claim.claimId}:${f.citationId}`);
      return n === undefined ? "" : `<span class="fn">${link(footnoteUrl(section, f), `[${n}]`)}</span>`;
    })
    .join("");
  const reasons: string[] = [];
  const seen = new Set<string>();
  const addReason = (code: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    reasons.push(`<li>${escapeHtml(shareReasonText(code))}</li>`);
  };
  for (const r of claim.reasons) addReason(r.code);
  for (const fc of claim.figureChecks) for (const r of fc.reasons) addReason(r.code);
  for (const cc of claim.comparisonChecks) for (const r of cc.reasons) addReason(r.code);
  const shown = claim.comparisonChecks
    .filter((cc) => cc.shownText)
    .map((cc) => `<li>${escapeHtml(`Filing: ${cc.shownText}`)}</li>`);
  const corrected = claim.correctedBy
    ? `<p class="notes">${escapeHtml(
        `Corrected by ${claim.correctedBy.form}${claim.correctedBy.acceptedAtEt ? `, ${claim.correctedBy.acceptedAtEt}` : ""}`,
      )}</p>`
    : "";
  const list = [...shown, ...reasons];
  return `<li class="claim"><div class="status s-${severity}">${escapeHtml(
    `${STATUS_LABELS[claim.status] ?? "Unconfirmed"}${claim.top ? " · Top" : ""}`,
  )}</div><p>${escapeHtml(claim.renderedText)}${markers}</p>${corrected}${
    list.length ? `<ul class="reasons">${list.join("")}</ul>` : ""
  }</li>`;
}

function sectionBlock(section: FullSection): string {
  const when = section.acceptedAtEt
    ? `accepted ${section.acceptedAtEt} ET${section.acceptedOnEt ? `, ${section.acceptedOnEt}` : ""}`
    : "acceptance time unconfirmed";
  const head = `<h2>${escapeHtml(`${section.form} · ${when}`)}</h2><p class="sub">${escapeHtml(
    `Accession ${section.accession}`,
  )}</p>`;
  if (section.status !== "done") {
    const state =
      section.status === "waiting_retry"
        ? "Waiting for Retry: this filing arrived after the run failed."
        : section.status === "failed"
          ? sectionErrorSentence(section.errorClass)
          : "Still being read.";
    return `${head}<p class="banner">${escapeHtml(state)}</p>`;
  }

  // Footnotes numbered in claim order within the section.
  const fnNumbers = new Map<string, number>();
  const footnotes: string[] = [];
  for (const c of section.claims) {
    for (const f of c.footnotes) {
      const key = `${c.claimId}:${f.citationId}`;
      if (fnNumbers.has(key)) continue;
      const n = footnotes.length + 1;
      fnNumbers.set(key, n);
      const where =
        f.status !== "found"
          ? f.status === "ambiguous"
            ? "quote matches more than once"
            : "quote not found"
          : f.page !== null && f.para !== null
            ? `page ${f.page}, paragraph ${f.para}`
            : f.para !== null
              ? `paragraph ${f.para}`
              : "";
      footnotes.push(
        `<li>${escapeHtml(`${f.document}${where ? ` · ${where}` : ""}`)}${
          f.sentence ? ` — “${escapeHtml(f.sentence)}”` : ""
        } ${link(footnoteUrl(section, f), "open on sec.gov")}</li>`,
      );
    }
  }
  const claims = section.claims.map((c) => claimBlock(section, c, fnNumbers)).join("");
  const coverage = section.coverage
    .map(
      (e) =>
        `<li>${escapeHtml(`${e.fileName} (${e.docType}): ${e.status}${e.reason ? ` — ${e.reason}` : ""}`)}</li>`,
    )
    .join("");
  return `${head}${
    section.incomplete
      ? `<p class="banner">${escapeHtml("Incomplete: part of this filing was skipped or could not be read (see coverage).")}</p>`
      : ""
  }${section.headline ? `<h3>${escapeHtml(section.headline)}</h3>` : ""}<p class="sub">${escapeHtml(
    shareCountsText(section.counts ?? { claims: 0, checked: 0, contradicted: 0, warning: 0, unconfirmed: 0, qualitative: 0 }),
  )}</p><ul class="claims">${claims}</ul>${
    footnotes.length ? `<h3>Footnotes</h3><ol class="notes">${footnotes.join("")}</ol>` : ""
  }${coverage ? `<h3>Coverage</h3><ul class="notes">${coverage}</ul>` : ""}`;
}

function bogeyBlock(bogeys: PublicBogey[]): string {
  if (bogeys.length === 0) return "";
  const rows = bogeys
    .map(
      (b) =>
        `<tr><td>${escapeHtml(b.label)}</td><td>${escapeHtml(formatBogeyValue(b))}</td><td>${escapeHtml(
          b.provenance,
        )}</td><td>${escapeHtml(b.asOf)}</td></tr>`,
    )
    .join("");
  return `<h2>Bogeys before the print</h2><table><thead><tr><th>Figure</th><th>Value</th><th>Source</th><th>As of</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function filingsBlock(view: FullView, run: FullRun): string {
  const inRun = new Set(run.sections.map((s) => s.filingId));
  const rows = view.filings
    .filter((f) => inRun.has(f.filingId))
    .map((f) => {
      const when = f.acceptedAtEt ? `${f.acceptedAtEt} ET${f.acceptedOnEt ? `, ${f.acceptedOnEt}` : ""}` : "time unconfirmed";
      return `<li>${escapeHtml(`${f.form} · accepted ${when} · accession ${f.accession}`)} ${link(
        f.indexUrl,
        "filing on sec.gov",
      )}</li>`;
    })
    .join("");
  return rows ? `<h2>Filings</h2><ul class="notes">${rows}</ul>` : "";
}

// ---------------------------------------------------------------- page

/** The run's shareable page. Throws when the run is not in the view. */
export function renderSharePage(view: FullView, runId: number): string {
  const run = view.runs.find((r) => r.runId === runId);
  if (!run) throw new Error("run not found");
  const header = shareHeaderLine(view, run);
  const sub = [
    view.event.companyName,
    `print of ${view.event.eventDate}`,
    `run ${run.runNo}`,
    run.createdAtEt ? `started ${run.createdAtEt} ET${run.createdOnEt ? `, ${run.createdOnEt}` : ""}` : null,
  ]
    .filter((x): x is string => !!x)
    .join(" · ");
  const banners: string[] = [];
  if (run.incomplete) {
    banners.push("Incomplete: at least one filing was only partly read. The coverage lists say what was skipped and why.");
  }
  if (run.status === "failed") banners.push("This run did not finish every filing.");
  if (run.status === "waiting_retry") banners.push("A later filing waits for a Retry and is not included.");
  if (run.fallbackNote) banners.push(run.fallbackNote);
  if (run.excludesAfterEt) banners.push(`Does not include filings found after ${run.excludesAfterEt} ET.`);
  const contradictedTop = run.sections.flatMap((s) => s.claims).filter((c) => c.top && c.status === "contradicted");
  if (contradictedTop.length > 0) {
    banners.push(
      `${contradictedTop.length} Top ${contradictedTop.length === 1 ? "claim is" : "claims are"} contradicted by the filing's own figures.`,
    );
  }
  const title = `${view.event.symbol ?? "Filing"} filing summary — run ${run.runNo}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(header)}</h1>
<p class="sub">${escapeHtml(sub)}</p>
${banners.map((b) => `<p class="banner">${escapeHtml(b)}</p>`).join("\n")}
${run.sections.map(sectionBlock).join("\n")}
${bogeyBlock(run.bogeys)}
${filingsBlock(view, run)}
<footer>${escapeHtml(
    `Summary written by ${run.modelLabel} at ${run.effort} effort. Every figure was checked by the app against the filing text; statuses say what could and could not be confirmed. Bogeys are pre-print estimates with their sources.`,
  )}</footer>
</main>
</body>
</html>
`;
}

/** `<SYMBOL>-<date>-filing-summary-run<N>.html`, with only safe file-name characters. */
export function shareFileName(view: FullView, runNo: number): string {
  const symbol = (view.event.symbol ?? "filing").replace(/[^A-Za-z0-9.-]/g, "") || "filing";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(view.event.eventDate) ? view.event.eventDate : "undated";
  return `${symbol}-${date}-filing-summary-run${runNo}.html`;
}
