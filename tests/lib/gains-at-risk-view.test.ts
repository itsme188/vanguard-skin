import { describe, expect, it } from "vitest";
import {
  BETA_OVERRIDE_REFUSAL_LABELS,
  BETA_SOURCE_LABELS,
  CASE_KEYS,
  CASE_LABELS,
  CASE_NOTES,
  CHART_GAP_NOTE,
  DEFAULT_CASE,
  LEVERAGED_FIGURE_HINT,
  MEASURED_NOTE,
  NO_MEASURED_LINK_REASON_LABELS,
  SAME_FIGURE_TEXT,
  SELLOFF_NOTE,
  SELLOFF_RAISED_TEXT,
  betaEditorOwners,
  betaEvidenceCaption,
  betaOverrideProblem,
  betaSourceLine,
  chartLineLabels,
  formatBeta,
  isLeveragedFundRow,
  noMeasuredLinkSentence,
  overridesIgnoredLine,
  sortPositions,
  isGainsSortKey,
  positionSortNote,
  sameFigureText,
  betaEditorOwnership,
  DEFAULT_POSITION_SORT,
  GAINS_SORT_SCOPE,
  betaEditorNote,
  isPriceEditable,
  moneyCell,
  LEVERAGED_SELLOFF_TEXT,
  NO_VOLATILITY_PRICE_TEXT,
  COLUMN_LABELS,
  DEFAULT_DRIVER,
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
  nameTableRows,
  nameRowKey,
  nameTableEditorOwnership,
  sameFigureTextAt,
  serverPropsAction,
  TRIAL_ACCOUNT_NAME,
  type GainsControls,
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
import { BETA_OVERRIDE_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import type {
  GainsAtRiskCase,
  GainsAtRiskCaseKey,
  GainsAtRiskMoveRow,
  GainsAtRiskPosition,
  GainsAtRiskPositionCase,
  GainsAtRiskTrialRow,
} from "@/lib/compute/gains-at-risk";
import type { DailyBarEvidence, NoMeasuredLinkReason } from "@/lib/compute/security-regression";
import type { YearGainReconciliationStatus, YearGainResult } from "@/lib/compute/year-gain";
import type { PositionsFreshness } from "@/lib/queries/positions-freshness";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { gainsAtRiskAccountIds } from "@/lib/analysis/gains-at-risk-scope";

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

const posCase = (beta: number | null): GainsAtRiskPositionCase => ({ beta, pnlByMove: [], side: "flat", exposureUsd: 0 });
const cases = (measured: number | null, selloff: number | null): Record<GainsAtRiskCaseKey, GainsAtRiskPositionCase> => ({
  measured: posCase(measured),
  selloff: posCase(selloff),
});

/** A synthetic ZZ position; every field a test does not set is neutral. */
function pos(over: Partial<GainsAtRiskPosition> = {}): GainsAtRiskPosition {
  return {
    accountId: 1,
    accountName: "ZZ Account",
    securityId: 100,
    symbol: "ZZA",
    name: null,
    identitySecurityId: 100,
    betaSource: "measured",
    measuredBeta: 1,
    priceSource: "own-price",
    valueUsd: 1_000,
    cases: cases(1, 1),
    ...over,
  };
}

/** Two cases' move rows, for the chart helper. */
function twoCases(
  measured: GainsAtRiskMoveRow[],
  selloff: GainsAtRiskMoveRow[],
): Record<GainsAtRiskCaseKey, Pick<GainsAtRiskCase, "moves">> {
  return { measured: { moves: measured }, selloff: { moves: selloff } };
}

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

describe("gains at risk: disclosures, per case", () => {
  const d = (count: number, shareOfBook: number | null, unknownValueCount: number) => ({
    count,
    shareOfBook,
    unknownValueCount,
    symbols: count > 0 ? ["ZZA"] : [],
  });
  const reasons = (over: Partial<Record<NoMeasuredLinkReason, number>> = {}): Record<NoMeasuredLinkReason, number> => ({
    "foreign-session": 0,
    "driver-bars-missing": 0,
    "no-daily-bars": 0,
    "short-history": 0,
    "flat-driver": 0,
    "low-fit": 0,
    ...over,
  });
  const disclosures = (owner: number): GainsAtRiskCase["disclosures"] => ({
    notModelled: d(2, 0.03, 0),
    noMeasuredLink: { ...d(4, 0.18, 0), reasons: reasons({ "no-daily-bars": 3, "low-fit": 1 }) },
    ownerFigure: d(owner, owner > 0 ? 0.05 : 0, 0),
    pricedFromModel: d(1, 0.01, 0),
    expiresBeforeDate: d(0, 0, 0),
  });

  it("lines in a fixed order; no measured link replaces the old estimate line", () => {
    const lines = disclosureSentences(disclosures(0));
    expect(lines.map((l) => l.key)).toEqual(["notModelled", "noMeasuredLink", "pricedFromModel", "expiresBeforeDate"]);
    expect(lines[0]).toMatchObject({ count: 2, shareOfBook: 0.03, unknownValueCount: 0 });
    expect(lines[0].text).toBe("Not modelled");
    expect(lines[1].text).toBe("No measured link");
    for (const l of lines) expect(l.text).not.toMatch(/estimat/i);
  });

  it("names at the owner's figure get a line only when there are some", () => {
    const lines = disclosureSentences(disclosures(2));
    expect(lines.map((l) => l.key)).toEqual(["notModelled", "noMeasuredLink", "ownerFigure", "pricedFromModel", "expiresBeforeDate"]);
    expect(lines[2].text).toBe("At your figure");
  });

  it("an unknown value is never shown as a bare 0%", () => {
    expect(disclosureShare(d(2, null, 2))).toEqual({ kind: "not-known" });
    expect(disclosureShare(d(2, 0, 2))).toEqual({ kind: "omit" });
    expect(disclosureShare(d(2, 0.05, 1))).toEqual({ kind: "pct", value: 0.05 });
    expect(disclosureShare(d(0, 0, 0))).toEqual({ kind: "pct", value: 0 });
  });

  it("no measured link: what the case does with them, and each reason with its count", () => {
    const line = disclosures(0).noMeasuredLink;
    const m = noMeasuredLinkSentence(line, "measured");
    expect(m.treatment).toBe("held unchanged (options on them still lose or gain time value)");
    expect(m.reasons).toEqual([
      { key: "no-daily-bars", text: "no daily prices yet", count: 3 },
      { key: "low-fit", text: NO_MEASURED_LINK_REASON_LABELS["low-fit"], count: 1 },
    ]);
    const s = noMeasuredLinkSentence(line, "selloff");
    expect(s.treatment).toBe("stocks and funds taken one-for-one");
    expect(s.reasons).toEqual(m.reasons);
    expect(noMeasuredLinkSentence({ ...line, count: 0, reasons: reasons() }, "measured").reasons).toEqual([]);
  });
});

describe("gains at risk: the two cases", () => {
  it("the switch: two cases, Measured first and by default", () => {
    expect(CASE_KEYS).toEqual(["measured", "selloff"]);
    expect(DEFAULT_CASE).toBe("measured");
    expect(CASE_LABELS).toEqual({ measured: "Measured", selloff: "Selloff case" });
  });

  it("each case has one plain sentence; the selloff case says it is an assumption", () => {
    expect(SELLOFF_NOTE).toBe(
      "An assumption, not a measurement: every stock and fund falls at least one-for-one with the index.",
    );
    expect(MEASURED_NOTE).toBe(
      "Each name moves by its measured link to the index. A name with no measured link is held unchanged and listed below.",
    );
    expect(CASE_NOTES).toEqual({ measured: MEASURED_NOTE, selloff: SELLOFF_NOTE });
    expect(CHART_GAP_NOTE).toBe("The gap between the two lines is how much of the result rests on names falling together.");
  });

  it("the legend names each line plainly; the third line follows the selected case", () => {
    expect(chartLineLabels("measured")).toEqual({
      measured: "book, measured",
      selloff: "book, selloff case (an assumption)",
      without: "without the offsetting positions, measured",
    });
    expect(chartLineLabels("selloff").without).toBe("without the offsetting positions, selloff case");
  });
});

describe("gains at risk: the evidence caption", () => {
  it("says which closes and through what date, and how many names wait", () => {
    const none = betaEvidenceCaption({ driverBarsThrough: "2026-11-21", driverBarsMissing: false, namesWaitingForBars: 0 }, "QQQ");
    expect(none).toEqual({ text: "Betas are measured from daily closing prices through Nov 21.", waiting: null, notCaptured: null });
    const three = betaEvidenceCaption({ driverBarsThrough: "2026-11-21", driverBarsMissing: false, namesWaitingForBars: 3 }, "QQQ");
    expect(three.text).toBe(none.text);
    expect(three.waiting).toEqual({ count: 3, text: "names are waiting for daily prices." });
    const one = betaEvidenceCaption({ driverBarsThrough: "2026-11-21", driverBarsMissing: false, namesWaitingForBars: 1 }, "QQQ");
    expect(one.waiting).toEqual({ count: 1, text: "name is waiting for daily prices." });
  });

  it("the driver's own bars missing: no name is measured, the selloff case still applies", () => {
    const c = betaEvidenceCaption({ driverBarsThrough: null, driverBarsMissing: true, namesWaitingForBars: 4 }, "SPY");
    expect(c).toEqual({
      text: "Daily prices for SPY are not on file yet, so no name has a measured link. The selloff case still applies.",
      waiting: null,
      notCaptured: null,
    });
  });

  it("names the broker never sends daily prices for are told apart from names still waiting", () => {
    const base = { driverBarsThrough: "2026-11-21", driverBarsMissing: false, namesWaitingForBars: 2 };
    // Before the engine carries the field it is undefined: read as zero.
    expect(betaEvidenceCaption(base, "QQQ").notCaptured).toBeNull();
    expect(betaEvidenceCaption({ ...base, namesNotCaptured: 0 }, "QQQ").notCaptured).toBeNull();
    const two = betaEvidenceCaption({ ...base, namesNotCaptured: 2 }, "QQQ");
    expect(two.waiting).toEqual({ count: 2, text: "names are waiting for daily prices." });
    expect(two.notCaptured).toEqual({
      count: 2,
      text: "names have no daily prices from the broker (funds, or no contract on file). Type your own figure for them.",
    });
    expect(betaEvidenceCaption({ ...base, namesNotCaptured: 1 }, "QQQ").notCaptured).toEqual({
      count: 1,
      text: "name has no daily prices from the broker (a fund, or no contract on file). Type your own figure for it.",
    });
    expect(betaEvidenceCaption({ ...base, namesNotCaptured: Number.NaN }, "QQQ").notCaptured).toBeNull();
    // Still said when the index's own prices are missing.
    expect(betaEvidenceCaption({ ...base, driverBarsMissing: true, namesNotCaptured: 3 }, "QQQ").notCaptured?.count).toBe(3);
  });
});

describe("gains at risk: the owner's figure", () => {
  it("accepts a finite figure within the bounds; refuses anything else in plain words", () => {
    expect(betaOverrideProblem("6")).toBe("Your figure must be between -5 and 5.");
    expect(betaOverrideProblem("-5.01")).toBe("Your figure must be between -5 and 5.");
    expect(betaOverrideProblem("-0.4")).toBeNull();
    expect(betaOverrideProblem("5")).toBeNull();
    expect(betaOverrideProblem("-5")).toBeNull();
    expect(betaOverrideProblem("0")).toBeNull();
    expect(betaOverrideProblem("abc")).toMatch(/number/);
    expect(betaOverrideProblem("")).toMatch(/number/);
    expect(betaOverrideProblem("Infinity")).toMatch(/number/);
    expect(BETA_OVERRIDE_BOUNDS).toMatchObject({ min: -5, max: 5 });
  });

  it("one editor per name: the first row of each identity, never a row with no identity", () => {
    const owners = betaEditorOwners([
      { accountId: 2, securityId: 501, identitySecurityId: 100, betaSource: "measured" }, // an option on 100, shown first
      { accountId: 1, securityId: 100, identitySecurityId: 100, betaSource: "measured" },
      { accountId: 1, securityId: 200, identitySecurityId: 200, betaSource: "no-measured-link" },
      { accountId: 2, securityId: 200, identitySecurityId: 200, betaSource: "no-measured-link" },
      { accountId: 1, securityId: 777, identitySecurityId: null, betaSource: "measured" },
    ]);
    expect([...owners].sort()).toEqual(["1:200", "2:501"]);
    expect(SAME_FIGURE_TEXT).toBe("same figure as above");
  });

  it("no box on the index itself or a fixed row: a short note instead", () => {
    const owners = betaEditorOwners([
      { accountId: 1, securityId: 300, identitySecurityId: 300, betaSource: "driver" },
      { accountId: 1, securityId: 400, identitySecurityId: 400, betaSource: "fixed" },
      { accountId: 1, securityId: 500, identitySecurityId: 500, betaSource: "owner" },
    ]);
    expect([...owners]).toEqual(["1:500"]);
    expect(betaEditorNote(pos({ betaSource: "driver" }))).toBe("moves with the index by definition");
    expect(betaEditorNote(pos({ betaSource: "fixed" }))).toBe("held at a fixed link");
    expect(betaEditorNote(pos({ betaSource: "measured" }))).toBeNull();
    expect(betaEditorNote(pos({ betaSource: "owner" }))).toBeNull();
    // A not-modelled row is read by its reason first: it keeps its box.
    expect(betaEditorNote(pos({ betaSource: "not-modelled", unmodelledReason: "no-price" }))).toBeNull();
  });

  it("the engine's refusal of a figure, in plain words", () => {
    for (const k of ["fixed-row", "is-driver", "out-of-bounds"] as const) {
      expect(BETA_OVERRIDE_REFUSAL_LABELS[k]).toMatch(/\.$/);
    }
    expect(BETA_OVERRIDE_REFUSAL_LABELS["out-of-bounds"]).toMatch(/-5 and 5/);
  });

  it("figures not used are counted in one line (the count prints through <Count>)", () => {
    expect(overridesIgnoredLine(0)).toBeNull();
    expect(overridesIgnoredLine(1)).toEqual({ count: 1, text: "figure you typed was not used: no name on this page takes it." });
    expect(overridesIgnoredLine(3)).toEqual({ count: 3, text: "figures you typed were not used: no name on this page takes them." });
  });

  it("the hint for a leveraged or inverse fund", () => {
    expect(LEVERAGED_FIGURE_HINT).toBe("Type how the fund itself moves per 1% of the index, not its index's link.");
    expect(isLeveragedFundRow(pos({ betaSource: "leveraged" }))).toBe(true);
    expect(isLeveragedFundRow(pos({ betaSource: "owner", ladderRefusal: "leveraged-no-factor" }))).toBe(true);
    expect(isLeveragedFundRow(pos({ betaSource: "not-modelled", unmodelledReason: "tracked-index-not-measured" }))).toBe(true);
    expect(isLeveragedFundRow(pos({ betaSource: "not-modelled", unmodelledReason: "no-price" }))).toBe(false);
    expect(isLeveragedFundRow(pos({ betaSource: "measured" }))).toBe(false);
  });
});

describe("gains at risk: where each beta comes from", () => {
  const ev = (over: Partial<DailyBarEvidence> = {}): DailyBarEvidence => ({
    outcome: "measured",
    beta: 1.2,
    slopeTStat: 12,
    rSquared: 0.6,
    pairs: 480,
    securityBars: 500,
    driverBars: 500,
    droppedOutlierPairs: 0,
    droppedGapPairs: 0,
    firstDate: "2024-11-26",
    lastDate: "2026-11-21",
    ...over,
  });

  it("a not-modelled row says so first, whatever else it carries", () => {
    const p = pos({
      betaSource: "not-modelled",
      unmodelledReason: "no-option-price",
      noMeasuredLinkReason: "low-fit",
      evidence: ev({ outcome: "low-fit" }),
    });
    expect(betaSourceLine(p, "measured")).toEqual({ text: "not modelled", details: [NOT_MODELLED_LABELS["no-option-price"]] });
  });

  it("a measured row shows its daily pairs and the date its bars run to", () => {
    const p = pos({ betaSource: "measured", measuredBeta: 1.2, evidence: ev(), cases: cases(1.2, 1.2) });
    expect(betaSourceLine(p, "measured")).toEqual({
      text: "measured from daily closes",
      details: ["480 daily pairs through Nov 21"],
    });
    expect(betaSourceLine(p, "selloff")).toEqual(betaSourceLine(p, "measured"));
  });

  it("the selloff case says when it raised a measured beta to one-for-one", () => {
    const p = pos({ betaSource: "measured", measuredBeta: 0.4, evidence: ev({ beta: 0.4 }), cases: cases(0.4, 1) });
    expect(betaSourceLine(p, "measured").details).toEqual(["480 daily pairs through Nov 21"]);
    expect(betaSourceLine(p, "selloff").details).toEqual([
      "480 daily pairs through Nov 21",
      SELLOFF_RAISED_TEXT,
    ]);
  });

  it("no measured link: the reason, then what each case does", () => {
    const stock = pos({
      betaSource: "no-measured-link",
      measuredBeta: null,
      noMeasuredLinkReason: "short-history",
      evidence: ev({ outcome: "short-history", pairs: 20 }),
      cases: cases(0, 1),
    });
    expect(betaSourceLine(stock, "measured")).toEqual({
      text: `no measured link: ${NO_MEASURED_LINK_REASON_LABELS["short-history"]}`,
      details: ["Held unchanged."],
    });
    expect(betaSourceLine(stock, "selloff").details).toEqual(["Taken one-for-one."]);
    const option = { ...stock, expiry: "2027-01-15" };
    expect(betaSourceLine(option, "measured").details).toEqual([
      "The underlying is held unchanged; the option still loses or gains time value.",
    ]);
  });

  it("the owner's figure reads 'your figure' in both cases", () => {
    const p = pos({ betaSource: "owner", measuredBeta: 1.3, evidence: ev({ beta: 1.3 }), cases: cases(0.6, 0.6) });
    for (const k of ["measured", "selloff"] as const) {
      expect(betaSourceLine(p, k).text).toBe("your figure");
      expect(betaSourceLine(p, k).details).toEqual(["Measured 1.30 from 480 daily pairs through Nov 21."]);
    }
    const noLink = pos({ betaSource: "owner", measuredBeta: null, noMeasuredLinkReason: "no-daily-bars", cases: cases(0.6, 0.6) });
    expect(betaSourceLine(noLink, "measured").details).toEqual(["No measured link: no daily prices yet."]);
  });

  it("the owner's figure on a fund the app could not model", () => {
    const p = pos({ betaSource: "owner", measuredBeta: null, ladderRefusal: "leveraged-no-factor", cases: cases(-2, -2) });
    expect(betaSourceLine(p, "selloff")).toEqual({
      text: `Your figure. The app could not model this fund: ${NOT_MODELLED_LABELS["leveraged-no-factor"]}.`,
      details: [],
    });
  });

  it("the driver, fixed and leveraged rows", () => {
    expect(betaSourceLine(pos({ betaSource: "driver", measuredBeta: 1, cases: cases(1, 1) }), "measured").text).toBe("the index itself");
    expect(betaSourceLine(pos({ betaSource: "fixed", measuredBeta: 0, cases: cases(0, 0) }), "selloff")).toEqual({
      text: "set by type (cash or bonds)",
      details: [],
    });
    const lev = pos({ betaSource: "leveraged", measuredBeta: 1.8, cases: cases(1.8, 2) });
    expect(betaSourceLine(lev, "measured")).toEqual({ text: "leverage times its tracked index", details: [] });
    // A leveraged or inverse fund: its INDEX is floored, not the fund itself.
    expect(betaSourceLine(lev, "selloff").details).toEqual([LEVERAGED_SELLOFF_TEXT]);
    expect(LEVERAGED_SELLOFF_TEXT).toBe("Its index is taken at least one-for-one.");
    const inverse = pos({ betaSource: "leveraged", measuredBeta: -0.9, cases: cases(-0.9, -1) });
    expect(betaSourceLine(inverse, "selloff").details).toEqual([LEVERAGED_SELLOFF_TEXT]);
    expect(betaSourceLine(inverse, "selloff").details).not.toContain(SELLOFF_RAISED_TEXT);
  });

  it("a beta prints to two places; none prints a dash", () => {
    expect(formatBeta(1.234)).toBe("1.23");
    expect(formatBeta(-0.4)).toBe("-0.40");
    expect(formatBeta(null)).toBe("—");
  });
});

describe("gains at risk: plain-words labels cover every reason", () => {
  it("not modelled", () => {
    for (const k of [
      "leveraged-no-factor",
      "leveraged-no-tracked-index",
      "tracked-index-not-measured",
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
    expect(Object.keys(NOT_MODELLED_LABELS)).toHaveLength(10);
  });

  it("every beta source and every reason for no measured link", () => {
    expect(BETA_SOURCE_LABELS).toEqual({
      driver: "the index itself",
      fixed: "set by type (cash or bonds)",
      leveraged: "leverage times its tracked index",
      measured: "measured from daily closes",
      owner: "your figure",
      "no-measured-link": "no measured link",
      "not-modelled": "not modelled",
    });
    expect(NO_MEASURED_LINK_REASON_LABELS).toEqual({
      "no-daily-bars": "no daily prices yet",
      "short-history": "too few days of daily prices",
      "low-fit": "its link to the index cannot be told apart from zero",
      "foreign-session": "not traded on the US session",
      "driver-bars-missing": "the index's own daily prices are missing",
      "flat-driver": "the index did not move",
    });
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
    expect(domainProblemText("betaOverrides can hold at most 200 entries.")).toBe("At most 200 of your figures can be sent at once.");
    expect(domainProblemText("betaOverrides values must each be a number between -5 and 5.")).toBe(
      "Your figures must each be a number between -5 and 5.",
    );
    expect(domainProblemText("betaOverrides keys must be security ids (positive whole numbers).")).toBe(
      "A figure you typed is not tied to a name on this page.",
    );
    expect(domainProblemText("betaOverrides must be an object of security id to figure.")).toBe("Your figures could not be read.");
  });
});

describe("gains at risk: fix round 1", () => {
  const row = (move: number, book: number, losers: number) => ({ move, bookPnlUsd: book, losersPnlUsd: losers, offsetsPnlUsd: book - losers });

  it("the chart plots only the sweep, in move order, both book lines and the selected case's second line", () => {
    const measured = requestMoves(defaultSweep(), -0.07).map((m) => row(m, m * 1_000_000, m * 1_200_000));
    const selloff = requestMoves(defaultSweep(), -0.07).map((m) => row(m, m * 1_500_000, m * 1_800_000));
    expect(measured.some((r) => sameMove(r.move, -0.07))).toBe(true);
    const rows = chartRows(twoCases([...measured].reverse(), selloff), "measured");
    expect(rows.map((r) => r.move)).toEqual(defaultSweep());
    expect(rows.some((r) => sameMove(r.move, -0.07))).toBe(false);
    const ten = rows.find((r) => sameMove(r.move, -0.1))!;
    expect(ten.measured).toBeCloseTo(-100_000);
    expect(ten.selloff).toBeCloseTo(-150_000);
    expect(ten.without).toBeCloseTo(-120_000); // the measured case's positions that lose
    const tenSelloff = chartRows(twoCases(measured, selloff), "selloff").find((r) => sameMove(r.move, -0.1))!;
    expect(tenSelloff.without).toBeCloseTo(-180_000);
    expect(tenSelloff.measured).toBeCloseTo(-100_000);
    const domain = chartDollarDomain(rows);
    expect(domain[0]).toBeLessThan(-300_000); // the selloff line is inside the axis too
  });

  it("the gain-kept axis lines up with the dollar axis and its ticks stay within -100%..100%", () => {
    const g = gain(100_000, "agrees");
    const sweepRows = defaultSweep().map((m) => row(m, m * 2_000_000, m * 2_500_000));
    const rows = chartRows(twoCases(sweepRows, sweepRows), "measured");
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

  it("an unpriced option with no volatility takes a price box, one per security", () => {
    const noVol = { priceSource: null, unmodelledReason: "no-volatility" as const, expiry: "2027-01-15" };
    const owners = priceBoxOwners([
      { accountId: 2, securityId: 11, ...noVol },
      { accountId: 1, securityId: 11, ...noVol },
      // Not modelled for another reason, or not an option: no box.
      { accountId: 1, securityId: 12, priceSource: null, unmodelledReason: "no-option-terms", expiry: "2027-01-15" },
      { accountId: 1, securityId: 13, priceSource: null, unmodelledReason: "no-volatility" },
      { accountId: 1, securityId: 14, priceSource: "own-price", unmodelledReason: "no-volatility", expiry: "2027-01-15" },
    ]);
    expect([...owners]).toEqual(["2:11"]);
    expect(isPriceEditable({ priceSource: null, unmodelledReason: "no-volatility", expiry: "2027-01-15" })).toBe(true);
    expect(isPriceEditable({ priceSource: "model" })).toBe(true);
    expect(isPriceEditable({ priceSource: "override", unmodelledReason: "no-volatility", expiry: "2027-01-15" })).toBe(true);
    expect(isPriceEditable({ priceSource: null, unmodelledReason: "no-price" })).toBe(false);
    expect(NO_VOLATILITY_PRICE_TEXT).toBe("No volatility on file. Type its price to include it.");
  });

  it("a money cell never prints a negative zero", () => {
    expect(Object.is(moneyCell(-0.004, false), 0)).toBe(true);
    expect(Object.is(moneyCell(-0, false), 0)).toBe(true);
    expect(Object.is(moneyCell(0.0049, false), 0)).toBe(true);
    expect(moneyCell(-0.005, false)).toBe(-0.005);
    expect(moneyCell(-12.5, false)).toBe(-12.5);
    expect(moneyCell(-12.5, true)).toBeNull();
    expect(moneyCell(undefined, false)).toBeNull();
    expect(moneyCell(null, false)).toBeNull();
    expect(moneyCell(Number.NaN, false)).toBeNull();
  });

  it("fresh server props answer the controls only when the controls are the defaults", () => {
    const server = { driverSymbol: "QQQ" as const, valuationDate: "2026-12-31", volChangePoints: 0 };
    const base = { ...server, custom: null, priceOverrides: {}, betaOverrides: {} };
    expect(serverPropsAnswerControls(base, server)).toBe(true);
    expect(serverPropsAnswerControls({ ...base, driverSymbol: "SPY" }, server)).toBe(false);
    expect(serverPropsAnswerControls({ ...base, valuationDate: "2027-01-15" }, server)).toBe(false);
    expect(serverPropsAnswerControls({ ...base, volChangePoints: 10 }, server)).toBe(false);
    expect(serverPropsAnswerControls({ ...base, custom: -0.07 }, server)).toBe(false);
    expect(serverPropsAnswerControls({ ...base, priceOverrides: { 9: 1.5 } }, server)).toBe(false);
    expect(serverPropsAnswerControls({ ...base, betaOverrides: { 9: 0.8 } }, server)).toBe(false);
  });

  it("the client's volatility bounds equal the repricer's", () => {
    expect(GAINS_AT_RISK_VOL_MIN).toBe(VOL_MOVE_MIN);
    expect(GAINS_AT_RISK_VOL_MAX).toBe(VOL_MOVE_MAX);
  });
});

describe("gains at risk: one scope rule for the route and the section", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  // The migrations seed three accounts; replace them with synthetic ones.
  db.prepare("DELETE FROM accounts").run();
  for (const name of ["ZZ Vanguard Brokerage", "ZZ Vanguard Roth IRA", "ZZ IBKR"]) {
    db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name);
  }
  const id = (name: string) => (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;

  it("all is every account; a word reads only what it names; a word naming nothing reads nothing", () => {
    expect(gainsAtRiskAccountIds(db, "all")).toBeUndefined();
    expect(gainsAtRiskAccountIds(db, "vanguard")).toEqual([id("ZZ Vanguard Brokerage")]);
    expect(gainsAtRiskAccountIds(db, "roth")).toEqual([id("ZZ Vanguard Roth IRA")]);
    expect(gainsAtRiskAccountIds(db, "ibkr")).toEqual([id("ZZ IBKR")]);
    const empty = new Database(":memory:");
    runMigrations(empty);
    empty.prepare("DELETE FROM accounts").run();
    expect(gainsAtRiskAccountIds(empty, "ibkr")).toEqual([]);
  });
});

describe("gains at risk: sorting what moves the result", () => {
  // pnlByMove: [at move 0, at move 1]; the selected case is the one passed.
  const row = (
    symbol: string,
    accountName: string,
    measuredPnl: [number, number],
    over: Partial<GainsAtRiskPosition> = {},
    selloffPnl: [number, number] = measuredPnl,
  ): GainsAtRiskPosition =>
    pos({
      symbol,
      accountName,
      securityId: symbol.charCodeAt(2) * 10 + accountName.length,
      identitySecurityId: symbol.charCodeAt(2) * 10,
      cases: {
        measured: { beta: 1, pnlByMove: measuredPnl, side: "loses", exposureUsd: 1 },
        selloff: { beta: 1.5, pnlByMove: selloffPnl, side: "loses", exposureUsd: 1 },
      },
      ...over,
    });
  const syms = (rows: GainsAtRiskPosition[]) => rows.map((r) => `${r.symbol}/${r.accountName}`);

  const book = [
    row("ZZB", "ZZ One", [0, -500]),
    row("ZZA", "ZZ One", [0, 300]),
    row("ZZC", "ZZ One", [0, -2_000]),
    row("ZZD", "ZZ One", [0, 0], { betaSource: "not-modelled", unmodelledReason: "no-option-price", valueUsd: null, measuredBeta: null }),
    row("ZZE", "ZZ One", [0, 900]),
  ];

  it("the default: largest loss first, so the biggest losers lead", () => {
    expect(DEFAULT_POSITION_SORT).toEqual({ field: "loss", dir: "desc" });
    expect(GAINS_SORT_SCOPE).toBe("garNames");
    expect(syms(sortPositions(book, "loss", "desc", "measured", 1))).toEqual([
      "ZZC/ZZ One",
      "ZZB/ZZ One",
      "ZZA/ZZ One",
      "ZZE/ZZ One",
      "ZZD/ZZ One",
    ]);
    expect(positionSortNote("loss", "desc")).toBe("Largest loss first.");
  });

  it("flipped: largest gain first, so the biggest offsets lead; a row with no figure stays last", () => {
    expect(syms(sortPositions(book, "loss", "asc", "measured", 1))).toEqual([
      "ZZE/ZZ One",
      "ZZA/ZZ One",
      "ZZB/ZZ One",
      "ZZC/ZZ One",
      "ZZD/ZZ One",
    ]);
    expect(positionSortNote("loss", "asc")).toBe("Largest gain first.");
    expect(positionSortNote("symbol", "asc")).toBeNull();
  });

  it("sorts by the selected case and the selected move", () => {
    const two = [row("ZZA", "ZZ One", [-10, -100], {}, [-10, -900]), row("ZZB", "ZZ One", [-50, -500], {}, [-50, -600])];
    expect(syms(sortPositions(two, "loss", "desc", "measured", 1))).toEqual(["ZZB/ZZ One", "ZZA/ZZ One"]);
    expect(syms(sortPositions(two, "loss", "desc", "selloff", 1))).toEqual(["ZZA/ZZ One", "ZZB/ZZ One"]);
    expect(syms(sortPositions(two, "loss", "desc", "measured", 0))).toEqual(["ZZB/ZZ One", "ZZA/ZZ One"]);
    // No selected move: no row has a figure, so the order is the tie-break.
    expect(syms(sortPositions(two, "loss", "desc", "measured", -1))).toEqual(["ZZA/ZZ One", "ZZB/ZZ One"]);
  });

  it("the beta column: nulls last both ways", () => {
    const rows = [
      row("ZZA", "ZZ One", [0, 0], { cases: cases(0.5, 1) }),
      row("ZZB", "ZZ One", [0, 0], { cases: cases(null, null), unmodelledReason: "no-price", betaSource: "not-modelled" }),
      row("ZZC", "ZZ One", [0, 0], { cases: cases(1.8, 1.8) }),
      row("ZZD", "ZZ One", [0, 0], { cases: cases(-0.3, 1) }),
    ];
    expect(syms(sortPositions(rows, "beta", "desc", "measured", 1))).toEqual(["ZZC/ZZ One", "ZZA/ZZ One", "ZZD/ZZ One", "ZZB/ZZ One"]);
    expect(syms(sortPositions(rows, "beta", "asc", "measured", 1))).toEqual(["ZZD/ZZ One", "ZZA/ZZ One", "ZZC/ZZ One", "ZZB/ZZ One"]);
    // The selloff case's betas: ZZA, ZZC and ZZD... ties broken by symbol.
    expect(syms(sortPositions(rows, "beta", "desc", "selloff", 1))).toEqual(["ZZC/ZZ One", "ZZA/ZZ One", "ZZD/ZZ One", "ZZB/ZZ One"]);
  });

  it("value, symbol and account; value unknown sorts last both ways", () => {
    const rows = [
      row("ZZB", "ZZ Two", [0, 0], { valueUsd: 5_000 }),
      row("ZZA", "ZZ One", [0, 0], { valueUsd: null }),
      row("ZZC", "ZZ One", [0, 0], { valueUsd: -1_000 }),
    ];
    expect(syms(sortPositions(rows, "value", "desc", "measured", 1))).toEqual(["ZZB/ZZ Two", "ZZC/ZZ One", "ZZA/ZZ One"]);
    expect(syms(sortPositions(rows, "value", "asc", "measured", 1))).toEqual(["ZZC/ZZ One", "ZZB/ZZ Two", "ZZA/ZZ One"]);
    expect(syms(sortPositions(rows, "symbol", "asc", "measured", 1))).toEqual(["ZZA/ZZ One", "ZZB/ZZ Two", "ZZC/ZZ One"]);
    expect(syms(sortPositions(rows, "symbol", "desc", "measured", 1))).toEqual(["ZZC/ZZ One", "ZZB/ZZ Two", "ZZA/ZZ One"]);
    expect(syms(sortPositions(rows, "account", "asc", "measured", 1))).toEqual(["ZZA/ZZ One", "ZZC/ZZ One", "ZZB/ZZ Two"]);
  });

  it("stable: ties break by symbol, then account, whatever the input order", () => {
    const tied = [row("ZZB", "ZZ Two", [0, -100]), row("ZZA", "ZZ Two", [0, -100]), row("ZZB", "ZZ One", [0, -100])];
    const want = ["ZZA/ZZ Two", "ZZB/ZZ One", "ZZB/ZZ Two"];
    expect(syms(sortPositions(tied, "loss", "desc", "measured", 1))).toEqual(want);
    expect(syms(sortPositions([...tied].reverse(), "loss", "asc", "measured", 1))).toEqual(want);
    // The input is not changed.
    expect(syms(tied)).toEqual(["ZZB/ZZ Two", "ZZA/ZZ Two", "ZZB/ZZ One"]);
  });

  it("an unknown key from the URL falls back to the default order", () => {
    expect(isGainsSortKey("loss")).toBe(true);
    expect(isGainsSortKey("beta")).toBe(true);
    expect(isGainsSortKey("pnl")).toBe(false);
    expect(isGainsSortKey(null)).toBe(false);
  });

  it("one box per name follows the sorted order: the first row of the name owns it, the others point back up", () => {
    // ZZA's stock (identity 100) and an option on it (also identity 100), in another account.
    const stock = pos({ symbol: "ZZA", accountId: 1, securityId: 100, identitySecurityId: 100, cases: { measured: { beta: 1, pnlByMove: [0, -100], side: "loses", exposureUsd: 1 }, selloff: posCase(1) } });
    const option = pos({ symbol: "ZZA 270115C00050000", accountId: 2, securityId: 501, identitySecurityId: 100, expiry: "2027-01-15", priceSource: "model", cases: { measured: { beta: 1, pnlByMove: [0, -900], side: "loses", exposureUsd: 1 }, selloff: posCase(1) } });
    const other = pos({ symbol: "ZZB", accountId: 1, securityId: 200, identitySecurityId: 200, cases: { measured: { beta: 1, pnlByMove: [0, -500], side: "loses", exposureUsd: 1 }, selloff: posCase(1) } });
    const lossFirst = sortPositions([stock, option, other], "loss", "desc", "measured", 1);
    expect(lossFirst.map((r) => r.symbol)).toEqual(["ZZA 270115C00050000", "ZZB", "ZZA"]);
    const own = betaEditorOwnership(lossFirst);
    expect(own.get("2:501")).toEqual({ owner: true });
    expect(own.get("1:200")).toEqual({ owner: true });
    // Not adjacent: the stock row names the row that holds the box, which is above it.
    expect(own.get("1:100")).toEqual({ owner: false, ownerSymbol: "ZZA 270115C00050000" });
    const gainFirst = sortPositions([stock, option, other], "loss", "asc", "measured", 1);
    const own2 = betaEditorOwnership(gainFirst);
    expect(own2.get("1:100")).toEqual({ owner: true });
    expect(own2.get("2:501")).toEqual({ owner: false, ownerSymbol: "ZZA" });
    // The owner always comes first in the order it was given.
    for (const order of [lossFirst, gainFirst]) {
      const ownership = betaEditorOwnership(order);
      order.forEach((r, i) => {
        const o = ownership.get(`${r.accountId}:${r.securityId}`);
        if (o && !o.owner) {
          const at = order.findIndex((x) => x.symbol === o.ownerSymbol && x.identitySecurityId === r.identitySecurityId);
          expect(at).toBeLessThan(i);
        }
      });
    }
    expect(betaEditorOwners(lossFirst)).toEqual(new Set(["2:501", "1:200"]));
  });

  it("the pointer back up names the row when it is another symbol", () => {
    expect(sameFigureText("ZZA", "ZZA")).toBe("same figure as above");
    expect(sameFigureText("ZZA 270115C00050000", "ZZA")).toBe("same figure as ZZA 270115C00050000, above");
  });
});

describe("gains at risk: trial positions in the view's rules", () => {
  const trialRow = (over: Partial<GainsAtRiskTrialRow> = {}): GainsAtRiskTrialRow => ({
    id: "t1",
    kind: "option",
    identitySecurityId: 900,
    symbol: "ZZQ",
    name: null,
    betaSource: "measured",
    measuredBeta: 1.1,
    noLinkWarning: false,
    valuation: { price: 500, date: "2026-11-23", source: "daily-bar" },
    valueUsd: 6_400,
    cost: { kind: "premium-paid", usd: 6_400 },
    holdingsNowByAccount: {},
    leavesShortBy: null,
    cases: {
      measured: { beta: 1.1, pnlByMove: [0, 4_000], side: "offsets", exposureUsd: -10 },
      selloff: { beta: 1.1, pnlByMove: [0, 5_000], side: "offsets", exposureUsd: -10 },
    },
    ...over,
  });
  const bookRow = (symbol: string, pnl: number, over: Partial<GainsAtRiskPosition> = {}) =>
    pos({
      symbol,
      securityId: symbol.charCodeAt(2),
      identitySecurityId: symbol.charCodeAt(2),
      cases: {
        measured: { beta: 1, pnlByMove: [0, pnl], side: "loses", exposureUsd: 1 },
        selloff: { beta: 1, pnlByMove: [0, pnl], side: "loses", exposureUsd: 1 },
      },
      ...over,
    });

  it("nameTableRows: book rows, then each trial row marked trial, with its label", () => {
    const book = [bookRow("ZZA", -500), bookRow("ZZB", -2_000)];
    const rows = nameTableRows(
      { positions: book, trial: { rows: [trialRow(), trialRow({ id: "t2", kind: "shares", identitySecurityId: 65, symbol: "ZZA" })] } },
      new Map([["t1", { symbol: "ZZQ 2027-03-20 500 put", expiry: "2027-03-20" }]]),
    );
    expect(rows.map((r) => r.symbol)).toEqual(["ZZA", "ZZB", "ZZQ 2027-03-20 500 put", "ZZA"]);
    expect(rows.slice(0, 2).every((r) => r.trialId === undefined)).toBe(true);
    expect(rows[2]).toMatchObject({ accountName: TRIAL_ACCOUNT_NAME, trialId: "t1", expiry: "2027-03-20", priceSource: null, valueUsd: 6_400 });
    expect(rows[3]).toMatchObject({ accountName: "trial", trialId: "t2", identitySecurityId: 65 });
    // The price box never opens on a trial row: its price is fixed at the click.
    expect(rows.slice(2).some((r) => isPriceEditable(r))).toBe(false);
    expect(nameRowKey(rows[0])).toBe("1:65");
    expect(nameRowKey(rows[2])).toBe("trial:t1");
    // With no trial positions, exactly the book.
    expect(nameTableRows({ positions: book })).toEqual(book);
  });

  it("sortPositions sorts trial rows with the book under every key", () => {
    const rows = nameTableRows({
      positions: [bookRow("ZZA", -500), bookRow("ZZB", -2_000, { valueUsd: 9_000 })],
      trial: {
        rows: [
          trialRow(),
          trialRow({ id: "t9", symbol: "ZZC", identitySecurityId: 67, refusal: "expired", cost: null, valueUsd: null, betaSource: "not-modelled" }),
        ],
      },
    });
    const order = (k: Parameters<typeof sortPositions>[1], d: "asc" | "desc") =>
      sortPositions(rows, k, d, "measured", 1).map((r) => `${r.symbol}${r.trialId ? "*" : ""}`);
    expect(order("loss", "desc")).toEqual(["ZZB", "ZZA", "ZZQ*", "ZZC*"]);
    expect(order("loss", "asc")).toEqual(["ZZQ*", "ZZA", "ZZB", "ZZC*"]);
    expect(order("value", "desc")).toEqual(["ZZB", "ZZQ*", "ZZA", "ZZC*"]);
    expect(order("beta", "desc")).toEqual(["ZZQ*", "ZZA", "ZZB", "ZZC*"]);
    expect(order("symbol", "asc")).toEqual(["ZZA", "ZZB", "ZZC*", "ZZQ*"]);
    // "trial" is the account name of every trial row, so they sort together by account.
    expect(order("account", "asc").slice(0, 2).every((x) => x.endsWith("*"))).toBe(true);
  });

  it("a trial row owns the figure box only for a name no book row has", () => {
    const rows = nameTableRows({
      positions: [bookRow("ZZA", -500)],
      trial: {
        rows: [
          trialRow({ id: "t1", identitySecurityId: 65, symbol: "ZZA", cases: { measured: { beta: 1, pnlByMove: [0, -9_000], side: "loses", exposureUsd: 1 }, selloff: posCase(1) } }),
          trialRow({ id: "t2", identitySecurityId: 900, symbol: "ZZQ" }),
          trialRow({ id: "t3", identitySecurityId: 901, symbol: "ZZR", refusal: "expired", cost: null }),
          trialRow({ id: "t4", identitySecurityId: 902, symbol: "ZZS", refusal: "not-modelled", ladderRefusal: "leveraged-no-factor", cost: null, betaSource: "not-modelled" }),
        ],
      },
    });
    // The trial on ZZA sorts first (largest loss) but the book row keeps the box; the pointer says where it is.
    const sorted = sortPositions(rows, "loss", "desc", "measured", 1);
    expect(sorted[0].trialId).toBe("t1");
    const own = nameTableEditorOwnership(sorted);
    expect(own.get("1:65")).toEqual({ owner: true });
    expect(own.get("trial:t1")).toEqual({ owner: false, ownerSymbol: "ZZA", where: "below" });
    expect(own.get("trial:t2")).toEqual({ owner: true });
    // A refused trial takes no box, except one the app cannot model: the owner's figure can price it.
    expect(own.has("trial:t3")).toBe(false);
    expect(own.get("trial:t4")).toEqual({ owner: true });
    expect(sameFigureTextAt("ZZA", "ZZA", "below")).toBe("same figure as below");
    expect(sameFigureTextAt("ZZA", "ZZA 2027-03-20 500 put", "below")).toBe("same figure as ZZA, below");
  });

  it("with the book only, the ownership is step 1's", () => {
    const stock = pos({ symbol: "ZZA", accountId: 1, securityId: 100, identitySecurityId: 100 });
    const option = pos({ symbol: "ZZA 270115C00050000", accountId: 2, securityId: 501, identitySecurityId: 100, expiry: "2027-01-15" });
    const other = pos({ symbol: "ZZB", accountId: 1, securityId: 200, identitySecurityId: 200, betaSource: "fixed" });
    for (const order of [[stock, option, other], [option, other, stock]]) {
      const step1 = betaEditorOwnership(order);
      const now = nameTableEditorOwnership(order);
      expect([...now.keys()].sort()).toEqual([...step1.keys()].sort());
      for (const [k, v] of step1) {
        expect(now.get(k)).toEqual(v.owner ? v : { ...v, where: "above" });
      }
    }
  });

  it("a reply for an older set of trial positions is dropped", () => {
    let s = gainsRequestReducer(init(A), { type: "start", seq: 1, trialVersion: 1 });
    expect(s.trialVersion).toBe(1);
    // The same seq answering an older trial set (a defensive second check).
    expect(gainsRequestReducer(s, { type: "success", seq: 1, data: B, trialVersion: 0 })).toBe(s);
    s = gainsRequestReducer(s, { type: "start", seq: 2, trialVersion: 2 });
    expect(gainsRequestReducer(s, { type: "success", seq: 1, data: B, trialVersion: 1 })).toBe(s);
    expect(gainsRequestReducer(s, { type: "success", seq: 2, data: C, trialVersion: 2 }).result).toBe(C);
  });

  it("server props never stand as the answer while trial positions exist: the view asks again", () => {
    const s = gainsRequestReducer(init(A), { type: "start", seq: 1, trialVersion: 1 });
    expect(gainsRequestReducer(s, { type: "reset", data: D, hasTrials: true })).toBe(s);
    const defaults: GainsControls = {
      driverSymbol: "QQQ",
      valuationDate: "2026-12-31",
      volChangePoints: 0,
      custom: null,
      priceOverrides: {},
      betaOverrides: {},
    };
    const server = { driverSymbol: "QQQ" as const, valuationDate: "2026-12-31", volChangePoints: 0 };
    expect(serverPropsAction(defaults, server, false)).toBe("reset");
    expect(serverPropsAction(defaults, server, true)).toBe("ask");
    expect(serverPropsAction({ ...defaults, volChangePoints: 5 }, server, false)).toBe("ask");
  });

  it("P7: a view that opens with trial positions starts pending, with the first paint kept for layout only", () => {
    const s = initialGainsRequestState(A, { hasTrials: true });
    expect(s.result).toBeNull();
    expect(s.previous).toBe(A);
    expect(s.loading).toBe(true);
    expect(s.error).toBeNull();
    expect(initialGainsRequestState(A)).toEqual({ latestSeq: 0, result: A, previous: A, error: null, loading: false, trialVersion: 0 });
    expect(initialGainsRequestState(A, { hasTrials: false }).result).toBe(A);
  });
});

describe("gains at risk: a refused trial list in the page's words", () => {
  it("names the trial positions, not a request field, and says what to do", () => {
    expect(domainProblemText("trialPositions[0].strike must be a number above 0 and at most 100000.")).toBe(
      "A trial position could not be read. Remove it and add it again.",
    );
    expect(domainProblemText("trialPositions can hold at most 12 positions.")).toBe("At most 12 trial positions can be sent at once.");
    expect(requestFailureText(400, "trialPositions must be a list.")).toBe(
      "Could not compute gains at risk. A trial position could not be read. Remove it and add it again.",
    );
  });
});
