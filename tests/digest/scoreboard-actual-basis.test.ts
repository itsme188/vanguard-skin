/**
 * Owner ruling 2026-10-08: "Recap scoreboard actuals: the worksheet or parsed
 * adjusted figure leads, with the vendor figure as a footnote; with no
 * worksheet figure, the vendor figure shows with a basis label."
 *
 * The EPS / Revenue rows stay byte-identical (other surfaces and tests read
 * them); the basis is one short line under the table. The Worker half is
 * workers/cron/test/fallback-earnings.test.ts, which pins the same two label
 * strings against lib/earnings/actuals-basis.ts.
 *
 * Synthetic figures only.
 */
import { describe, it, expect } from "vitest";
import { renderHeadlineTable } from "@/lib/digest/send-earnings-email";
import {
  ACTUALS_BASIS_ADJUSTED_LINE,
  ACTUALS_BASIS_VENDOR_LINE,
} from "@/lib/earnings/actuals-basis";
import type { CalendarEvent } from "@/lib/types";

type ScoreboardEvent = Pick<
  CalendarEvent,
  "consensus_estimate" | "actual_value" | "consensus_value" | "reaction_snapshot"
> &
  Partial<Pick<CalendarEvent, "manual_actuals_at" | "vendor_actual_value">>;

const STAMP = "2026-01-06 21:30:00";
const CONSENSUS = "EPS 1.00 · Rev 500000000";
const FOOTNOTE_WORDS = "vendor figure (basis may differ)";

function ev(over: Partial<ScoreboardEvent>): ScoreboardEvent {
  return {
    consensus_estimate: CONSENSUS,
    consensus_value: null,
    actual_value: null,
    reaction_snapshot: null,
    ...over,
  };
}
const recap = (over: Partial<ScoreboardEvent>) => renderHeadlineTable(ev(over), "ZZA", "recap");
const lines = (md: string) => md.split("\n");
const basisLines = (md: string) => lines(md).filter((l) => l.includes("Actuals basis"));

