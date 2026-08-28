import { describe, it, expect } from "vitest";
import {
  renderHeadlineTable, renderPastPrintsBlock, type EarningsIntelView,
} from "@/lib/digest/send-earnings-email";
import type { CalendarEvent } from "@/lib/types";

type ScoreboardEvent = Pick<
  CalendarEvent,
  "consensus_estimate" | "actual_value" | "consensus_value" | "reaction_snapshot"
>;

const EVENT: ScoreboardEvent = {
  consensus_estimate: "EPS 1.35 · Rev 750M", actual_value: null,
  consensus_value: null, reaction_snapshot: null,
};

const HISTORY = [
  { reportedDate: "2026-04-22", fiscalDateEnding: "2026-03-31", epsActual: 1.42, epsEstimate: 1.35, surprisePct: 5.19, reportTime: "post-market" as const, postPrintMovePct: 4.1 },
  { reportedDate: "2026-01-28", fiscalDateEnding: "2025-12-31", epsActual: 1.1, epsEstimate: 1.2, surprisePct: -8.3, reportTime: "pre-market" as const, postPrintMovePct: -2.3 },
];

const INTEL: EarningsIntelView = {
  impliedMovePct: 4.8, impliedMethod: "straddle", sheetSourceLabel: null,
  expiryUsed: "2026-07-18",
  history: HISTORY,
  summary: { avgAbsMovePct: 3.2, beatCount: 6, missCount: 2, quarterCount: 8 },
};

describe("scoreboard intel rows", () => {
  it("straddle row + history row on preview", () => {
    const md = renderHeadlineTable(EVENT, "TER", "preview", INTEL);
    expect(md).toContain("| **Expected move** | ±4.8% (straddle, Jul 18 exp) | — | — |");
    expect(md).toContain("| **Avg move last 8 prints** | ±3.2% · beat 6/8 | — | — |");
  });
  it("IV-approx renders the ~ label", () => {
    const md = renderHeadlineTable(EVENT, "TER", "preview",
      { ...INTEL, impliedMethod: "iv_approx", impliedMovePct: 3.1 });
    expect(md).toContain("~±3.1% (IV approx)");
  });
  it("a sheet expected move renders with its source label (feedback #5)", () => {
    const md = renderHeadlineTable(EVENT, "TER", "preview", {
      ...INTEL,
      impliedMethod: "sheet",
      impliedMovePct: 6,
      sheetSourceLabel: "TMT Breakout 7/28 weekly",
    });
    expect(md).toContain("±6.0% (TMT Breakout 7/28 weekly)");
    expect(md).not.toContain("straddle");
  });
  it("a sheet move with no label falls back to the generic sheet wording", () => {
    const md = renderHeadlineTable(EVENT, "TER", "preview", {
      ...INTEL, impliedMethod: "sheet", impliedMovePct: 6, sheetSourceLabel: null,
    });
    expect(md).toContain("±6.0% (bogey sheet)");
  });
  it("missing intel renders dashes and stays 8 rows", () => {
    const md = renderHeadlineTable(EVENT, "TER", "preview",
      { ...INTEL, impliedMovePct: null, impliedMethod: null, summary: { avgAbsMovePct: null, beatCount: 0, missCount: 0, quarterCount: 0 } });
    expect(md).toContain("| **Expected move** | — | — | — |");
    expect(md).toContain("| **Avg move last 8 prints** | — | — | — |");
  });
  it("undefined intel (no cache at all) keeps rows with dashes", () => {
    const md = renderHeadlineTable(EVENT, "TER", "preview", null);
    expect(md).toContain("| **Expected move** | — | — | — |");
  });
  it("recap echoes implied vs realized with inside/outside verdict", () => {
    // Real reaction_snapshot shape (see readReactionDelta / ReactionSnapshot):
    // per-key node is `{ delta_pct: number }`, not `{ pct: number }`.
    const recapEvent: ScoreboardEvent = {
      ...EVENT, actual_value: "EPS 1.42 · Rev 775M",
      reaction_snapshot: JSON.stringify({
        symbol: { delta_pct: -7.2 }, spy: { delta_pct: 0.2 }, qqq: { delta_pct: 0.3 },
      }),
    };
    const md = renderHeadlineTable(recapEvent, "TER", "recap", INTEL);
    expect(md).toContain("**Expected move**");
    expect(md).toMatch(/±4\.8% \(straddle.*\|.*7\.2%.*\|.*outside/);
  });
});

describe("renderPastPrintsBlock", () => {
  it("renders one row per quarter, newest first", () => {
    const md = renderPastPrintsBlock(HISTORY);
    expect(md).toContain("## Past prints");
    expect(md).toContain("| 2026-04-22 | 1.42 / 1.35 | +5.2% | +4.1% |");
    expect(md).toContain("| 2026-01-28 | 1.10 / 1.20 | -8.3% | -2.3% |");
  });
  it("empty history → empty string", () => {
    expect(renderPastPrintsBlock([])).toBe("");
  });
});

/**
 * Scoreboard plausibility gate vs. the desk's own override.
 *
 * renderHeadlineTable blanks actuals that isPlausibleEarnings flags (Finnhub
 * drift defense) and appends a ⚠ line. A row stamped manual_actuals_at came
 * from POST /api/earnings/actuals — a human typed it — so the guard must not
 * apply, exactly as on the read surfaces (lib/earnings/actuals-display.ts).
 * Fixture: consensus EPS 1.74 vs a hand-entered EPS -1.20 (sign-flip branch).
 */
describe("scoreboard plausibility gate", () => {
  const IMPLAUSIBLE: ScoreboardEvent = {
    consensus_estimate: "EPS 1.74", actual_value: "EPS -1.20",
    consensus_value: null, reaction_snapshot: null,
  };

  it("blanks a scraped implausible actual and appends the ⚠ line (unchanged)", () => {
    const md = renderHeadlineTable(IMPLAUSIBLE, "ACME", "recap");
    expect(md).not.toContain("-1.20");
    expect(md).toContain("flagged as implausible");
  });

  it("renders a manually-stamped actual verbatim with no ⚠ line", () => {
    const md = renderHeadlineTable(
      { ...IMPLAUSIBLE, manual_actuals_at: "2026-08-28 14:02:11" },
      "ACME",
      "recap",
    );
    expect(md).toContain("-1.20");
    expect(md).not.toContain("flagged as implausible");
  });

  it("preview phase never shows actuals or the ⚠ line, stamped or not", () => {
    const md = renderHeadlineTable(
      { ...IMPLAUSIBLE, manual_actuals_at: "2026-08-28 14:02:11" },
      "ACME",
      "preview",
    );
    expect(md).not.toContain("-1.20");
    expect(md).not.toContain("flagged as implausible");
  });
});
