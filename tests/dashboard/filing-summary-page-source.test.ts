import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { CheckedClaim, StatusCounts } from "@/lib/filing-summary/types";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import {
  claimReasonCodes,
  correctedByText,
  defaultRunId,
  filingLine,
  footnoteWhere,
  numberFootnotes,
  rerunPrompt,
  retryPrompt,
  runPillLabel,
  sectionHeading,
  topContradicted,
} from "@/app/dashboard/print/[eventId]/filings/page-text";
import type { ChoiceOption, FullFiling, FullRun, FullSection, FullView, ViewClaim, ViewFootnote } from "@/lib/filing-summary/view";

const DIR = "app/dashboard/print/[eventId]/filings";

// ---------------------------------------------------------------- fixtures (synthetic)

function counts(p: Partial<StatusCounts> = {}): StatusCounts {
  return { claims: 0, checked: 0, contradicted: 0, warning: 0, unconfirmed: 0, qualitative: 0, ...p };
}

function claim(p: Partial<ViewClaim> = {}): ViewClaim {
  const base: Omit<CheckedClaim, "footnotes" | "comparisonChecks" | "correction"> & Pick<ViewClaim, "footnotes" | "comparisonChecks" | "correction"> = {
    claimId: "c1",
    renderedText: "Revenue was $10.0B.",
    status: "checked",
    top: false,
    routine: false,
    footnotes: [],
    figureChecks: [],
    comparisonChecks: [],
    reasons: [],
    correction: null,
  };
  return { ...base, correctedBy: null, ...p };
}

function section(p: Partial<FullSection> = {}): FullSection {
  return {
    sectionId: 1, seq: 1, filingId: 1, form: "8-K", accession: "0000000000-26-000001", cik: "1",
    acceptedAtEt: "4:05 pm", acceptedOnEt: "2026-10-22", status: "done", errorClass: null, errorText: null,
    attempts: 1, modelLabel: "Opus 5.5", effort: "high", headline: "Q3", claims: [], counts: counts(),
    coverage: [], incomplete: false, usage: null, ...p,
  };
}

function run(p: Partial<FullRun> = {}): FullRun {
  return {
    runId: 10, runNo: 1, status: "done", trigger: "auto", family: "opus", effort: "high", modelLabel: "Opus 5.5",
    fallbackNote: null, createdAtEt: "4:06 pm", createdOnEt: "2026-10-22", finishedAtEt: "4:09 pm",
    counts: counts(), incomplete: false, excludesAfterEt: null, usage: {}, bogeys: [], quarterLabel: null,
    sections: [section()], ...p,
  };
}

function filing(p: Partial<FullFiling> = {}): FullFiling {
  return {
    filingId: 1, accession: "0000000000-26-000001", cik: "1", form: "8-K", role: "earnings",
    acceptedAtEt: "4:05 pm", acceptedOnEt: "2026-10-22", discoveredAtEt: "4:06 pm", identityVerdict: "accepted",
    identityReason: null, fetchState: "fetched", indexUrl: null, documents: [], ...p,
  };
}

// ---------------------------------------------------------------- small helpers

