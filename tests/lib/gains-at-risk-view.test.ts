import { describe, expect, it } from "vitest";
import {
  BETA_SOURCE_LABELS,
  COLUMN_LABELS,
  DEFAULT_DRIVER,
  LINE_LABELS,
  NOT_MODELLED_LABELS,
  OVERRIDE_REFUSAL_LABELS,
  RECONCILIATION_REASON_LABELS,
  TABLE_MOVES,
  YEAR_GAIN_LABEL,
  customMoveProblem,
  defaultSweep,
  defaultValuationDate,
  disclosureSentences,
  disclosureShare,
  domainProblemText,
  formatDriverMove,
  formatDriverMoveLabel,
  BOOK_GAINS_TEXT,
  COMPUTE_FAILED_TEXT,
  DOWN_ONLY_NOTE,
  SAME_PRICE_TEXT,
  UNDER_TENTH_TEXT,
  ZERO_ROW_NOTE,
  chartDollarDomain,
  chartRows,
  givenBackCell,
  keptAxis,
  priceBoxOwners,
  requestFailureText,
  serverPropsAnswerControls,
  gainGivenBackShare,
  gainKeptShare,
  gainsRequestReducer,
  initialGainsRequestState,
  monthLabel,
  reconciliationLine,
  requestMoves,
  sameMove,
  scopeFreshnessCell,
  yearGainNote,
  type GainsRequestState,
} from "@/lib/analysis/gains-at-risk-view";
import {
  DEFAULT_ANALYSIS_SCOPE,
  GAINS_AT_RISK_DEFAULT_SCOPE,
  resolveGainsAtRiskScope,
} from "@/lib/analysis/view-param";
import {
  GAINS_AT_RISK_VOL_MAX,
  GAINS_AT_RISK_VOL_MIN,
  type GainsAtRiskResponse,
} from "@/lib/analysis/gains-at-risk-input";
import { VOL_MOVE_MAX, VOL_MOVE_MIN } from "@/lib/compute/option-reprice";
import type { GainsAtRiskResult } from "@/lib/compute/gains-at-risk";
import type { YearGainReconciliationStatus, YearGainResult } from "@/lib/compute/year-gain";
import type { PositionsFreshness } from "@/lib/queries/positions-freshness";

function gain(
  gainUsd: number | null,
  status: YearGainReconciliationStatus,
  extra: Partial<YearGainResult> = {},
): YearGainResult {
  return {
    gainUsd,
    valueNowUsd: 0,
    baseValueUsd: 0,
    netFlowsUsd: 0,
    baseDate: "2025-12-31",
    accounts: [],
    missingBaseAccounts: [],
    unusableCurrentAccounts: [],
    unconvertedFlowAccounts: [],
    reconciliation: {
      status,
      throughMonth: status === "not-checked" ? null : "2026-10-31",
      differenceUsd: status === "differs" ? 1_000 : status === "agrees" ? 0 : null,
    },
    ...extra,
  };
}

// Distinct synthetic responses: the reducer only moves them by reference.
const A = { tag: "A" } as unknown as GainsAtRiskResponse;
const B = { tag: "B" } as unknown as GainsAtRiskResponse;
const C = { tag: "C" } as unknown as GainsAtRiskResponse;
const D = { tag: "D" } as unknown as GainsAtRiskResponse;
const init = (data: GainsAtRiskResponse): GainsRequestState => initialGainsRequestState(data);

