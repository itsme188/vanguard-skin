/**
 * Words and small pure rules for the full filing-summary page
 * (`/dashboard/print/[eventId]/filings`). Plain module: no client directive
 * and only type imports from the server-side view model, so both the server
 * page and the client view may read it.
 *
 * Where the shareable page (`lib/filing-summary/share-page.ts`) already says
 * something, the words here are the same (counts line, status labels,
 * section failure sentences, footnote numbering); the page test pins the
 * parity.
 */
import { STATUS_SEVERITY, type CheckedClaim, type ClaimStatus, type Footnote, type StatusCounts, type SummaryChoice } from "@/lib/filing-summary/types";
import type { ChipTone } from "@/app/dashboard/components/Chip";
import type { ChoiceOption, FullFiling, FullRun, FullSection, FullView, ViewClaim } from "@/lib/filing-summary/view";

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

export function statusLabel(status: ClaimStatus): string {
  return STATUS_LABELS[status] ?? "Unconfirmed";
}

const SEVERITY_TONE: Record<"danger" | "warning" | "muted" | "ok", ChipTone> = {
  danger: "down",
  warning: "warn",
  muted: "neutral",
  ok: "up",
};

/** The chip tone for a claim status, from `STATUS_SEVERITY` (unknown reads muted). */
export function statusTone(status: ClaimStatus): ChipTone {
  const severity = Object.prototype.hasOwnProperty.call(STATUS_SEVERITY, status) ? STATUS_SEVERITY[status] : "muted";
  return SEVERITY_TONE[severity];
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

/** Every reason code on a claim, once each: the claim's own, then its figures', then its comparisons'. */
export function claimReasonCodes(claim: CheckedClaim): string[] {
  const out: string[] = [];
  const add = (code: string) => {
    if (!out.includes(code)) out.push(code);
  };
  for (const r of claim.reasons) add(r.code);
  for (const fc of claim.figureChecks) for (const r of fc.reasons) add(r.code);
  for (const cc of claim.comparisonChecks) for (const r of cc.reasons) add(r.code);
  return out;
}

// ---------------------------------------------------------------- runs

/** The run to show: the owner's pick when it still exists, else the view's shown run, else the newest. */
export function defaultRunId(view: Pick<FullView, "shownRunId" | "runs">, picked: number | null): number | null {
  if (picked !== null && view.runs.some((r) => r.runId === picked)) return picked;
  if (view.shownRunId !== null) return view.shownRunId;
  return view.runs.length ? view.runs[view.runs.length - 1].runId : null;
}

const RUN_STATUS_SUFFIX: Record<FullRun["status"], string> = {
  running: " · running",
  done: "",
  failed: " · failed",
  waiting_retry: " · waiting for Retry",
};

/** "Run 2 · Fable 5.1 high · 7:41 pm", plus "· running" while it runs. */
export function runPillLabel(run: FullRun): string {
  return `Run ${run.runNo} · ${run.modelLabel} ${run.effort} · ${run.createdAtEt ?? "time unknown"}${RUN_STATUS_SUFFIX[run.status] ?? ""}`;
}

/** The first three Top claims of done sections (the panel's rule) that are contradicted. */
export function topContradicted(run: FullRun): ViewClaim[] {
  return run.sections
    .filter((s) => s.status === "done")
    .flatMap((s) => s.claims)
    .filter((c) => c.top)
    .slice(0, 3)
    .filter((c) => c.status === "contradicted");
}

/** A Retry may be offered: the run failed or waits for Retry, and the print is still armed. */
export function retryAvailable(run: FullRun, pollState: FullView["event"]["pollState"]): boolean {
  return (run.status === "failed" || run.status === "waiting_retry") && pollState !== "cancelled";
}

// ---------------------------------------------------------------- choices and cost

export function choiceKey(c: SummaryChoice): string {
  return `${c.family}:${c.effort}`;
}

/** "Fable · now 5.1" → "now 5.1"; "Fable · not available" → "not available". */
function nowPart(nowLabel: string): string {
  const at = nowLabel.indexOf(" · ");
  return at === -1 ? nowLabel : nowLabel.slice(at + 3);
}

/** "Fable · high — now 5.1". */
export function optionLabel(o: ChoiceOption): string {
  return `${o.label} — ${nowPart(o.nowLabel)}`;
}

/** Measured on the Meta test (spec, Cost and time); medium efforts were not measured. */
const ROUGH_COST: Record<string, string> = {
  "sonnet:medium": "about $0.11 per filing",
  "opus:medium": "less than Opus · high",
  "opus:high": "about $0.32 per filing",
  "fable:medium": "less than Fable · high",
  "fable:high": "about $0.68 per filing",
};

export function roughCost(c: SummaryChoice): string {
  return ROUGH_COST[choiceKey(c)] ?? "not measured";
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The question the Re-run button asks: names the model and the rough cost. */
export function rerunPrompt(o: ChoiceOption, filingCount: number): { title: string; message: string; confirmLabel: string } {
  const family = capitalise(o.choice.family);
  const now = nowPart(o.nowLabel);
  const model = now.startsWith("now ") ? `${family} ${now.slice(4)}` : `${family} (no ${family} model is available right now)`;
  const cost = roughCost(o.choice);
  const costLine =
    o.choice.effort === "medium" && o.choice.family !== "sonnet"
      ? `${cost} (${roughCost({ family: o.choice.family, effort: "high" })})`
      : cost;
  const filings = `${filingCount} ${filingCount === 1 ? "filing" : "filings"}`;
  return {
    title: `Re-run with ${o.label}?`,
    message:
      `This reads the same ${filings} again with ${model} at ${o.choice.effort} effort, as a new run. ` +
      `Earlier runs stay and can still be opened.\n\nRough cost: ${costLine}.\n\nCancel spends nothing.`,
    confirmLabel: "Re-run",
  };
}

// ---------------------------------------------------------------- sections

/** "8-K · 4:05 pm" / "PRE 14C · 4:12 pm". */
export function sectionHeading(s: Pick<FullSection, "form" | "acceptedAtEt">): string {
  return `${s.form} · ${s.acceptedAtEt ?? "time unconfirmed"}`;
}

/** Same words as the shareable page's `sectionErrorSentence`; the stored error text is never the headline. */
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

export function sectionError(errorClass: string | null): string {
  if (errorClass && Object.prototype.hasOwnProperty.call(ERROR_SENTENCES, errorClass)) return ERROR_SENTENCES[errorClass];
  return "Not summarised.";
}

/** Footnote numbers in claim order within a section, keyed `claimId:citationId` (the shareable page's numbering). */
export function numberFootnotes(section: Pick<FullSection, "claims">): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of section.claims) {
    for (const f of c.footnotes) {
      const key = `${c.claimId}:${f.citationId}`;
      if (!out.has(key)) out.set(key, out.size + 1);
    }
  }
  return out;
}

