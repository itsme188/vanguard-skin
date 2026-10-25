import { describe, expect, it } from "vitest";
import {
  ROUGH_COST_BY_CHOICE,
  countsText,
  footnoteTitle,
  needsPolling,
  newRequestKey,
  optionText,
  pollStateText,
  claimReasonLine,
  contradictionLines,
  roughCostText,
  runConfirmMessage,
  statusLabel,
  statusTone,
} from "@/app/dashboard/today/filing-summary-text";
import { SUMMARY_CHOICES, choiceLabel } from "@/lib/filing-summary/choice";
import { STATUS_SEVERITY, type ClaimStatus, type StatusCounts } from "@/lib/filing-summary/types";
import type { PanelView, RunSummary, ViewClaim, ViewComparisonCheck } from "@/lib/filing-summary/view";
import { comparisonLine, reasonText } from "@/lib/filing-summary/labels";

const ZERO: StatusCounts = { claims: 0, checked: 0, contradicted: 0, warning: 0, unconfirmed: 0, qualitative: 0 };

function run(o: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 7,
    runNo: 1,
    status: "running",
    trigger: "auto",
    modelLabel: "Opus 5.5",
    effort: "high",
    fallbackNote: null,
    counts: ZERO,
    incomplete: false,
    top: [],
    sectionStates: [{ form: "8-K", acceptedAtEt: "4:05 pm", status: "running", errorClass: null }],
    excludesAfterEt: null,
    ...o,
  };
}

function view(o: Partial<PanelView> = {}): PanelView {
  return {
    eventId: 42,
    choice: { family: "opus", effort: "high" },
    choiceLabel: "Opus · high",
    isDefault: true,
    locked: false,
    nowLabel: "Opus · now 5.5",
    pollState: "waiting",
    pastWithoutSummary: false,
    outsideTickWindow: false,
    pollDetail: null,
    shown: null,
    inProgress: null,
    runSummaryAvailable: false,
    readingDocs: null,
    choiceOptions: [],
    earningsTimeUnconfirmed: false,
    earningsForm: null,
    ...o,
  };
}

