import { describe, expect, it } from "vitest";
import {
  ROUGH_COST_BY_CHOICE,
  countsText,
  footnoteTitle,
  needsPolling,
  newRequestKey,
  optionText,
  pollStateText,
  readingDocs,
  roughCostText,
  runConfirmMessage,
  statusLabel,
  statusTone,
} from "@/app/dashboard/today/filing-summary-text";
import { SUMMARY_CHOICES, choiceLabel } from "@/lib/filing-summary/choice";
import { STATUS_SEVERITY, type ClaimStatus, type StatusCounts } from "@/lib/filing-summary/types";
import { shareCountsText } from "@/lib/filing-summary/share-page";
import type { FullView, PanelView, RunSummary } from "@/lib/filing-summary/view";

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
    pollDetail: null,
    shown: null,
    inProgress: null,
    runSummaryAvailable: false,
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
    expect(pollStateText(view({ pollState: "past_cutoff", pollDetail: "no earnings 8-K filed by 8 pm" }))).toBe(
      "No earnings 8-K filed by 8 pm",
    );
    expect(pollStateText(view({ pollState: "past_cutoff", pollDetail: "no earnings 6-K filed by 8 pm" }))).toBe(
      "No earnings 6-K filed by 8 pm",
    );
  });

  it("a foreign filer's waiting line says 6-K once the poller has named it", () => {
    expect(pollStateText(view({ pollDetail: "earnings 6-K time unconfirmed" }))).toBe(
      "Waiting for the earnings 6-K · Opus · high",
    );
  });

  it("manual only, ambiguous, cancelled", () => {
    expect(pollStateText(view({ pollState: "manual_only", pollDetail: "armed after 8 pm — Run summary to spend" }))).toBe(
      "Armed after 8 pm — nothing runs on its own",
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

  it("reads the same as the shareable page's header", () => {
    const samples: StatusCounts[] = [
      ZERO,
      { claims: 12, checked: 9, contradicted: 1, warning: 0, unconfirmed: 2, qualitative: 0 },
      { claims: 5, checked: 0, contradicted: 0, warning: 3, unconfirmed: 1, qualitative: 1 },
    ];
    for (const c of samples) expect(countsText(c)).toBe(shareCountsText(c));
  });
});

describe("statusLabel and statusTone", () => {
  const LABELS: Record<ClaimStatus, string> = {
    contradicted: "Contradicted",
    periods_differ: "Periods differ",
    not_in_filing: "Not in filing",
    quote_not_found: "Quote not found",
    ambiguous_quote: "Ambiguous quote",
    figure_not_bound: "Figure not bound",
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
      "Sonnet · medium": "about $0.11 per filing",
      "Opus · medium": "less than Opus · high",
      "Opus · high": "about $0.32 per filing",
      "Fable · medium": "less than Fable · high",
      "Fable · high": "about $0.68 per filing",
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
    expect(msg).toContain("about $0.32 per filing");
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

describe("needsPolling", () => {
  it("polls while a run runs or the filing is still being looked for", () => {
    for (const s of ["waiting", "found", "sec_unreachable"] as const) {
      expect(needsPolling(view({ pollState: s })), s).toBe(true);
    }
    expect(needsPolling(view({ pollState: "past_cutoff", shown: run() }))).toBe(true);
    expect(needsPolling(view({ pollState: "past_cutoff", shown: run({ status: "done" }), inProgress: run() }))).toBe(true);
  });
  it("stops once nothing will change on its own", () => {
    for (const s of ["past_cutoff", "manual_only", "cancelled", "ambiguous", "no_cik"] as const) {
      expect(needsPolling(view({ pollState: s, shown: run({ status: "done" }) })), s).toBe(false);
    }
  });
});

describe("readingDocs", () => {
  it("counts the read exhibits of the running section's filing", () => {
    const full = {
      runs: [
        {
          runId: 7,
          sections: [
            { filingId: 1, form: "8-K", status: "running" },
            { filingId: 2, form: "10-Q", status: "pending" },
          ],
        },
      ],
      filings: [
        {
          filingId: 1,
          form: "8-K",
          documents: [
            { fileName: "a.htm", docType: "8-K", status: "fetched" },
            { fileName: "b.htm", docType: "EX-99.1", status: "fetched" },
            { fileName: "c.htm", docType: "EX-99.2", status: "fetched" },
            { fileName: "d.htm", docType: "EX-104", status: "fetched" },
            { fileName: "e.xsd", docType: "EX-101.SCH", status: "skipped" },
          ],
        },
      ],
    } as unknown as FullView;
    expect(readingDocs(full, 7)).toEqual({ form: "8-K", exhibits: 3 });
    expect(readingDocs(full, 99)).toBeNull();
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