describe("gains at risk: sweep, table rows and the custom row", () => {
  it("the sweep runs -20% to +10% in 2.5% steps and holds every table row", () => {
    expect(defaultSweep()).toEqual([-0.2, -0.175, -0.15, -0.125, -0.1, -0.075, -0.05, -0.025, 0, 0.025, 0.05, 0.075, 0.1]);
    for (const m of TABLE_MOVES) expect(defaultSweep()).toContain(m);
    expect([...TABLE_MOVES]).toEqual([0, -0.05, -0.1, -0.15]);
  });

  it("the default driver and date", () => {
    expect(DEFAULT_DRIVER).toBe("QQQ");
    expect(defaultValuationDate("2026-11-24")).toBe("2026-12-31");
    expect(defaultValuationDate("2027-01-02")).toBe("2027-12-31");
  });

  it("the custom row takes zero or a fall no deeper than -60%", () => {
    expect(customMoveProblem(0.05)).not.toBeNull();
    expect(customMoveProblem(-0.07)).toBeNull();
    expect(customMoveProblem(0)).toBeNull();
    expect(customMoveProblem(-0.6)).toBeNull();
    expect(customMoveProblem(-0.61)).toMatch(/-60%/);
    expect(customMoveProblem(Number.NaN)).not.toBeNull();
    expect(customMoveProblem(Number.POSITIVE_INFINITY)).not.toBeNull();
  });

  it("request moves are the sweep, the table and the custom row, sorted and unique", () => {
    expect(requestMoves(defaultSweep(), -0.07)).toHaveLength(14);
    expect(requestMoves(defaultSweep(), null)).toHaveLength(13);
    expect(requestMoves(defaultSweep(), -0.1)).toHaveLength(13);
    const moves = requestMoves(defaultSweep(), -0.07);
    expect(moves).toEqual([...moves].sort((a, b) => a - b));
    expect(moves.some((m) => sameMove(m, -0.07))).toBe(true);
    // The table rows are always asked for, even when the sweep lacks them.
    expect(requestMoves([0.1, -0.1], -0.35)).toEqual([-0.35, -0.15, -0.1, -0.05, 0, 0.1]);
  });

  it("driver moves read as market percentages", () => {
    expect(formatDriverMove(-0.175)).toBe("−17.5%");
    expect(formatDriverMove(-0.1)).toBe("−10%");
    expect(formatDriverMove(0)).toBe("0%");
    expect(formatDriverMove(0.05)).toBe("+5%");
    expect(formatDriverMoveLabel(-0.1)).toBe("−10%");
    expect(formatDriverMoveLabel("x")).toBe("x");
  });
});