/** "page 3, paragraph 4" / "paragraph 4", or a plain sentence when the quote was not located. */
export function footnoteWhere(f: Footnote): string {
  if (f.status === "not_found") return "Quote not found in this document.";
  if (f.status === "ambiguous") return "The quote matches more than one place, so no single sentence is cited.";
  if (f.page !== null && f.para !== null) return `page ${f.page}, paragraph ${f.para}`;
  if (f.para !== null) return `paragraph ${f.para}`;
  return "location not recorded";
}

/** "corrected by 8-K/A, 5:40 pm" (the view sets `correctedBy` only for a resolved correction). */
export function correctedByText(c: NonNullable<ViewClaim["correctedBy"]>): string {
  return `corrected by ${c.form}${c.acceptedAtEt ? `, ${c.acceptedAtEt}` : ""}`;
}

// ---------------------------------------------------------------- filings list

/**
 * One line per filing found for the print, read or not:
 * "8-K · 4:05 pm · earnings · read", "8-K · 8:14 pm · accepted after 8 pm · not read",
 * "8-K · time unconfirmed · not read on its own".
 */
export function filingLine(f: FullFiling, inSummary = false): string {
  const head = `${f.form} · ${f.acceptedAtEt ?? "time unconfirmed"}`;
  const reason = f.identityReason && f.identityReason !== "time unconfirmed" ? f.identityReason : null;
  switch (f.identityVerdict) {
    case "rejected":
      return `${head} · ${reason ?? "not matched to this print"} · not read`;
    case "ambiguous":
      return `${head} · ${reason ?? "could not be matched to this print"} · not read`;
    case "time_unconfirmed": {
      const time = f.acceptedAtEt ? " · time unconfirmed" : "";
      return `${head}${time}${reason ? ` · ${reason}` : ""} · ${inSummary ? "read" : "not read on its own"}`;
    }
    default: {
      const state = inSummary
        ? "read"
        : f.fetchState === "failed"
          ? "could not be fetched"
          : "not read yet";
      return `${head} · ${f.role === "earnings" ? "earnings" : "companion"} · ${state}`;
    }
  }
}