describe("pollStateText: the brief's exact copy", () => {
  it("waiting names the earnings 8-K and the choice", () => {
    expect(pollStateText(view())).toBe("Waiting for the earnings 8-K · Opus · high");
    // No state row yet reads the same as waiting.
    expect(pollStateText(view({ pollState: null }))).toBe("Waiting for the earnings 8-K · Opus · high");
  });

  it("found and running names the documents and the resolved model", () => {
    const v = view({ pollState: "found", shown: run() });
    expect(pollStateText(v, { form: "8-K", exhibits: 3 })).toBe("Reading 8-K + 3 exhibits · Opus 5.5 high");
    expect(pollStateText(v, { form: "8-K", exhibits: 1 })).toBe("Reading 8-K + 1 exhibit · Opus 5.5 high");
    expect(pollStateText(v, { form: "8-K", exhibits: 0 })).toBe("Reading 8-K · Opus 5.5 high");
    // Without the document list the form comes from the running section.
    expect(pollStateText(v)).toBe("Reading 8-K · Opus 5.5 high");
    // By default the line reads the view's own readingDocs (no second fetch).
    expect(pollStateText({ ...v, readingDocs: { form: "8-K", exhibits: 3 } })).toBe(
      "Reading 8-K + 3 exhibits · Opus 5.5 high",
    );
  });

  it("a re-run in progress is what the status line reads", () => {
    const v = view({
      pollState: "found",
      shown: run({ status: "done" }),
      inProgress: run({ runId: 8, runNo: 2, modelLabel: "Fable 5.1", effort: "medium" }),
    });
    expect(pollStateText(v)).toBe("Reading 8-K · Fable 5.1 medium");
  });

  it("SEC unreachable", () => {
    expect(pollStateText(view({ pollState: "sec_unreachable", pollDetail: "SEC unreachable — retrying every minute" }))).toBe(
      "SEC not reachable — still trying",
    );
  });

  it("past the cutoff with no filing, 8-K and 6-K", () => {
    // Decided from the view (no run, Run summary not offered), not the detail text.
    expect(pollStateText(view({ pollState: "past_cutoff", pollDetail: "earnings 8-K time unconfirmed — Run summary to spend" }))).toBe(
      "No earnings 8-K filed by 9 pm",
    );
    // The view's own form wins over any detail text.
    expect(pollStateText(view({ pollState: "past_cutoff", earningsForm: "6-K" }))).toBe("No earnings 6-K filed by 9 pm");
    expect(pollStateText(view({ pollState: "past_cutoff", pollDetail: null }))).toBe("No earnings 8-K filed by 9 pm");
    // An accepted filing with no run yet: Run summary is offered instead.
    expect(pollStateText(view({ pollState: "past_cutoff", pollDetail: "polling ended at 9 pm", runSummaryAvailable: true }))).toBe(
      "Polling ended at 9 pm — Run summary to start",
    );
    expect(pollStateText(view({ pollState: "past_cutoff", pollDetail: "no earnings 8-K filed by 9 pm" }))).toBe(
      "No earnings 8-K filed by 9 pm",
    );
    expect(pollStateText(view({ pollState: "past_cutoff", pollDetail: "no earnings 6-K filed by 9 pm" }))).toBe(
      "No earnings 6-K filed by 9 pm",
    );
  });

  it("a foreign filer's waiting line says 6-K once the poller has named it", () => {
    expect(pollStateText(view({ pollDetail: "earnings 6-K time unconfirmed" }))).toBe(
      "Waiting for the earnings 6-K · Opus · high",
    );
  });

  it("manual only, ambiguous, cancelled", () => {
    expect(pollStateText(view({ pollState: "manual_only", pollDetail: "armed after 9 pm — Run summary to spend" }))).toBe(
      "Armed after 9 pm — nothing runs on its own",
    );
    expect(pollStateText(view({ pollState: "ambiguous", pollDetail: "names Q2, not Q3" }))).toBe(
      "Filing found but it does not name this quarter: names Q2, not Q3",
    );
    expect(pollStateText(view({ pollState: "cancelled", shown: run({ status: "done" }) }))).toBe(
      "Disarmed — summary stopped",
    );
  });

  it("finished, failed and waiting runs say so in words", () => {
    expect(pollStateText(view({ pollState: "found", shown: run({ status: "done" }) }))).toBe(
      "Summary ready · Opus 5.5 high",
    );
    const failed = run({
      status: "failed",
      sectionStates: [{ form: "8-K", acceptedAtEt: "4:05 pm", status: "failed", errorClass: "timeout" }],
    });
    expect(pollStateText(view({ pollState: "found", shown: failed }))).toBe(
      "Summary failed — the model call timed out",
    );
    const waiting = run({
      status: "waiting_retry",
      sectionStates: [
        { form: "8-K", acceptedAtEt: "4:05 pm", status: "failed", errorClass: "model_error" },
        { form: "10-Q", acceptedAtEt: "5:10 pm", status: "waiting_retry", errorClass: "awaiting_retry" },
      ],
    });
    expect(pollStateText(view({ pollState: "found", shown: waiting }))).toBe(
      "Summary paused — a later filing waits for Retry",
    );
  });

  it("found with no run yet says whether money waits on a click", () => {
    expect(pollStateText(view({ pollState: "found" }))).toBe("Earnings 8-K found — summary starting");
    expect(pollStateText(view({ pollState: "found", runSummaryAvailable: true }))).toBe(
      "Earnings 8-K found — Run summary to start",
    );
  });

  it("no CIK reads the poller's own detail", () => {
    expect(pollStateText(view({ pollState: "no_cik", pollDetail: "no SEC filer found for ZZA" }))).toBe(
      "No SEC filer found for ZZA",
    );
  });
});

describe("countsText", () => {
  it("states the spec's example and omits zero parts", () => {
    expect(countsText({ ...ZERO, claims: 12, checked: 9, contradicted: 1, unconfirmed: 2 })).toBe(
      "12 claims · 9 checked · 1 contradicted · 2 unconfirmed",
    );
    expect(countsText({ ...ZERO, claims: 1, checked: 1 })).toBe("1 claim · 1 checked");
    expect(countsText({ ...ZERO, claims: 3, warning: 2, qualitative: 1 })).toBe(
      "3 claims · 2 with warnings · 1 qualitative",
    );
  });
});

describe("statusLabel and statusTone", () => {
  const LABELS: Record<ClaimStatus, string> = {
    contradicted: "Contradicted",
    periods_differ: "Periods differ",
    not_in_filing: "Not in the filing",
    quote_not_found: "Quote not found",
    ambiguous_quote: "Quote matches more than once",
    figure_not_bound: "Figure not tied to the filing",
    unconfirmed: "Unconfirmed",
    checked: "Checked",
    qualitative: "Qualitative",
  };

  it("every ClaimStatus has its short word", () => {
    for (const status of Object.keys(STATUS_SEVERITY) as ClaimStatus[]) {
      expect(statusLabel(status), status).toBe(LABELS[status]);
    }
  });

  it("the tone follows STATUS_SEVERITY onto the Chip's own tones", () => {
    const byTone = { danger: "down", warning: "warn", muted: "neutral", ok: "up" } as const;
    for (const status of Object.keys(STATUS_SEVERITY) as ClaimStatus[]) {
      expect(statusTone(status), status).toBe(byTone[STATUS_SEVERITY[status]]);
    }
  });
});

