/**
 * Pure copy helpers for the print-row filing summary panel and the per-print
 * model choice (Task 13). Client-safe: it imports only types from the view
 * model plus the pure modules `choice`, `labels` and `types`, never a server module.
 *
 * Every word the panel shows about a status, a count, a cost or a failure
 * comes from here, so the tests can pin the copy without a DOM.
 */
import { choiceLabel } from "@/lib/filing-summary/choice";
import { comparisonLine, errorWords, reasonText, roughCostText, statusSeverity } from "@/lib/filing-summary/labels";
import type { Footnote, SummaryChoice } from "@/lib/filing-summary/types";
import type { PanelView, ReadingDocs, RunSummary, SectionState, ViewClaim } from "@/lib/filing-summary/view";

// The single copy of the status, count, cost, choice, failure and request-key
// words lives in lib/filing-summary/labels.ts (shared with the full page and
// the shareable page); re-exported here so the panel's imports stay put.
export {
  ROUGH_COST_BY_CHOICE,
  choiceValue,
  countsText,
  errorWords,
  newRequestKey,
  optionText,
  roughCostText,
  statusLabel,
  statusTone,
} from "@/lib/filing-summary/labels";
export type { ReadingDocs } from "@/lib/filing-summary/view";

/** The panel re-reads its state this often while something can change. */
export const FILING_SUMMARY_POLL_MS = 30_000;

// ---------------------------------------------------------------- cost

/** The Run summary question: the choice, the model it now means, the cost. */
export function runConfirmMessage(choice: SummaryChoice, nowLabel: string): string {
  return [
    `${choiceLabel(choice)} (${nowLabel}) reads the earnings filing and any later filings of the day, and writes the summary.`,
    `Rough cost: ${roughCostText(choice)}.`,
  ].join("\n\n");
}

/** The family behind a run's model label ("Opus 5.5" → opus), or null. */
export function familyFromModelLabel(label: string): SummaryChoice["family"] | null {
  const first = label.trim().split(/\s+/)[0]?.toLowerCase();
  return first === "sonnet" || first === "opus" || first === "fable" ? first : null;
}

/** The Retry question: the run's model and the cost of its family and effort. */
export function retryConfirmMessage(run: RunSummary): string {
  const family = familyFromModelLabel(run.modelLabel);
  const cost = family ? roughCostText({ family, effort: run.effort }) : "cost not known";
  return [
    `${run.modelLabel} at ${run.effort} effort reads again the filings that failed or wait for Retry. Sections already done are kept.`,
    `Rough cost: ${cost}.`,
  ].join("\n\n");
}

// ---------------------------------------------------------------- status line

/**
 * "8-K" or "6-K". A foreign filer shows up as a 6-K section, or in the
 * poller's own detail (the only place PanelView names the form before any
 * filing is accepted). This picks the WORD only; whether a filing exists is
 * decided from the view's runs and `runSummaryAvailable`, never from the text.
 */
function filerForm(view: PanelView): string {
  if (view.earningsForm) return view.earningsForm;
  const forms = [...(view.shown?.sectionStates ?? []), ...(view.inProgress?.sectionStates ?? [])].map((s) => s.form);
  if (forms.some((f) => f.toUpperCase().startsWith("6-K"))) return "6-K";
  if (view.readingDocs?.form.toUpperCase().startsWith("6-K")) return "6-K";
  return view.pollDetail && /\b6-K\b/.test(view.pollDetail) ? "6-K" : "8-K";
}

/**
 * True when the view shows no accepted earnings filing: no run was ever made
 * and Run summary is not offered (it is offered exactly when an accepted
 * earnings filing exists and no run does).
 */
export function hasNoAcceptedEarningsFiling(view: PanelView): boolean {
  return !view.shown && !view.inProgress && !view.runSummaryAvailable && !view.earningsTimeUnconfirmed;
}

function runningSection(run: RunSummary): SectionState | undefined {
  return run.sectionStates.find((s) => s.status === "running") ?? run.sectionStates.find((s) => s.status === "pending");
}

