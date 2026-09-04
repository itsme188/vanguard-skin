import { describe, it, expect } from "vitest";
import {
  composePostPrintSheetHtml,
  composePostPrintText,
  type PostPrintSheetInputs,
} from "@/lib/earnings/print-sheet";

function inputs(over: Partial<PostPrintSheetInputs> = {}): PostPrintSheetInputs {
  return {
    symbol: "XMPL",
    eventDate: "2026-09-10",
    slot: "AMC",
    lines: [
      { metricId: "eps_adj_q", label: "Adjusted EPS", stateWord: "accepted", bogeyText: "$0.91", reportedText: "$0.96", deltaText: "+5.5%" },
      { metricId: "revenue_q", label: "Revenue", stateWord: "agreed", bogeyText: "$877.3M", reportedText: "$898.2M", deltaText: "+2.4%" },
      { metricId: "fy_rev_guide", label: "FY revenue guide", stateWord: "single source", bogeyText: "—", reportedText: "$3.60B–$3.62B", deltaText: "—" },
    ],
    callouts: [{ label: "RPO", valueText: "$1.94B", vsBogeyText: "vs guide $1.90B (+2.1%)" }],
    read: {
      read: ["Billings accelerated."],
      call_watch: ["Net retention", "Guide bridge", "Headcount"],
      caveats: ["PDF-only lines are unverified."],
    },
    bogeysMd: "## Sheet bogeys — by source\n\n| Metric | VK (9/9) |\n|---|---|\n| EPS | 0.91 |",
    notes: [{ date: "2026-09-08", noteType: "thesis", symbol: "XMPL", content: "Watch the guide." }],
    printedAtEt: "4:07 PM ET",
    ...over,
  };
}

describe("composePostPrintSheetHtml", () => {
  it("renders every section, the title and the printed-at footer", () => {
    const html = composePostPrintSheetHtml(inputs());
    for (const s of ["Scoreboard", "Adjusted EPS", "+5.5%", "Accepted callouts", "RPO",
                     "First-pass read", "Billings accelerated", "Watch on the call", "Net retention",
                     "Sheet bogeys", "Your notes", "Watch the guide", "printed 4:07 PM ET"]) {
      expect(html, s).toContain(s);
    }
    expect(html).toContain("XMPL post-print sheet — 2026-09-10 (AMC)");
  });

  it("omits a section entirely when its input is empty — never an empty heading", () => {
    const html = composePostPrintSheetHtml(inputs({ callouts: [], read: null, notes: [], bogeysMd: "" }));
    expect(html).toContain("Scoreboard");
    for (const s of ["Accepted callouts", "First-pass read", "Watch on the call", "Sheet bogeys", "Your notes"]) {
      expect(html, s).not.toContain(s);
    }
  });

  it("rung 2 drops the bogeys-by-source block and NOTHING else", () => {
    const full = composePostPrintSheetHtml(inputs());
    const dropped = composePostPrintSheetHtml(inputs(), { dropFlexible: true });
    expect(full).toContain("Sheet bogeys");
    expect(dropped).not.toContain("Sheet bogeys");
    for (const s of ["Scoreboard", "Accepted callouts", "First-pass read", "Your notes"]) {
      expect(dropped, s).toContain(s);
    }
  });

  it("rung 3 stacks the compact marker on top of the dropped block", () => {
    const compact = composePostPrintSheetHtml(inputs(), { dropFlexible: true, compact: true });
    expect(compact).toContain("<!-- compact-print-sheet -->");
    expect(compact).not.toContain("Sheet bogeys");
  });

  it("is a pure function of its inputs (same in, byte-identical out)", () => {
    expect(composePostPrintSheetHtml(inputs())).toBe(composePostPrintSheetHtml(inputs()));
  });

  it("prints real numbers — paper is local and is never privacy-masked", () => {
    expect(composePostPrintSheetHtml(inputs())).toContain("$898.2M");
  });
});

describe("composePostPrintText", () => {
  it("lays the scoreboard out in fixed-width columns with the callouts and the read", () => {
    const text = composePostPrintText(inputs());
    const header = text.split("\n").find((l) => l.includes("METRIC"))!;
    const epsRow = text.split("\n").find((l) => l.includes("Adjusted EPS"))!;
    expect(header.indexOf("REPORTED")).toBe(epsRow.indexOf("$0.96"));
    expect(text).toContain("RPO");
    expect(text).toContain("Billings accelerated.");
    expect(text.split("\n").every((l) => l.length <= 80)).toBe(true);
  });
});