describe("rough cost copy (controller ruling 2)", () => {
  it("covers every picker choice with the measured or relative figure", () => {
    const expected: Record<string, string> = {
      "Sonnet · medium": "Sonnet costs half as much per token as Opus",
      "Opus · medium": "less than Opus · high",
      "Opus · high": "about $0.80 per 8-K (measured); long filings cost more",
      "Fable · medium": "Fable costs 2.5 times as much per token as Opus",
      "Fable · high": "Fable costs 2.5 times as much per token as Opus",
    };
    for (const c of SUMMARY_CHOICES) {
      expect(roughCostText(c), choiceLabel(c)).toBe(expected[choiceLabel(c)]);
    }
    expect(Object.keys(ROUGH_COST_BY_CHOICE)).toHaveLength(SUMMARY_CHOICES.length);
  });

  it("the run question names the choice, the model now behind it and the cost", () => {
    const msg = runConfirmMessage({ family: "opus", effort: "high" }, "Opus · now 5.5");
    expect(msg).toContain("Opus · high");
    expect(msg).toContain("Opus · now 5.5");
    expect(msg).toContain("Rough cost: about $0.80 per 8-K (measured); long filings cost more.");
  });
});

describe("optionText", () => {
  it("suffixes the family's now-label", () => {
    expect(optionText({ choice: { family: "fable", effort: "high" }, label: "Fable · high", nowLabel: "Fable · now 5.1" })).toBe(
      "Fable · high — now 5.1",
    );
    expect(
      optionText({ choice: { family: "sonnet", effort: "medium" }, label: "Sonnet · medium", nowLabel: "Sonnet · not available" }),
    ).toBe("Sonnet · medium — not available");
  });
});

describe("an earnings filing whose time could not be confirmed (round 2 ruling)", () => {
  it("is not 'no filing': it says found, not run automatically, with Run summary offered", () => {
    for (const pollState of ["past_cutoff", "waiting"] as const) {
      const v = view({ pollState, earningsTimeUnconfirmed: true, runSummaryAvailable: true, earningsForm: "8-K" });
      expect(pollStateText(v), pollState).toBe(
        "Earnings 8-K found, but its filing time could not be confirmed — not run automatically",
      );
    }
    expect(
      pollStateText(view({ pollState: "past_cutoff", earningsTimeUnconfirmed: true, runSummaryAvailable: true, earningsForm: "6-K" })),
    ).toBe("Earnings 6-K found, but its filing time could not be confirmed — not run automatically");
  });
  it("gives way to the run once one exists", () => {
    const v = view({ pollState: "past_cutoff", earningsTimeUnconfirmed: true, shown: run({ status: "done" }) });
    expect(pollStateText(v)).toBe("Summary ready · Opus 5.5 high");
  });
});

describe("an earlier day's print with no summary state (browser pass Bug 2)", () => {
  it("reads No filing summary for this print, never Waiting", () => {
    expect(pollStateText(view({ pollState: null, pastWithoutSummary: true }))).toBe("No filing summary for this print");
  });
  it("never polls", () => {
    expect(needsPolling(view({ pollState: null, pastWithoutSummary: true }))).toBe(false);
  });
});

describe("final review: SEC unreachable after the print left the tick window", () => {
  it("says nothing more will run, never 'still trying', and stops polling", () => {
    const v = view({ pollState: "sec_unreachable", outsideTickWindow: true });
    expect(pollStateText(v)).toBe("SEC was not reachable; nothing more will run on its own");
    expect(needsPolling(v)).toBe(false);
  });
  it("inside the window it is still trying", () => {
    expect(pollStateText(view({ pollState: "sec_unreachable" }))).toBe("SEC not reachable — still trying");
  });
});

describe("final review I5: the runner failed to load", () => {
  it("the panel says so ahead of any other state", () => {
    expect(pollStateText(view({ pollState: "waiting", pollDetail: "summary runner failed to load — report this" }))).toBe(
      "Summary runner failed to load — report this",
    );
  });
});

describe("final review C1: a late arm", () => {
  it("keeps the manual_only copy, and Run summary is offered once filings exist", () => {
    expect(pollStateText(view({ pollState: "manual_only", runSummaryAvailable: true }))).toBe(
      "Armed after 9 pm — nothing runs on its own",
    );
  });
});