function capitalise(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The panel's status line (brief copy; the run's state wins over the poll's). */
export function pollStateText(view: PanelView, reading: ReadingDocs | null = view.readingDocs ?? null): string {
  if (view.pollState === "cancelled") return "Disarmed — summary stopped";

  const active = view.inProgress?.status === "running" ? view.inProgress : view.shown?.status === "running" ? view.shown : null;
  if (active) {
    const form = reading?.form ?? runningSection(active)?.form ?? filerForm(view);
    const ex = reading?.exhibits ?? 0;
    const docs = ex > 0 ? `${form} + ${ex} ${ex === 1 ? "exhibit" : "exhibits"}` : form;
    return `Reading ${docs} · ${active.modelLabel} ${active.effort}`;
  }

  const shown = view.shown;
  if (shown?.status === "done") return `Summary ready · ${shown.modelLabel} ${shown.effort}`;
  if (shown?.status === "waiting_retry") return "Summary paused — a later filing waits for Retry";
  if (shown?.status === "failed") {
    const failed = shown.sectionStates.find((s) => s.status === "failed");
    return `Summary failed — ${errorWords(failed?.errorClass ?? null)}`;
  }

  const form = filerForm(view);
  // A filing was found but its header gave no acceptance time: it is not
  // "no filing", and nothing runs on its own (controller ruling, round 2).
  if (view.earningsTimeUnconfirmed && !view.shown && !view.inProgress) {
    return `Earnings ${form} found, but its filing time could not be confirmed — not run automatically`;
  }
  switch (view.pollState) {
    case "sec_unreachable":
      return "SEC not reachable — still trying";
    case "past_cutoff":
      if (hasNoAcceptedEarningsFiling(view)) return `No earnings ${form} filed by 8 pm`;
      return view.runSummaryAvailable
        ? `Polling ended at 8 pm — Run summary to start`
        : "Polling ended at 8 pm";
    case "manual_only":
      return "Armed after 8 pm — nothing runs on its own";
    case "ambiguous":
      return `Filing found but it does not name this quarter: ${view.pollDetail ?? "no reason recorded"}`;
    case "no_cik":
      return view.pollDetail ? capitalise(view.pollDetail) : "No SEC filer found for this symbol";
    case "found":
      return view.runSummaryAvailable
        ? `Earnings ${form} found — Run summary to start`
        : `Earnings ${form} found — summary starting`;
    case "waiting":
    case null:
    default:
      return `Waiting for the earnings ${form} · ${view.choiceLabel}`;
  }
}

/** One line per section of the run that is not done ("10-Q · 5:10 pm: being read"). */
export function sectionNotes(run: RunSummary): string[] {
  return run.sectionStates
    .filter((s) => s.status !== "done")
    .map((s) => {
      const what =
        s.status === "running"
          ? "being read"
          : s.status === "pending"
            ? "not read yet"
            : s.status === "waiting_retry"
              ? "waits for Retry"
              : `failed — ${errorWords(s.errorClass)}`;
      return `${s.form}${s.acceptedAtEt ? ` · ${s.acceptedAtEt}` : ""}: ${what}`;
    });
}

/**
 * True while the panel should keep re-reading: a run runs, the filing is
 * still looked for, or the event has no state yet (the poller has not seen a
 * just-armed print). A read-only panel (a closed record) never polls.
 */
export function needsPolling(view: PanelView, readOnly = false): boolean {
  if (readOnly) return false;
  if (view.inProgress?.status === "running" || view.shown?.status === "running") return true;
  return (
    view.pollState === null ||
    view.pollState === "waiting" ||
    view.pollState === "found" ||
    view.pollState === "sec_unreachable"
  );
}

/**
 * One line per Top claim with a warning or muted status: its reasons' plain
 * sentences, deduplicated, in order. Null for a checked, qualitative or
 * contradicted claim (the contradicted one gets its comparison lines instead)
 * or when there is no reason to give.
 */
export function claimReasonLine(claim: Pick<ViewClaim, "status" | "reasons" | "figureChecks" | "comparisonChecks">): string | null {
  const sev = statusSeverity(claim.status);
  if (sev !== "warning" && sev !== "muted") return null;
  const codes = [
    ...claim.reasons,
    ...claim.figureChecks.flatMap((f) => f.reasons),
    ...claim.comparisonChecks.flatMap((c) => c.reasons),
  ].map((r) => r.code);
  const sentences: string[] = [];
  for (const code of codes) {
    const t = reasonText(code);
    if (!sentences.includes(t)) sentences.push(t);
  }
  return sentences.length ? sentences.join(" ") : null;
}

/** The app's arithmetic under a contradicted claim, one line per contradicted comparison. */
export function contradictionLines(claim: Pick<ViewClaim, "status" | "comparisonChecks">): string[] {
  if (claim.status !== "contradicted") return [];
  const lines = claim.comparisonChecks.filter((c) => c.verdict === "contradicted").map((c) => comparisonLine(c));
  return [...new Set(lines)];
}

// ---------------------------------------------------------------- footnotes

/** The hover/long-press title of a footnote marker. */
export function footnoteTitle(fn: Pick<Footnote, "status" | "page" | "para">): string {
  if (fn.status === "not_found") {
    return "Quote not found in the filing text; the link opens the document, not the sentence";
  }
  if (fn.status === "ambiguous") {
    return "The quote appears more than once in the filing; the link opens the first match";
  }
  const where =
    fn.page !== null && fn.para !== null
      ? `Page ${fn.page}, paragraph ${fn.para}`
      : fn.para !== null
        ? `Paragraph ${fn.para}`
        : "Filing";
  return `${where} · opens on sec.gov`;
}
