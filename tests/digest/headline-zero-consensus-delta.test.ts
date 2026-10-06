/**
 * Recap scoreboard, two rendering fixes (Mac half; the Worker half is
 * workers/cron/test/fallback-earnings.test.ts — same fixture set, same
 * expected strings):
 *
 *  1. Zero-consensus EPS. A percent surprise against a $0.00 estimate is
 *     undefined, but the beat/miss is real. The scoreboard used to print "—";
 *     it now prints the signed absolute-dollar label the UI chip already uses
 *     (lib/earnings/eps-delta.ts — the single convention).
 *  2. Revenue just under $1B. The unit was picked before rounding, so
 *     $999.96M printed "$1000.0M". Revenue cells now promote to "$1.00B".
 *
 * Synthetic figures only.
 */
import { describe, it, expect } from "vitest";
import { renderHeadlineTable } from "@/lib/digest/send-earnings-email";
import { epsDelta } from "@/lib/earnings/eps-delta";
import type { CalendarEvent } from "@/lib/types";

type ScoreboardEvent = Pick<
  CalendarEvent,
  "consensus_estimate" | "actual_value" | "consensus_value" | "reaction_snapshot"
>;

function cells(md: string, label: string): string[] {
  const row = md.split("\n").find((l) => l.startsWith(`| **${label}** |`));
  if (!row) throw new Error(`no ${label} row in:\n${md}`);
  return row.split("|").slice(1, -1).map((c) => c.trim());
}

function recap(consensus: string, actual: string): string {
  const ev: ScoreboardEvent = {
    consensus_estimate: consensus,
    actual_value: actual,
    consensus_value: null,
    reaction_snapshot: null,
  };
  return renderHeadlineTable(ev, "ACME", "recap");
}

// PARITY FIXTURES — mirrored verbatim in workers/cron/test/fallback-earnings.test.ts.
const ZERO_CONSENSUS_EPS_FIXTURES: Array<[string, string, string]> = [
  ["EPS 0.00 · Rev 500000000", "EPS 0.45 · Rev 510000000", "+$0.45"],
  ["EPS 0.00 · Rev 500000000", "EPS -0.01 · Rev 510000000", "-$0.01"],
  ["EPS 0 · Rev 500000000", "EPS 0 · Rev 510000000", "in-line"],
  ["EPS 1.00 · Rev 500000000", "EPS 1.10 · Rev 510000000", "+10.0%"],
];

describe("recap scoreboard — zero-consensus EPS delta", () => {
  for (const [consensus, actual, expected] of ZERO_CONSENSUS_EPS_FIXTURES) {
    it(`${consensus} vs ${actual} → ${expected}`, () => {
      const delta = cells(recap(consensus, actual), "EPS")[3];
      expect(delta).toBe(expected);
      // One convention: the email cell equals the UI chip label.
      expect(delta).toBe(epsDelta(consensus, actual)?.label);
    });
  }

  it("revenue delta is untouched by the EPS zero rule", () => {
    const md = recap("EPS 0.00 · Rev 500000000", "EPS 0.45 · Rev 510000000");
    expect(cells(md, "Revenue")[3]).toBe("+2.0%");
  });

  it("a zero-revenue placeholder still renders no delta", () => {
    const md = recap("EPS 0.00 · Rev 0", "EPS 0.45 · Rev 510000000");
    expect(cells(md, "Revenue")).toEqual(["**Revenue**", "—", "$510.0M", "—"]);
  });
});

describe("recap scoreboard — revenue unit is picked after rounding", () => {
  it("promotes a figure that rounds to 1000.0M into billions", () => {
    const md = recap("EPS 1.00 · Rev 999960000", "EPS 1.00 · Rev 999940000");
    const row = cells(md, "Revenue");
    expect(row[1]).toBe("$1.00B");
    expect(row[2]).toBe("$999.9M");
  });
});