describe("needsPolling", () => {
  it("polls while a run runs or the filing is still being looked for", () => {
    for (const s of ["waiting", "found", "sec_unreachable"] as const) {
      expect(needsPolling(view({ pollState: s })), s).toBe(true);
    }
    expect(needsPolling(view({ pollState: "past_cutoff", shown: run() }))).toBe(true);
    expect(needsPolling(view({ pollState: "past_cutoff", shown: run({ status: "done" }), inProgress: run() }))).toBe(true);
  });
  it("polls a just-armed print the poller has not seen yet (no state row)", () => {
    expect(needsPolling(view({ pollState: null }))).toBe(true);
    expect(needsPolling(view({ pollState: null }), false)).toBe(true);
  });
  it("a read-only panel never polls, whatever the state", () => {
    expect(needsPolling(view({ pollState: null }), true)).toBe(false);
    expect(needsPolling(view({ pollState: "waiting" }), true)).toBe(false);
    expect(needsPolling(view({ pollState: "found", shown: run() }), true)).toBe(false);
  });
  it("stops once nothing will change on its own", () => {
    for (const s of ["past_cutoff", "manual_only", "cancelled", "ambiguous", "no_cik"] as const) {
      expect(needsPolling(view({ pollState: s, shown: run({ status: "done" }) })), s).toBe(false);
    }
  });
});

function cmp(o: Partial<ViewComparisonCheck> = {}): ViewComparisonCheck {
  return {
    relation: "below",
    verdict: "contradicted",
    difference: 31_000_000,
    differencePct: 0.05,
    shownText: "+0.05%",
    reasons: [{ code: "relation_contradicted", figureId: null, detail: "" }],
    left: { figureId: "f1", displayText: "$64.601B", source: "filing" },
    right: {
      figureId: "b1",
      displayText: "$64.57B",
      source: "bogey",
      bogey: { label: "Revenue", value: 64_570_000_000, unit: "usd", provenance: "Finnhub consensus", asOf: "2026-10-20" },
    },
    ...o,
  } as ViewComparisonCheck;
}

function claimOf(o: Partial<ViewClaim>): ViewClaim {
  return {
    claimId: "c",
    renderedText: "t",
    status: "checked",
    top: true,
    routine: false,
    footnotes: [],
    figureChecks: [],
    comparisonChecks: [],
    reasons: [],
    correction: null,
    correctedBy: null,
    ...o,
  } as ViewClaim;
}

describe("contradictionLines", () => {
  it("shows the app's arithmetic with the bogey's source and date", () => {
    const lines = contradictionLines(claimOf({ status: "contradicted", comparisonChecks: [cmp(), cmp()] }));
    expect(lines).toEqual(["filing: $64.601B is above $64.57B (Finnhub consensus, 2026-10-20), +0.05%"]);
    expect(lines[0]).toBe(comparisonLine(cmp()));
  });
  it("is empty for a claim that is not contradicted, and skips matching comparisons", () => {
    expect(contradictionLines(claimOf({ status: "checked", comparisonChecks: [cmp()] }))).toEqual([]);
    expect(
      contradictionLines(claimOf({ status: "contradicted", comparisonChecks: [cmp({ verdict: "matches" })] })),
    ).toEqual([]);
  });
});

describe("claimReasonLine", () => {
  it("gives one deduplicated line of reasons for a warning or muted claim", () => {
    const line = claimReasonLine(
      claimOf({
        status: "quote_not_found",
        reasons: [{ code: "quote_not_found", figureId: null, detail: "" }],
        figureChecks: [
          { figureId: "f", established: false, foundValue: null, reasons: [{ code: "quote_not_found", figureId: "f", detail: "" }, { code: "scale_unconfirmed", figureId: "f", detail: "" }] },
        ],
      }),
    );
    expect(line).toBe(`${reasonText("quote_not_found")} ${reasonText("scale_unconfirmed")}`);
    expect(
      claimReasonLine(claimOf({ status: "unconfirmed", reasons: [{ code: "period_unconfirmed", figureId: null, detail: "" }] })),
    ).toBe(reasonText("period_unconfirmed"));
  });
  it("is null for checked, qualitative and contradicted claims, and when no reason is stored", () => {
    for (const status of ["checked", "qualitative", "contradicted"] as const) {
      expect(claimReasonLine(claimOf({ status, reasons: [{ code: "computed", figureId: null, detail: "" }] })), status).toBeNull();
    }
    expect(claimReasonLine(claimOf({ status: "unconfirmed" }))).toBeNull();
  });
});

describe("footnoteTitle", () => {
  it("explains a quote that was not found or appears twice", () => {
    expect(footnoteTitle({ status: "not_found", page: null, para: null })).toMatch(/not found/i);
    expect(footnoteTitle({ status: "ambiguous", page: null, para: null })).toMatch(/more than once/i);
    expect(footnoteTitle({ status: "found", page: 2, para: 4 })).toBe("Page 2, paragraph 4 · opens on sec.gov");
    expect(footnoteTitle({ status: "found", page: null, para: 4 })).toBe("Paragraph 4 · opens on sec.gov");
  });
});

describe("newRequestKey", () => {
  it("is a fresh non-empty key each time, at most 200 characters", () => {
    const a = newRequestKey();
    const b = newRequestKey();
    expect(a.length).toBeGreaterThan(8);
    expect(a.length).toBeLessThanOrEqual(200);
    expect(a).not.toBe(b);
  });
});