describe("page-text helpers", () => {
  it("section heading is form · time, or says the time is unconfirmed", () => {
    expect(sectionHeading(section())).toBe("8-K · 4:05 pm");
    expect(sectionHeading(section({ form: "PRE 14C", acceptedAtEt: "4:12 pm" }))).toBe("PRE 14C · 4:12 pm");
    expect(sectionHeading(section({ acceptedAtEt: null }))).toBe("8-K · time unconfirmed");
  });

  it("footnote location: page and paragraph, paragraph only, or a plain not-found sentence", () => {
    const f = (p: Partial<ViewFootnote>): ViewFootnote => ({
      citationId: "q1", document: "ex99.htm", status: "found", page: 3, para: 4, sentence: "x", url: null, modelQuote: null, ...p,
    });
    expect(footnoteWhere(f({}))).toBe("page 3, paragraph 4");
    expect(footnoteWhere(f({ page: null }))).toBe("paragraph 4");
    expect(footnoteWhere(f({ status: "not_found", page: null, para: null, sentence: null }))).toMatch(/not found/i);
    expect(footnoteWhere(f({ status: "ambiguous", page: null, para: null, sentence: null }))).toMatch(/more than one place/i);
  });

  it("footnotes are numbered in claim order within a section, like the shareable page", () => {
    const fn = (id: string): ViewFootnote => ({
      citationId: id, document: "d.htm", status: "found", page: null, para: 1, sentence: "s", url: null, modelQuote: null,
    });
    const s = section({
      claims: [
        claim({ claimId: "a", footnotes: [fn("q1"), fn("q2")] }),
        claim({ claimId: "b", footnotes: [fn("q1")] }),
      ],
    });
    const n = numberFootnotes(s);
    expect(n.get("a:q1")).toBe(1);
    expect(n.get("a:q2")).toBe(2);
    expect(n.get("b:q1")).toBe(3);
  });

  it("claim reasons are every code once, claim then figures then comparisons", () => {
    const c = claim({
      reasons: [{ code: "quote_not_found", figureId: null, detail: "" }],
      figureChecks: [{ figureId: "f1", established: false, foundValue: null, reasons: [
        { code: "scale_unconfirmed", figureId: "f1", detail: "" },
        { code: "quote_not_found", figureId: "f1", detail: "" },
      ] }],
      comparisonChecks: [{ relation: "above", verdict: "periods_differ", difference: null, differencePct: null, shownText: null,
        reasons: [{ code: "periods_differ", figureId: null, detail: "" }], left: null, right: null }],
    });
    expect(claimReasonCodes(c)).toEqual(["quote_not_found", "scale_unconfirmed", "periods_differ"]);
  });

  it("the default run is the view's shown run; an unknown pick falls back to it", () => {
    const view = { shownRunId: 10, runs: [run({ runId: 10 }), run({ runId: 11, runNo: 2 })] } as unknown as FullView;
    expect(defaultRunId(view, null)).toBe(10);
    expect(defaultRunId(view, 11)).toBe(11);
    expect(defaultRunId(view, 99)).toBe(10);
    expect(defaultRunId({ shownRunId: null, runs: [] } as unknown as FullView, null)).toBeNull();
  });

  it("run pill: Run n · model effort · time, and a running re-run says running", () => {
    expect(runPillLabel(run({ runNo: 2, modelLabel: "Fable 5.1", effort: "high", createdAtEt: "7:41 pm" }))).toBe(
      "Run 2 · Fable 5.1 high · 7:41 pm",
    );
    expect(runPillLabel(run({ runNo: 3, status: "running", createdAtEt: "8:01 pm" }))).toMatch(/· running$/);
  });

  it("the re-run question names the model and the rough cost", () => {
    const opt: ChoiceOption = { choice: { family: "fable", effort: "high" }, value: "fable·high", label: "Fable · high", nowLabel: "Fable · now 5.1" };
    const p = rerunPrompt(opt, 2);
    expect(p.title).toMatch(/Fable · high/);
    expect(p.message).toMatch(/Fable 5\.1/);
    expect(p.message).toContain("Rough cost: Fable costs 2.5 times as much per token as Opus.");
    expect(p.message.match(/Rough cost/g)).toHaveLength(1);
    expect(p.message).toMatch(/2 filings/);
    expect(p.message).toMatch(/Cancel spends nothing/);
  });

  it("filings list: accepted after 9 pm is not read, a missing time says so, with reasons", () => {
    expect(filingLine(filing({ identityVerdict: "rejected", identityReason: "accepted after 9 pm", acceptedAtEt: "9:14 pm" })))
      .toMatch(/9:14 pm.*accepted after 9 pm.*not read/);
    expect(filingLine(filing({ identityVerdict: "time_unconfirmed", acceptedAtEt: null }))).toMatch(/time unconfirmed/);
    expect(filingLine(filing({}))).toMatch(/8-K · 4:05 pm/);
  });

  it("the Retry question names the model, effort, rough cost and the sections it reads again (ruling C)", () => {
    const r = run({
      runNo: 2, family: "opus", effort: "high", modelLabel: "Opus 5.5", status: "failed",
      sections: [section(), section({ sectionId: 2, status: "failed" }), section({ sectionId: 3, status: "waiting_retry" })],
    });
    const p = retryPrompt(r);
    expect(p.title).toBe("Retry run 2?");
    expect(p.message).toMatch(/2 sections again with Opus 5\.5 at high effort/);
    expect(p.message).toContain("Rough cost: about $0.80 per 8-K (measured); long filings cost more.");
    expect(p.message).toMatch(/Cancel spends nothing/);
  });

  it("topContradicted lists only contradicted claims within the first three Top claims of done sections", () => {
    const r = run({
      sections: [
        section({ claims: [
          claim({ claimId: "a", top: true, status: "checked" }),
          claim({ claimId: "b", top: true, status: "contradicted" }),
          claim({ claimId: "c", top: false, status: "contradicted" }),
        ] }),
        section({ sectionId: 2, status: "failed", claims: [claim({ claimId: "z", top: true, status: "contradicted" })] }),
        section({ sectionId: 3, claims: [
          claim({ claimId: "d", top: true, status: "checked" }),
          claim({ claimId: "e", top: true, status: "contradicted" }),
        ] }),
      ],
    });
    expect(topContradicted(r).map((c) => c.claimId)).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------- source pins

describe("full summary page (source pins)", () => {
  const page = readFileSync(`${DIR}/page.tsx`, "utf8");
  const view = readFileSync(`${DIR}/FilingSummaryView.tsx`, "utf8");
  const text = readFileSync(`${DIR}/page-text.ts`, "utf8");

  it("the server page is force-dynamic and loads getFullView with the live catalog", () => {
    expect(page).toMatch(/export const dynamic = "force-dynamic";/);
    expect(page).toMatch(/getFullView\(db, [^,]+, getCachedModelCatalog\(\)\)/);
    expect(page).not.toMatch(/^"use client"/);
  });

  it("a missing print or a print with no summary state renders EmptySection, never a blank page", () => {
    expect(page.split("<EmptySection").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("the server page imports no function from a client file", () => {
    const imports = [...page.matchAll(/import\s+(?!type)\{([^}]*)\}\s+from\s+"([^"]+)"/g)];
    for (const [, names, from] of imports) {
      if (from.endsWith("FilingSummaryView")) expect(names.trim()).toBe("FilingSummaryView");
    }
  });

  it("the share link is a plain download anchor to the share route", () => {
    const at = anchorIndex(view, "/share?runId=");
    const tag = view.slice(view.lastIndexOf("<a", at), view.indexOf(">", at) + 1);
    expect(tag).toMatch(/\sdownload[\s>]/);
    expect(view).toMatch(/Make shareable page/);
  });

  it("no dangerouslySetInnerHTML and no native browser dialogs", () => {
    for (const src of [page, view]) {
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
      expect(src).not.toMatch(/(^|[^.\w])(confirm|alert|prompt)\(/m);
    }
  });

  it("re-run asks through useConfirmPrompt, sends a fresh request key and reads the result through readMutationResult", () => {
    expect(view).toMatch(/useConfirmPrompt\(\)/);
    const at = anchorIndex(view, "async function rerun(");
    const body = view.slice(at, at + 1500);
    expect(body).toMatch(/await prompt\.ask\(/);
    expect(body.indexOf("prompt.ask(")).toBeLessThan(body.indexOf("apiFetch("));
    expect(body).toMatch(/newRequestKey\(\)/);
    expect(body).toMatch(/readMutationResult/);
    expect(body).toMatch(/networkFailureMessage/);
  });

  it("the re-run picker is a native select of the five choices (no caret affordance)", () => {
    expect(view).toMatch(/<select/);
    expect(view).toMatch(/choice\.options\.map/);
    expect(view).not.toMatch(/[▾▼⌄]/);
  });

  it("sec.gov links open in a new tab with no referrer", () => {
    const at = anchorIndex(view, "open on sec.gov");
    const tag = view.slice(view.lastIndexOf("<a", at), at);
    expect(tag).toMatch(/target="_blank"/);
    expect(tag).toMatch(/rel="noreferrer"/);
  });

  it("long sentences and file names wrap at phone width", () => {
    expect(view.split("[overflow-wrap:anywhere]").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("status chips take their tone from statusTone (STATUS_SEVERITY)", () => {
    expect(view).toMatch(/<Chip[^>]*tone=\{statusTone\(/);
  });

  it("a correction shows only when resolved (correctedBy is set by the view only then)", () => {
    expect(view).toMatch(/\{claim\.correctedBy && [^}]*correctedByText\(claim\.correctedBy\)/);
    expect(correctedByText({ form: "8-K/A", acceptedAtEt: "5:40 pm" })).toBe("corrected by 8-K/A, 5:40 pm");
  });

  it("the shared words come from labels.ts, not a page copy", () => {
    expect(view).toMatch(/from "@\/lib\/filing-summary\/labels"/);
    expect(existsSync(`${DIR}/reason-text.ts`)).toBe(false);
    expect(text).not.toMatch(/REASON_SENTENCES|STATUS_LABELS|ROUGH_COST|ERROR_SENTENCES/);
    expect(view).not.toMatch(/crypto\.randomUUID/);
  });

  it("Retry asks first through the app dialog, with a fresh key (ruling C)", () => {
    const at = anchorIndex(view, "async function retry(");
    const body = view.slice(at, at + 1200);
    expect(body).toMatch(/await prompt\.ask\(retryPrompt\(target\)\)/);
    expect(body.indexOf("prompt.ask(")).toBeLessThan(body.indexOf("apiFetch("));
    expect(body).toMatch(/newRequestKey\(\)/);
  });

  it("Re-run is blocked only by a re-run in progress or a disarmed print (ruling D)", () => {
    const at = anchorIndex(view, "const rerunBlocked =");
    const decl = view.slice(at, anchorIndex(view, ": null;", at));
    expect(decl).toMatch(/view\.inProgressRunId !== null/);
    expect(decl).not.toMatch(/anyRunning/);
  });

  it("comparison lines, the model's quote and the bogey list are rendered (rulings A, B)", () => {
    expect(view).toMatch(/\{comparisonLine\(cc\)\}/);
    expect(view).toMatch(/cc\.verdict === "contradicted" \? CHIP_TONE_TEXT\.down/);
    expect(view).toMatch(/f\.status !== "found" && f\.modelQuote && [\s\S]{0,200}modelQuoteLine\(f\.modelQuote\)/);
    expect(view).toMatch(/Bogeys before the print/);
    expect(view).toMatch(/<BogeyList bogeys=\{run\.bogeys\} \/>/);
  });

  it("helper modules are plain (no client directive, no server-only import)", () => {
    for (const src of [text]) {
      expect(src).not.toMatch(/^"use client"/);
      // Type-only imports are erased; a value import would pull server code into the client bundle.
      expect(src).not.toMatch(/^import (?!type )[^;]*from "[^"]*(@\/lib\/db|share-page|\/view|\/evaluate|\/store|\/locate)"/m);
    }
  });

  it("a Back to Today link is on the page", () => {
    expect(existsSync(`${DIR}/page.tsx`)).toBe(true);
    expect(page + view).toMatch(/Back to Today/);
  });
});