describe("recap scoreboard: which figure is shown, and on what basis", () => {
  it("label strings (pinned; the Worker mirrors them)", () => {
    expect(ACTUALS_BASIS_VENDOR_LINE).toBe("*Actuals basis: vendor.*");
    expect(ACTUALS_BASIS_ADJUSTED_LINE).toBe(
      "*Actuals basis: adjusted (worksheet or hand-entered figure).*",
    );
  });

  it("vendor only: the vendor figure shows with a 'vendor' basis label and no footnote", () => {
    const md = recap({ actual_value: "EPS 1.10 · Rev 510,000,000" });
    expect(lines(md)).toContain("| **EPS** | 1.00 | 1.10 | +10.0% |");
    expect(lines(md)).toContain("| **Revenue** | $500.0M | $510.0M | +2.0% |");
    expect(basisLines(md)).toEqual([ACTUALS_BASIS_VENDOR_LINE]);
    expect(md).not.toContain(FOOTNOTE_WORDS);
  });

  it("promoted with a differing vendor figure: the adjusted figure leads, the vendor figure is a footnote", () => {
    const md = recap({
      actual_value: "EPS 1.10 · Rev 510000000",
      manual_actuals_at: STAMP,
      vendor_actual_value: "EPS 1.02 · Rev 505,000,000",
    });
    // The rows carry the promoted figure; the one delta is against consensus.
    expect(lines(md)).toContain("| **EPS** | 1.00 | 1.10 | +10.0% |");
    expect(lines(md)).toContain("| **Revenue** | $500.0M | $510.0M | +2.0% |");
    expect(basisLines(md)).toEqual([
      "*Actuals basis: adjusted (worksheet or hand-entered figure). For reference, vendor figure (basis may differ): EPS 1.02 · Revenue $505.0M.*",
    ]);
    // No second delta is invented for the vendor figure.
    expect(basisLines(md)[0]).not.toMatch(/%/);
  });

  it("promoted with no vendor figure kept: adjusted label, no footnote", () => {
    const md = recap({ actual_value: "EPS 1.10 · Rev 510000000", manual_actuals_at: STAMP });
    expect(basisLines(md)).toEqual([ACTUALS_BASIS_ADJUSTED_LINE]);
    expect(md).not.toContain(FOOTNOTE_WORDS);
  });

  it("a vendor figure that parses to the same numbers is not a footnote", () => {
    const md = recap({
      actual_value: "EPS 1.10 · Rev 510000000",
      manual_actuals_at: STAMP,
      vendor_actual_value: "EPS 1.10 · Rev 510,000,000",
    });
    expect(basisLines(md)).toEqual([ACTUALS_BASIS_ADJUSTED_LINE]);
  });

  it("only the part that differs is footnoted (an EPS-only save keeps the vendor revenue in the row)", () => {
    const md = recap({
      actual_value: "EPS 1.10 · Rev 505000000",
      manual_actuals_at: STAMP,
      vendor_actual_value: "EPS 1.02 · Rev 505,000,000",
    });
    expect(basisLines(md)).toEqual([
      "*Actuals basis: adjusted (worksheet or hand-entered figure). For reference, vendor figure (basis may differ): EPS 1.02.*",
    ]);
  });

  it("the vendor's 'Rev 0' placeholder is not a figure", () => {
    const md = recap({
      actual_value: "EPS 1.10 · Rev 510000000",
      manual_actuals_at: STAMP,
      vendor_actual_value: "EPS 1.02 · Rev 0",
    });
    expect(basisLines(md)[0]).toContain("vendor figure (basis may differ): EPS 1.02.*");
    expect(basisLines(md)[0]).not.toContain("Revenue");

    const none = recap({
      actual_value: "EPS 1.10 · Rev 510000000",
      manual_actuals_at: STAMP,
      vendor_actual_value: "Rev 0",
    });
    expect(basisLines(none)).toEqual([ACTUALS_BASIS_ADJUSTED_LINE]);
  });

  it("the plausibility gate applies to the footnoted vendor figure too", () => {
    // A sign flip against consensus is the scrape/basis failure the gate
    // exists for. The hand-entered figure still leads; the flagged vendor
    // figure is not printed.
    const md = recap({
      consensus_estimate: "EPS 1.74",
      actual_value: "EPS 1.80",
      manual_actuals_at: STAMP,
      vendor_actual_value: "EPS -1.20",
    });
    expect(lines(md)).toContain("| **EPS** | 1.74 | 1.80 | +3.4% |");
    expect(basisLines(md)).toEqual([ACTUALS_BASIS_ADJUSTED_LINE]);
    expect(md).not.toContain("-1.20");
  });

  it("an unstamped vendor figure flagged implausible is blanked and carries no basis label", () => {
    const md = recap({ consensus_estimate: "EPS 1.74", actual_value: "EPS -1.20" });
    expect(lines(md)).toContain("| **EPS** | 1.74 | — | — |");
    expect(basisLines(md)).toEqual([]);
    expect(md).toContain("flagged as implausible");
  });

  it("no actual shown, no basis label: a recap without an actual and every preview", () => {
    expect(basisLines(recap({}))).toEqual([]);
    const preview = renderHeadlineTable(
      ev({
        actual_value: "EPS 1.10 · Rev 510000000",
        manual_actuals_at: STAMP,
        vendor_actual_value: "EPS 1.02",
      }),
      "ZZA",
      "preview",
    );
    expect(basisLines(preview)).toEqual([]);
    expect(preview).not.toContain(FOOTNOTE_WORDS);
  });

  it("the basis line sits between the table and the standing footnote", () => {
    const md = recap({ actual_value: "EPS 1.10 · Rev 510,000,000" });
    const all = lines(md);
    const basisAt = all.indexOf(ACTUALS_BASIS_VENDOR_LINE);
    const lastRowAt = all.findIndex((l) => l.startsWith("| **QQQ @ T+2h** |"));
    const footnoteAt = all.findIndex((l) => l.startsWith("*Empty cells in a preview"));
    expect(all[basisAt - 1]).toBe("");
    expect(all[basisAt + 1]).toBe("");
    expect(lastRowAt).toBeLessThan(basisAt);
    expect(basisAt).toBeLessThan(footnoteAt);
  });
});