describe("gains at risk: the share of the year's gain", () => {
  it("given back and kept, when the gain is positive and not contradicted", () => {
    expect(gainGivenBackShare(-61_000, gain(400_000, "agrees"))).toBeCloseTo(0.1525);
    expect(gainGivenBackShare(-61_000, gain(400_000, "not-checked"))).toBeCloseTo(0.1525);
    expect(gainKeptShare(-61_000, gain(400_000, "agrees"))).toBeCloseTo(0.8475);
  });

  it("no share when the statements differ, or the gain is missing, zero or negative", () => {
    expect(gainGivenBackShare(-61_000, gain(400_000, "differs"))).toBeNull();
    expect(gainKeptShare(-61_000, gain(400_000, "differs"))).toBeNull();
    expect(gainGivenBackShare(-1, gain(0, "agrees"))).toBeNull();
    expect(gainGivenBackShare(-1, gain(null, "agrees"))).toBeNull();
    expect(gainGivenBackShare(-1, gain(-5_000, "agrees"))).toBeNull();
    expect(gainKeptShare(-1, gain(null, "agrees"))).toBeNull();
    expect(gainGivenBackShare(Number.NaN, gain(400_000, "agrees"))).toBeNull();
  });

  it("each refusal has its own reason line", () => {
    expect(yearGainNote(gain(400_000, "differs"))).toMatch(/statements/);
    expect(yearGainNote(gain(400_000, "agrees"))).toBeNull();
    expect(yearGainNote(gain(0, "agrees"))).toMatch(/zero or negative/);
    expect(yearGainNote(gain(-1, "agrees"))).toMatch(/zero or negative/);
    const flowsDisagree = gain(400_000, "differs", {
      reconciliation: { status: "differs", throughMonth: "2026-10-31", differenceUsd: null, reason: "flows-disagree" },
    });
    expect(yearGainNote(flowsDisagree)).toMatch(/ledger and a statement's own flow figure disagree/);
  });

  it("a missing gain names every account that stopped it", () => {
    const note = yearGainNote(
      gain(null, "not-checked", {
        missingBaseAccounts: [{ accountId: 1, name: "ZZ Alpha" }],
        unusableCurrentAccounts: [
          { accountId: 2, name: "ZZ Beta", reason: "no-current-value" },
          { accountId: 3, name: "ZZ Gamma", reason: "value-before-year" },
        ],
        unconvertedFlowAccounts: [{ accountId: 4, name: "ZZ Delta", count: 2 }],
      }),
    );
    expect(note).toMatch(/ZZ Alpha/);
    expect(note).toMatch(/ZZ Beta/);
    expect(note).toMatch(/ZZ Gamma/);
    expect(note).toMatch(/ZZ Delta/);
    expect(yearGainNote(gain(null, "not-checked"))).toMatch(/not available/);
  });

  it("not checked keeps the share and says why in plain words", () => {
    for (const reason of ["ledger-unverified", "foreign-in-kind", "month-without-figure"] as const) {
      const g = gain(400_000, "not-checked", {
        reconciliation: { status: "not-checked", throughMonth: null, differenceUsd: null, reason },
      });
      expect(gainGivenBackShare(-61_000, g)).toBeCloseTo(0.1525);
      // The reason prints once, on the statements-check line; the note does not repeat it.
      expect(yearGainNote(g)).toMatch(/not checked/);
      expect(yearGainNote(g)).not.toContain(RECONCILIATION_REASON_LABELS[reason]);
      expect(reconciliationLine(g).text).toBe(`not checked. ${RECONCILIATION_REASON_LABELS[reason]}`);
    }
  });

  it("the reconciliation line", () => {
    expect(monthLabel("2026-10-31")).toBe("October 2026");
    const agrees = reconciliationLine(gain(400_000, "agrees"));
    expect(agrees.text).toBe("agrees with the statements' own flow figures through October 2026");
    expect(agrees.differenceUsd).toBeNull();
    const differs = reconciliationLine(gain(400_000, "differs"));
    expect(differs.kind).toBe("differs");
    expect(differs.text).toBe("differs through October 2026 by");
    expect(differs.differenceUsd).toBe(1_000);
    const flows = reconciliationLine(
      gain(400_000, "differs", {
        reconciliation: { status: "differs", throughMonth: "2026-10-31", differenceUsd: null, reason: "flows-disagree" },
      }),
    );
    expect(flows.differenceUsd).toBeNull();
    expect(flows.text).toBe("differs through October 2026. The ledger and a statement's own flow figure disagree");
    const notChecked = reconciliationLine(
      gain(400_000, "not-checked", {
        reconciliation: { status: "not-checked", throughMonth: null, differenceUsd: null, reason: "foreign-in-kind" },
      }),
    );
    expect(notChecked.text).toContain(RECONCILIATION_REASON_LABELS["foreign-in-kind"]);
    expect(reconciliationLine(gain(400_000, "not-checked")).text).toMatch(/^not checked\. /);
    // One colon per line: the "Statements check:" label's own.
    for (const g of [agrees, differs, flows, notChecked]) expect(g.text).not.toContain(":");
  });

  it("the fixed words", () => {
    expect(YEAR_GAIN_LABEL).toBe("Year's gain so far");
    expect(COLUMN_LABELS).toEqual({
      move: "move",
      losers: "Positions that lose",
      offsets: "Offsetting positions",
      book: "Book",
      givenBack: "Gain given back",
    });
    expect(LINE_LABELS).toEqual({ book: "book", without: "without the offsetting positions" });
  });
});

describe("gains at risk: scope", () => {
  it("this page opens on every account; the Analysis default is unchanged", () => {
    expect(resolveGainsAtRiskScope(undefined)).toBe("all");
    expect(GAINS_AT_RISK_DEFAULT_SCOPE).toBe("all");
    expect(resolveGainsAtRiskScope("nope")).toBe("all");
    expect(resolveGainsAtRiskScope("ibkr")).toBe("ibkr");
    expect(resolveGainsAtRiskScope("vanguard")).toBe("vanguard");
    expect(DEFAULT_ANALYSIS_SCOPE).toBe("vanguard");
  });

  it("a scope with no accounts never reads as fresh", () => {
    const f = { accounts: [], newestDate: null, oldestCountedLiveDate: null, leftoverCount: 0 } as unknown as PositionsFreshness;
    const cell = scopeFreshnessCell(f, false);
    expect(cell.dateText).toBe("No accounts in this scope");
    expect(cell.tone).not.toBe("good");
  });
});

describe("gains at risk: disclosures", () => {
  const d = (count: number, shareOfBook: number | null, unknownValueCount: number) => ({
    count,
    shareOfBook,
    unknownValueCount,
    symbols: count > 0 ? ["ZZA"] : [],
  });

  it("four lines in a fixed order", () => {
    const lines = disclosureSentences({
      notModelled: d(2, 0.03, 0),
      betaEstimated: d(4, 0.18, 0),
      pricedFromModel: d(1, 0.01, 0),
      expiresBeforeDate: d(0, 0, 0),
    } as GainsAtRiskResult["disclosures"]);
    expect(lines.map((l) => l.key)).toEqual(["notModelled", "betaEstimated", "pricedFromModel", "expiresBeforeDate"]);
    expect(lines[0]).toMatchObject({ count: 2, shareOfBook: 0.03, unknownValueCount: 0 });
    expect(lines[0].text).toMatch(/Not modelled/);
    expect(lines[1].text).toMatch(/Beta estimated, not measured/);
  });

  it("an unknown value is never shown as a bare 0%", () => {
    expect(disclosureShare(d(2, null, 2))).toEqual({ kind: "not-known" });
    expect(disclosureShare(d(2, 0, 2))).toEqual({ kind: "omit" });
    expect(disclosureShare(d(2, 0.05, 1))).toEqual({ kind: "pct", value: 0.05 });
    expect(disclosureShare(d(0, 0, 0))).toEqual({ kind: "pct", value: 0 });
  });
});

describe("gains at risk: plain-words labels cover every reason", () => {
  it("not modelled", () => {
    for (const k of [
      "leveraged-no-factor",
      "leveraged-no-tracked-index",
      "tracked-index-not-measured",
      "no-driver-conversion",
      "no-heuristic-beta",
      "no-option-terms",
      "expired",
      "no-option-price",
      "no-underlying-price",
      "no-volatility",
      "no-price",
      "no-fx-rate",
    ] as const) {
      expect(NOT_MODELLED_LABELS[k]).toMatch(/\w/);
    }
  });

  it("beta sources and override refusals", () => {
    for (const k of ["driver", "measured", "market-converted", "estimated", "fixed", "leveraged", "not-modelled"] as const) {
      expect(BETA_SOURCE_LABELS[k]).toMatch(/\w/);
    }
    for (const k of ["not-positive", "below-intrinsic", "row-has-price", "not-solvable", "not-an-option"] as const) {
      expect(OVERRIDE_REFUSAL_LABELS[k]).toMatch(/\.$/);
    }
  });
});

describe("gains at risk: a response for an older request is never shown", () => {
  it("the sequence-number reducer", () => {
    let s = gainsRequestReducer(init(A), { type: "start", seq: 1 });
    expect(s.result).toBeNull();
    expect(s.loading).toBe(true);
    s = gainsRequestReducer(s, { type: "start", seq: 2 });
    expect(gainsRequestReducer(s, { type: "success", seq: 1, data: B })).toBe(s); // older response dropped
    expect(gainsRequestReducer(s, { type: "failure", seq: 1, message: "x" })).toBe(s);
    expect(gainsRequestReducer(s, { type: "success", seq: 2, data: C }).result).toBe(C);
    const failed = gainsRequestReducer(s, { type: "failure", seq: 2, message: "bad" });
    expect(failed.error).toBe("bad");
    expect(failed.result).toBeNull();
    expect(failed.loading).toBe(false);
    const reset = gainsRequestReducer(s, { type: "reset", data: D });
    expect(reset.result).toBe(D); // server props that answer the controls; later responses dropped
    expect(gainsRequestReducer(reset, { type: "success", seq: 2, data: C })).toBe(reset);
  });

  it("the last answer stays for layout only, never as the result", () => {
    const s0 = init(A);
    const s1 = gainsRequestReducer(s0, { type: "start", seq: 1 });
    expect(s1.result).toBeNull();
    expect(s1.previous).toBe(A);
    const failed = gainsRequestReducer(s1, { type: "failure", seq: 1, message: "bad" });
    expect(failed.result).toBeNull();
    expect(failed.previous).toBe(A);
    // A second start after a failure still keeps the last answer for layout.
    const s2 = gainsRequestReducer(failed, { type: "start", seq: 2 });
    expect(s2.previous).toBe(A);
    const ok = gainsRequestReducer(s2, { type: "success", seq: 2, data: B });
    expect(ok.previous).toBe(B);
    // A stale success after a newer start changes nothing, previous included.
    const s3 = gainsRequestReducer(ok, { type: "start", seq: 3 });
    expect(gainsRequestReducer(s3, { type: "success", seq: 2, data: C })).toBe(s3);
  });

  it("a start clears an earlier error", () => {
    const failed = gainsRequestReducer(gainsRequestReducer(init(A), { type: "start", seq: 1 }), {
      type: "failure",
      seq: 1,
      message: "bad",
    });
    expect(gainsRequestReducer(failed, { type: "start", seq: 2 }).error).toBeNull();
  });
});

describe("gains at risk: the route's refusal in the page's words", () => {
  it("names the control, not the request field", () => {
    expect(domainProblemText("valuationDate cannot be before today.")).toBe("The date cannot be before today.");
    expect(domainProblemText("volChangePoints must be a number between -20 and 60.")).toBe(
      "The volatility change must be a number between -20 and 60.",
    );
    expect(domainProblemText("driverSymbol must be one of SPY, QQQ, VTI.")).toBe("The index must be one of SPY, QQQ, VTI.");
    expect(domainProblemText("priceOverrides values must be numbers.")).toBe("Typed prices must be numbers.");
    expect(domainProblemText("priceOverrides can hold at most 200 entries.")).toBe("At most 200 typed prices can be sent at once.");
    expect(domainProblemText("moves must be a list of 1 to 41 numbers.")).toBe("The moves must be a list of 1 to 41 numbers.");
    expect(domainProblemText("Could not compute gains at risk.")).toBe("Could not compute gains at risk.");
  });
});

describe("gains at risk: fix round 1", () => {
  const row = (move: number, book: number, losers: number) => ({ move, bookPnlUsd: book, losersPnlUsd: losers, offsetsPnlUsd: book - losers });

  it("the chart plots only the sweep, in move order, even with a custom move present", () => {
    const moves = requestMoves(defaultSweep(), -0.07).map((m) => row(m, m * 1_000_000, m * 1_200_000));
    expect(moves.some((r) => sameMove(r.move, -0.07))).toBe(true);
    const rows = chartRows([...moves].reverse());
    expect(rows.map((r) => r.move)).toEqual(defaultSweep());
    expect(rows.some((r) => sameMove(r.move, -0.07))).toBe(false);
    const ten = rows.find((r) => sameMove(r.move, -0.1))!;
    expect(ten.book).toBeCloseTo(-100_000);
    expect(ten.without).toBeCloseTo(-120_000); // the positions that lose
  });

  it("the gain-kept axis lines up with the dollar axis and its ticks stay within -100%..100%", () => {
    const g = gain(100_000, "agrees");
    const rows = chartRows(defaultSweep().map((m) => row(m, m * 2_000_000, m * 2_500_000)));
    const domain = chartDollarDomain(rows);
    const axis = keptAxis(domain, g)!;
    expect(axis.domain[0]).toBeCloseTo(1 + domain[0] / 100_000);
    expect(axis.domain[1]).toBeCloseTo(1 + domain[1] / 100_000);
    expect(axis.domain[0]).toBeLessThan(-1); // a fall takes more than the year's gain
    expect(axis.ticks.length).toBeGreaterThan(1);
    for (const t of axis.ticks) {
      expect(t).toBeGreaterThanOrEqual(-1);
      expect(t).toBeLessThanOrEqual(1);
    }
    expect(keptAxis(domain, gain(100_000, "differs"))).toBeNull();
    expect(keptAxis(domain, gain(0, "agrees"))).toBeNull();
  });

  it("the share column: book gains, under a tenth, above 100% as it is", () => {
    const g = gain(400_000, "agrees");
    expect(givenBackCell(5_000, g)).toEqual({ kind: "book-gains" });
    expect(BOOK_GAINS_TEXT).toBe("none: the book gains");
    expect(givenBackCell(-100, g)).toEqual({ kind: "under-tenth" });
    expect(UNDER_TENTH_TEXT).toBe("under 0.1%");
    const big = givenBackCell(-600_000, g);
    expect(big.kind).toBe("pct");
    expect(big.kind === "pct" && big.percent).toBeCloseTo(150);
    expect(givenBackCell(-61_000, gain(400_000, "differs"))).toEqual({ kind: "hidden" });
    expect(givenBackCell(0, g)).toEqual({ kind: "pct", percent: -0 });
  });

  it("no plan wording on screen, and the new notes", () => {
    expect(DOWN_ONLY_NOTE).toBe(
      "This page shows a fall in the index. The split into losing and offsetting positions is worked out for a fall.",
    );
    expect(ZERO_ROW_NOTE).toBe("With no move, this is what time alone does to the options by that date.");
    expect(customMoveProblem(0.05)).not.toMatch(/step/i);
    expect(DOWN_ONLY_NOTE).not.toMatch(/step/i);
  });

  it("a server error reads once; a refused input names the control", () => {
    expect(requestFailureText(500, "Could not compute gains at risk.")).toBe(COMPUTE_FAILED_TEXT);
    expect(requestFailureText(502, "The server returned an error (HTTP 502).")).toBe("Could not compute gains at risk.");
    expect(requestFailureText(400, "valuationDate cannot be before today.")).toBe(
      "Could not compute gains at risk. The date cannot be before today.",
    );
  });

  it("one option in two accounts takes one price box", () => {
    const owners = priceBoxOwners([
      { accountId: 2, securityId: 9, priceSource: "model" },
      { accountId: 1, securityId: 9, priceSource: "model" },
      { accountId: 1, securityId: 7, priceSource: "own-price" },
      { accountId: 1, securityId: 8, priceSource: "override" },
    ]);
    expect([...owners].sort()).toEqual(["1:8", "2:9"]);
    expect(SAME_PRICE_TEXT).toBe("same price as above");
  });

  it("fresh server props answer the controls only when the controls are the defaults", () => {
    const server = { driverSymbol: "QQQ" as const, valuationDate: "2026-12-31", volChangePoints: 0 };
    const base = { ...server, custom: null, priceOverrides: {} };
    expect(serverPropsAnswerControls(base, server)).toBe(true);
    expect(serverPropsAnswerControls({ ...base, driverSymbol: "SPY" }, server)).toBe(false);
    expect(serverPropsAnswerControls({ ...base, valuationDate: "2027-01-15" }, server)).toBe(false);
    expect(serverPropsAnswerControls({ ...base, volChangePoints: 10 }, server)).toBe(false);
    expect(serverPropsAnswerControls({ ...base, custom: -0.07 }, server)).toBe(false);
    expect(serverPropsAnswerControls({ ...base, priceOverrides: { 9: 1.5 } }, server)).toBe(false);
  });

  it("the client's volatility bounds equal the repricer's", () => {
    expect(GAINS_AT_RISK_VOL_MIN).toBe(VOL_MOVE_MIN);
    expect(GAINS_AT_RISK_VOL_MAX).toBe(VOL_MOVE_MAX);
  });
});
