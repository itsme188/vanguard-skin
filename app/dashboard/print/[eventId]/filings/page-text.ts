/**
 * Words and small pure rules for the full filing-summary page
 * (`/dashboard/print/[eventId]/filings`). Plain module: no client directive
 * and only type imports from the server-side view model, so both the server
 * page and the client view may read it.
 *
 * The words shared with the panel and the shareable page (status labels,
 * counts, costs, reasons, failure sentences, comparison lines) live once in
 * `lib/filing-summary/labels.ts`; only page-specific rules live here.
 */
import { nowPart, roughCostText } from "@/lib/filing-summary/labels";
import type { CheckedClaim, Footnote } from "@/lib/filing-summary/types";
import type { ChoiceOption, FullFiling, FullRun, FullSection, FullView, ViewClaim } from "@/lib/filing-summary/view";

// ---------------------------------------------------------------- claims

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

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The question the Re-run button asks: names the model and the rough cost. */
export function rerunPrompt(o: ChoiceOption, filingCount: number): { title: string; message: string; confirmLabel: string } {
  const family = capitalise(o.choice.family);
  const now = nowPart(o.nowLabel);
  const model = now.startsWith("now ") ? `${family} ${now.slice(4)}` : `${family} (no ${family} model is available right now)`;
  const cost = roughCostText(o.choice);
  const costLine =
    o.choice.effort === "medium" && o.choice.family !== "sonnet"
      ? `${cost} (${roughCostText({ family: o.choice.family, effort: "high" })})`
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

/**
 * The question the Retry button asks (ruling C): the run's model, effort,
 * rough cost and how many sections it reads again.
 */
export function retryPrompt(run: FullRun): { title: string; message: string; confirmLabel: string } {
  const count = run.sections.filter((s) => s.status === "failed" || s.status === "waiting_retry").length;
  const sections = `${count} ${count === 1 ? "section" : "sections"}`;
  return {
    title: `Retry run ${run.runNo}?`,
    message:
      `This reads ${sections} again with ${run.modelLabel} at ${run.effort} effort. Sections already done are kept.` +
      `\n\nRough cost: ${roughCostText({ family: run.family, effort: run.effort })}.\n\nCancel spends nothing.`,
    confirmLabel: "Retry",
  };
}

// ---------------------------------------------------------------- sections

/** "8-K · 4:05 pm" / "PRE 14C · 4:12 pm". */
export function sectionHeading(s: Pick<FullSection, "form" | "acceptedAtEt">): string {
  return `${s.form} · ${s.acceptedAtEt ?? "time unconfirmed"}`;
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
