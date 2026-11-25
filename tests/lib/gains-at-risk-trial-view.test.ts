import { describe, expect, it } from "vitest";
import {
  TRIAL_CHART_NOTE,
  TRIAL_EXPIRED_NOTE,
  TRIAL_MULTIPLIER_NOTE,
  TRIAL_NOT_STORED_NOTE,
  TRIAL_ZERO_START_NOTE,
  addBlockedBy,
  applyTrialEdit,
  barsStep,
  chainFieldState,
  lookupBarsLine,
  trialChartLineLabels,
  trialCostShareCell,
  crossingSentence,
  draftFromTrial,
  emptyTrialDraft,
  emptyTrialList,
  holdingsChanged,
  holdingsChangedNote,
  initialTrialFormState,
  isCurrentTrialReply,
  leavesShortNote,
  netCashLine,
  noLinkWarningNote,
  noMoveCostSentence,
  quoteLabel,
  quoteText,
  shortByNameLines,
  staleCloseNote,
  trialChartDollarDomain,
  trialChartRows,
  trialContractKey,
  trialCostLine,
  trialCostShareOfGain,
  trialEntryRequest,
  trialFormProblem,
  trialFormReducer,
  trialListReducer,
  trialPositionLabel,
  trialPriceSource,
  trialRefusalNote,
  trialRequestPositions,
  trialStateFromEntry,
  underlyingPriceNote,
  type TrialDraft,
  type TrialFormState,
  type TrialPositionState,
  type TrialQuote,
} from "@/lib/analysis/gains-at-risk-trial-view";
import { TRIAL_POSITION_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import type { TrialEntryResponse, TrialLookup } from "@/lib/analysis/gains-at-risk-input";
import type {
  GainsAtRiskCaseKey,
  GainsAtRiskMoveRow,
  GainsAtRiskTrialCase,
  GainsAtRiskTrialResult,
  GainsAtRiskTrialRow,
  TrialPositionInput,
} from "@/lib/compute/gains-at-risk";
import type { YearGainReconciliationStatus, YearGainResult } from "@/lib/compute/year-gain";

// Every figure here is made up; every symbol is a synthetic ZZ name.

const TODAY = "2026-11-24";

function gain(gainUsd: number | null, status: YearGainReconciliationStatus = "agrees"): YearGainResult {
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
    reconciliation: { status, throughMonth: null, differenceUsd: status === "differs" ? 1 : null },
  };
}

const flat = () => ({ beta: 1, pnlByMove: [0, 0], side: "flat" as const, exposureUsd: 0 });

function row(over: Partial<GainsAtRiskTrialRow> = {}): GainsAtRiskTrialRow {
  return {
    id: "t1",
    kind: "option",
    identitySecurityId: 10,
    symbol: "ZZQ",
    name: null,
    betaSource: "measured",
    measuredBeta: 1,
    noLinkWarning: false,
    valuation: { price: 500, date: "2026-11-23", source: "book" },
    valueUsd: 6_400,
    cost: { kind: "premium-paid", usd: 6_400 },
    holdingsNowByAccount: {},
    leavesShortBy: null,
    cases: { measured: flat(), selloff: flat() },
    ...over,
  };
}

const optionPosition: TrialPositionInput = {
  kind: "option",
  id: "t1",
  underlyingSecurityId: 10,
  right: "put",
  side: "buy",
  expiry: "2027-03-20",
  strike: 500,
  contracts: 10,
  pricePaid: 6.4,
  entryUnderlyingPrice: 505,
  valuationPriceAtEntry: 505,
  entryVolatility: 0.22,
};

const quote: TrialQuote = {
  tickKind: "live",
  session: "regular-session",
  bid: 6.3,
  ask: 6.5,
  mid: 6.4,
  underlyingLast: null,
  fetchedAt: "2026-11-24T19:32:00.000Z",
};

function optionState(over: Partial<TrialPositionState> = {}): TrialPositionState {
  return {
    position: optionPosition,
    symbol: "ZZQ",
    name: null,
    holdingsAtAddByAccount: {},
    priceSource: "typed",
    staleCloseDate: null,
    underlyingPrice: 505,
    underlyingPriceDate: "2026-11-23",
    underlyingPriceSource: "book",
    appValuation: { price: 505, date: "2026-11-23", source: "book" },
    ...over,
  };
}

function sharesState(over: Partial<TrialPositionState> = {}): TrialPositionState {
  return {
    position: { kind: "shares", id: "s1", securityId: 20, side: "sell", quantity: 200, price: 310 },
    symbol: "ZZA",
    name: null,
    holdingsAtAddByAccount: { 1: 100 },
    priceSource: "typed",
    staleCloseDate: null,
    underlyingPrice: 310,
    underlyingPriceDate: "2026-11-23",
    underlyingPriceSource: "book",
    appValuation: { price: 310, date: "2026-11-23", source: "book" },
    ...over,
  };
}

function optionDraft(over: Partial<TrialDraft> = {}): TrialDraft {
  return {
    ...emptyTrialDraft(),
    kind: "option",
    symbol: "ZZQ",
    right: "put",
    side: "buy",
    expiry: "2027-03-20",
    strike: "500",
    count: "10",
    price: "6.4",
    ...over,
  };
}

const moveRow = (move: number, trialPnlUsd: number, book: number): GainsAtRiskTrialCase["moves"][number] => ({
  move,
  trialPnlUsd,
  bookWithTrialPnlUsd: book + trialPnlUsd,
});

function trialCase(over: Partial<GainsAtRiskTrialCase> = {}): GainsAtRiskTrialCase {
  return { moves: [], noMoveCostUsd: null, crossing: { kind: "no-trial-effect" }, ...over };
}

describe("trial positions: fixed words", () => {
  it("the notes read as plain sentences", () => {
    expect(TRIAL_NOT_STORED_NOTE).toBe("Not stored. Nothing is traded from this page.");
    expect(TRIAL_CHART_NOTE).toBe("With trial positions on, the line without the offsetting positions is hidden.");
    expect(TRIAL_MULTIPLIER_NOTE).toBe("Options with 100 shares per contract only.");
    expect(TRIAL_EXPIRED_NOTE).toBe("This contract has expired. Remove it.");
    expect(TRIAL_ZERO_START_NOTE).toBe(
      "An option trial starts at zero and then moves with the app's own price for that name, which updates with each sync. Shares are marked from the price you typed.",
    );
  });
});

describe("trial positions: the label", () => {
  it("an option: the verb, the count apart (masked by the page), then the contract", () => {
    expect(trialPositionLabel(optionState())).toEqual({ verb: "Buy", count: 10, unit: null, text: "ZZQ 2027-03-20 500 put" });
    const written = optionState({ position: { ...optionPosition, side: "write", right: "call", strike: 2.5 } });
    expect(trialPositionLabel(written)).toEqual({ verb: "Write", count: 10, unit: null, text: "ZZQ 2027-03-20 2.5 call" });
  });

  it("shares: the unit noun goes through the privacy component", () => {
    expect(trialPositionLabel(sharesState())).toEqual({ verb: "Sell", count: 200, unit: "shares", text: "of ZZA" });
  });
});

describe("trial positions: the cost line (R7)", () => {
  it("the four costs, in their own words", () => {
    expect(trialCostLine(row())).toEqual({ verb: "costs", usd: 6_400, note: null });
    expect(trialCostLine(row({ cost: { kind: "premium-received", usd: 900 } }))).toEqual({
      verb: "premium received",
      usd: 900,
      note: "(an obligation, not a gain)",
    });
    expect(trialCostLine(row({ kind: "shares", cost: { kind: "cash-used", usd: 31_000 } }))).toEqual({
      verb: "uses",
      usd: 31_000,
      note: "of cash",
    });
    expect(trialCostLine(row({ kind: "shares", cost: { kind: "cash-raised", usd: 62_000 } }))).toEqual({
      verb: "raises",
      usd: 62_000,
      note: null,
    });
  });

  it("a refused row never shows a cost", () => {
    expect(trialCostLine(row({ refusal: "expired", cost: null, valueUsd: null }))).toBeNull();
  });

  it("the share of the year's gain: premium paid only, and only when step 1's rule allows a ratio", () => {
    expect(trialCostShareOfGain(row(), gain(400_000))).toBeCloseTo(0.016, 12);
    expect(trialCostShareOfGain(row(), gain(400_000, "not-checked"))).toBeCloseTo(0.016, 12);
    expect(trialCostShareOfGain(row(), gain(400_000, "differs"))).toBeNull();
    expect(trialCostShareOfGain(row(), gain(0))).toBeNull();
    expect(trialCostShareOfGain(row(), gain(-5_000))).toBeNull();
    expect(trialCostShareOfGain(row(), gain(null))).toBeNull();
    expect(trialCostShareOfGain(row({ cost: { kind: "premium-received", usd: 900 } }), gain(400_000))).toBeNull();
    expect(trialCostShareOfGain(row({ kind: "shares", cost: { kind: "cash-used", usd: 9 } }), gain(400_000))).toBeNull();
    expect(trialCostShareOfGain(row({ refusal: "expired", cost: null }), gain(400_000))).toBeNull();
  });

  it("net cash: raises or uses, never a signed figure in words", () => {
    expect(netCashLine(55_600)).toEqual({ verb: "raises", usd: 55_600 });
    expect(netCashLine(-6_400)).toEqual({ verb: "uses", usd: 6_400 });
    expect(netCashLine(0)).toEqual({ verb: "none", usd: 0 });
  });
});

describe("trial positions: when the real trade arrives (R4, P3)", () => {
  it("any account differs, even when the total is the same; a missing account is zero", () => {
    expect(holdingsChanged({ 1: 10, 2: 0 }, { 1: 0, 2: 10 })).toBe(true);
    expect(holdingsChanged({ 1: 10, 2: 0 }, { 1: 10 })).toBe(false);
    expect(holdingsChanged({}, {})).toBe(false);
    expect(holdingsChanged({ 1: 10 }, { 1: 11 })).toBe(true);
    expect(holdingsChanged({}, { 3: 1 })).toBe(true);
  });

  it("the sentence names the contract or the shares", () => {
    const t = optionState({ holdingsAtAddByAccount: { 1: 0 } });
    expect(holdingsChangedNote(t, row({ holdingsNowByAccount: { 1: 10 } }))).toBe(
      "Your holdings of ZZQ 2027-03-20 500 put changed since you added this. Remove it if this trade is now in your book.",
    );
    expect(holdingsChangedNote(t, row({ holdingsNowByAccount: {} }))).toBeNull();
    const s = sharesState();
    expect(holdingsChangedNote(s, row({ kind: "shares", symbol: "ZZA", holdingsNowByAccount: { 1: 300 } }))).toBe(
      "Your holdings of ZZA changed since you added this. Remove it if this trade is now in your book.",
    );
  });
});

describe("trial positions: leaves you short (P4, R5)", () => {
  it("per sale: the count apart, counted across every account", () => {
    expect(leavesShortNote(row({ kind: "shares", symbol: "ZZA", leavesShortBy: 150 }))).toEqual({
      before: "This sale leaves you short",
      count: 150,
      after: "ZZA, counted across every account.",
    });
    expect(leavesShortNote(row({ kind: "shares", leavesShortBy: 0 }))).toBeNull();
    expect(leavesShortNote(row({ kind: "shares", leavesShortBy: null }))).toBeNull();
  });

  it("per name: one line each, and a short already held is said apart", () => {
    const trial = {
      shortByName: [
        { securityId: 20, symbol: "ZZA", shortBy: 150, heldShortBefore: 0 },
        { securityId: 21, symbol: "ZZB", shortBy: 100, heldShortBefore: 50 },
      ],
    } as Pick<GainsAtRiskTrialResult, "shortByName">;
    expect(shortByNameLines(trial)).toEqual([
      {
        securityId: 20,
        symbol: "ZZA",
        shortBy: 150,
        heldShortBefore: 0,
        before: "Your trial positions leave you short",
        after: "ZZA, counted across every account.",
        alreadyShort: null,
      },
      {
        securityId: 21,
        symbol: "ZZB",
        shortBy: 100,
        heldShortBefore: 50,
        before: "Your trial positions leave you short",
        after: "ZZB, counted across every account.",
        alreadyShort: { before: "You were already short", count: 50, after: "before them." },
      },
    ]);
  });
});

describe("trial positions: the row's warnings and refusals", () => {
  it("no measured link: what the measured case does, and where to look instead", () => {
    const note = noLinkWarningNote(row({ noLinkWarning: true, betaSource: "no-measured-link", noMeasuredLinkReason: "no-daily-bars" }));
    expect(note).toBe(
      "ZZQ has no measured link to the index (no daily prices yet). In the measured case it is held unchanged, so this option shows only what time and the volatility change do to it there, and its move with the index is not counted. See the selloff case, or type your own figure for ZZQ in the table below.",
    );
    expect(noLinkWarningNote(row())).toBeNull();
    // Only point at the table when it is on screen.
    const off = noLinkWarningNote(row({ noLinkWarning: true, noMeasuredLinkReason: "no-daily-bars" }), { tableBelow: false });
    expect(off).not.toMatch(/table/);
    expect(off).toMatch(/See the selloff case\.$/);
  });

  it("every refusal has plain words; the expired one tells the owner to remove it", () => {
    const all = [
      "unknown-security",
      "is-an-option",
      "foreign-currency",
      "no-fx-rate",
      "no-underlying-price",
      "expired",
      "no-option-terms",
      "not-modelled",
    ] as const;
    for (const r of all) {
      const text = trialRefusalNote(row({ refusal: r, cost: null }));
      expect(text, r).toMatch(/\.$/);
      expect(text, r).not.toMatch(/\bhedges?\b/i);
    }
    expect(trialRefusalNote(row({ refusal: "expired", cost: null }))).toBe(TRIAL_EXPIRED_NOTE);
    expect(trialRefusalNote(row({ refusal: "not-modelled", ladderRefusal: "leveraged-no-factor", cost: null }))).toBe(
      "The app cannot model this fund: leveraged or inverse fund with no stored leverage factor. Type your own figure for it in the table below.",
    );
    // In the per-name table itself, the box is on the row; with no table on screen, no pointer.
    expect(
      trialRefusalNote(row({ refusal: "not-modelled", ladderRefusal: "leveraged-no-factor", cost: null }), { tableBelow: "this-row" }),
    ).toBe("The app cannot model this fund: leveraged or inverse fund with no stored leverage factor. Type your own figure for it in Your figure.");
    expect(
      trialRefusalNote(row({ refusal: "not-modelled", ladderRefusal: "leveraged-no-factor", cost: null }), { tableBelow: false }),
    ).toBe("The app cannot model this fund: leveraged or inverse fund with no stored leverage factor.");
    expect(trialRefusalNote(row({ refusal: "no-underlying-price", cost: null }))).toBe(
      "ZZQ is not a security the app holds a price for. It adds nothing.",
    );
    expect(trialRefusalNote(row())).toBeNull();
  });
});

describe("trial positions: the quote and the underlying's price (R2, R8)", () => {
  it("a quote mid says its sides, its kind and the time of the click", () => {
    expect(quoteText(quote)).toBe("mid of 6.30 / 6.50, live, fetched 14:32");
    expect(quoteLabel(optionState({ priceSource: "quote-mid", quote }))).toBe("mid of 6.30 / 6.50, live, fetched 14:32");
    expect(quoteLabel(optionState({ priceSource: "quote-mid", quote: { ...quote, tickKind: "delayed" } }))).toBe(
      "mid of 6.30 / 6.50, delayed, fetched 14:32",
    );
  });

  it("outside the regular session the label says the market is closed, whatever ticks arrived", () => {
    expect(quoteLabel(optionState({ priceSource: "quote-mid", quote: { ...quote, session: "market-closed" } }))).toBe(
      "mid of 6.30 / 6.50, market closed: the last quote, fetched 14:32",
    );
  });

  it("a typed price has no quote label", () => {
    expect(quoteLabel(optionState({ priceSource: "typed", quote }))).toBeNull();
    expect(quoteLabel(sharesState())).toBeNull();
  });

  it("a quoted underlying shows both the quote and the app's last stored price", () => {
    const t = optionState({
      underlyingPriceSource: "client-quote",
      underlyingPrice: 512.3,
      appValuation: { price: 505, date: "2026-11-21", source: "daily-bar" },
      staleCloseDate: null,
    });
    expect(underlyingPriceNote(t)).toBe("Underlying quoted 512.30; last stored 505.00, Nov 21.");
    expect(underlyingPriceNote(optionState())).toBeNull();
  });

  it("the stale close note shows only when no quote was used", () => {
    expect(staleCloseNote(optionState({ staleCloseDate: "2026-11-18" }))).toBe("Priced against the Nov 18 close.");
    expect(staleCloseNote(optionState({ staleCloseDate: null }))).toBeNull();
    expect(staleCloseNote(optionState({ staleCloseDate: "2026-11-18", underlyingPriceSource: "client-quote" }))).toBeNull();
  });

  it("the price source: the mid when the price is the quote's, typed otherwise", () => {
    expect(trialPriceSource("6.4", quote)).toBe("quote-mid");
    expect(trialPriceSource("6.45", quote)).toBe("typed");
    expect(trialPriceSource("6.4", null)).toBe("typed");
  });
});

describe("trial positions: the two sentences under the table (P5)", () => {
  it("what they cost with no move", () => {
    expect(noMoveCostSentence(trialCase({ noMoveCostUsd: 4_100 }))).toEqual({
      before: "With no move, the trial positions cost",
      usd: 4_100,
      after: "by that date.",
    });
    expect(noMoveCostSentence(trialCase({ noMoveCostUsd: -800 }))).toEqual({
      before: "With no move, the trial positions gain",
      usd: 800,
      after: "by that date.",
    });
    expect(noMoveCostSentence(trialCase({ noMoveCostUsd: 0 }))).toEqual({
      before: "With no move, the trial positions add nothing by that date.",
      usd: null,
      after: "",
    });
    expect(noMoveCostSentence(trialCase({ noMoveCostUsd: null }))).toBeNull();
  });

  it("one sentence per crossing kind", () => {
    const at = (crossing: GainsAtRiskTrialCase["crossing"]) => crossingSentence(trialCase({ crossing }), "ZZQ");
    expect(at({ kind: "better-at-every-move" })).toBe("They do better at every fall shown.");
    expect(at({ kind: "worse-at-every-move", deepestMove: -0.2 })).toBe("They cost more than they return at every fall shown.");
    expect(at({ kind: "pays-beyond", move: -0.014 })).toBe("They pay for themselves once ZZQ falls more than 1.4%.");
    expect(at({ kind: "helps-until", move: -0.075 })).toBe("They help in a small fall and cost more beyond 7.5%.");
    expect(at({ kind: "changes-more-than-once", firstHelpFrom: -0.02, firstHelpTo: -0.065 })).toBe(
      "They help between 2% and 6.5%. The picture changes more than once; read the table.",
    );
    expect(at({ kind: "no-trial-effect" })).toBeNull();
  });

  it("a crossing within 0.05% of zero reads from the first fall shown", () => {
    const at = (crossing: GainsAtRiskTrialCase["crossing"]) => crossingSentence(trialCase({ crossing }), "ZZQ");
    expect(at({ kind: "pays-beyond", move: -0.0004 })).toBe("They pay for themselves from the first fall shown.");
    expect(at({ kind: "helps-until", move: -0.0002 })).toBe("They cost more than they return from the first fall shown.");
    expect(at({ kind: "changes-more-than-once", firstHelpFrom: -0.0003, firstHelpTo: -0.065 })).toBe(
      "They help from the first fall shown to 6.5%. The picture changes more than once; read the table.",
    );
    expect(at({ kind: "pays-beyond", move: -0.0006 })).toBe("They pay for themselves once ZZQ falls more than 0.1%.");
  });

  it("a crossing beyond the table's rows points to the chart, not the table", () => {
    const c = trialCase({ crossing: { kind: "changes-more-than-once", firstHelpFrom: -0.12, firstHelpTo: -0.175 } });
    expect(crossingSentence(c, "ZZQ", [0, -0.05, -0.1, -0.15])).toBe(
      "They help between 12% and 17.5%. The picture changes more than once; see the chart.",
    );
    expect(crossingSentence(c, "ZZQ", [0, -0.05, -0.1, -0.15, -0.2])).toMatch(/read the table\.$/);
  });
});

describe("trial positions: the chart rows", () => {
  const book = (move: number, bookPnlUsd: number): GainsAtRiskMoveRow => ({ move, bookPnlUsd, losersPnlUsd: 0, offsetsPnlUsd: 0 });
  it("the selected case, sweep moves only: the book as it is and the book with the trial positions", () => {
    const baseCases: Record<GainsAtRiskCaseKey, { moves: GainsAtRiskMoveRow[] }> = {
      measured: { moves: [book(-0.2, -100), book(-0.07, -40), book(0, -5)] },
      selloff: { moves: [book(-0.2, -200), book(-0.07, -80), book(0, -5)] },
    };
    const trialCases: Record<GainsAtRiskCaseKey, { moves: GainsAtRiskTrialCase["moves"] }> = {
      measured: { moves: [moveRow(-0.2, 60, -100), moveRow(-0.07, 10, -40), moveRow(0, -4, -5)] },
      selloff: { moves: [moveRow(-0.2, 90, -200), moveRow(-0.07, 20, -80), moveRow(0, -4, -5)] },
    };
    // -7% is a custom row, not on the sweep: never a chart point.
    expect(trialChartRows(baseCases, trialCases, "measured")).toEqual([
      { move: -0.2, asIs: -100, withTrial: -40 },
      { move: 0, asIs: -5, withTrial: -9 },
    ]);
    expect(trialChartRows(baseCases, trialCases, "selloff")[0]).toEqual({ move: -0.2, asIs: -200, withTrial: -110 });
    const [lo, hi] = trialChartDollarDomain([
      { move: -0.2, asIs: -100, withTrial: -40 },
      { move: 0, asIs: -5, withTrial: -9 },
    ]);
    expect(lo).toBeLessThan(-100);
    expect(hi).toBeGreaterThan(0);
  });
});

describe("trial positions: the request and the list", () => {
  it("the engine receives each position as it was fixed at the click, untouched", () => {
    const list = [optionState(), sharesState()];
    expect(trialRequestPositions(list)).toEqual([optionPosition, sharesState().position]);
    expect(trialRequestPositions(list)[0]).toBe(optionPosition);
  });

  it("add, edit and remove each bump the version; at most 12", () => {
    let s = emptyTrialList();
    expect(s.version).toBe(0);
    s = trialListReducer(s, { type: "add", trial: optionState() });
    expect(s.list).toHaveLength(1);
    expect(s.version).toBe(1);
    const resized = optionState({ position: { ...optionPosition, contracts: 20 } });
    s = trialListReducer(s, { type: "replace", id: "t1", trial: resized });
    expect(s.list[0]).toBe(resized);
    expect(s.version).toBe(2);
    s = trialListReducer(s, { type: "remove", id: "t1" });
    expect(s.list).toHaveLength(0);
    expect(s.version).toBe(3);
    // Removing or replacing a missing id changes nothing.
    expect(trialListReducer(s, { type: "remove", id: "nope" })).toBe(s);
    expect(trialListReducer(s, { type: "replace", id: "nope", trial: optionState() })).toBe(s);
    let full = emptyTrialList();
    for (let i = 0; i < TRIAL_POSITION_BOUNDS.maxPositions; i++) {
      full = trialListReducer(full, { type: "add", trial: optionState({ position: { ...optionPosition, id: `t${i}` } }) });
    }
    expect(trialListReducer(full, { type: "add", trial: optionState({ position: { ...optionPosition, id: "t99" } }) })).toBe(full);
  });
});

describe("trial positions: the form's own checks", () => {
  it("refuses a 13th position, a fractional count, a past expiry", () => {
    expect(trialFormProblem(optionDraft(), 11, TODAY)).toBeNull();
    expect(trialFormProblem(optionDraft(), 12, TODAY)).toBe("At most 12 trial positions. Remove one first.");
    // Editing one of the twelve is not a thirteenth.
    expect(trialFormProblem(optionDraft({ editingId: "t1" }), 12, TODAY)).toBeNull();
    expect(trialFormProblem(optionDraft({ count: "1.5" }), 0, TODAY)).toBe(
      "Type the number of contracts as a whole number from 1 to 500.",
    );
    expect(trialFormProblem(optionDraft({ count: "0" }), 0, TODAY)).not.toBeNull();
    expect(trialFormProblem(optionDraft({ count: "501" }), 0, TODAY)).not.toBeNull();
    expect(trialFormProblem(optionDraft({ expiry: "2026-11-23" }), 0, TODAY)).toBe(
      "That expiry is before today. Pick a later one.",
    );
    expect(trialFormProblem(optionDraft({ expiry: TODAY }), 0, TODAY)).toBeNull();
    expect(trialFormProblem(optionDraft({ expiry: "2027-02-30" }), 0, TODAY)).toBe("Pick an expiry date.");
    expect(trialFormProblem(optionDraft({ strike: "-5" }), 0, TODAY)).toBe("Type the strike as a number above 0.");
    expect(trialFormProblem(optionDraft({ price: "" }), 0, TODAY)).toBe("Type the price per share as a number above 0.");
    expect(trialFormProblem(optionDraft({ symbol: "  " }), 0, TODAY)).toBe("Type a symbol.");
    const shares: TrialDraft = { ...emptyTrialDraft(), kind: "shares", symbol: "ZZA", side: "sell", count: "200", price: "310" };
    expect(trialFormProblem(shares, 0, TODAY)).toBeNull();
    expect(trialFormProblem({ ...shares, count: "2.5" }, 0, TODAY)).toBe(
      "Type the number of shares as a whole number from 1 to 1,000,000.",
    );
  });

  it("the request sent to the entry route; the quote's underlying price when a quote was fetched", () => {
    expect(trialEntryRequest(optionDraft(), null)).toEqual({
      kind: "option",
      symbol: "ZZQ",
      right: "put",
      side: "buy",
      expiry: "2027-03-20",
      strike: 500,
      contracts: 10,
      price: 6.4,
    });
    expect(trialEntryRequest(optionDraft({ side: "sell" }), { ...quote, underlyingLast: 512.3 })).toMatchObject({
      side: "write",
      quotedUnderlyingPrice: 512.3,
    });
    expect(trialEntryRequest({ ...emptyTrialDraft(), kind: "shares", symbol: " zza ", side: "sell", count: "200", price: "310" }, null)).toEqual({
      kind: "shares",
      symbol: "ZZA",
      side: "sell",
      quantity: 200,
      price: 310,
    });
  });

  it("the state kept from an entry reads the route's top-level price source and the app's own price", () => {
    const resp: Extract<TrialEntryResponse, { action: "entry" }> = {
      action: "entry",
      entry: {
        ok: true,
        position: {
          kind: "option",
          underlyingSecurityId: 10,
          right: "put",
          side: "buy",
          expiry: "2027-03-20",
          strike: 500,
          contracts: 10,
          pricePaid: 6.4,
          entryUnderlyingPrice: 512.3,
          valuationPriceAtEntry: 505,
          entryVolatility: 0.21,
        },
        symbol: "ZZQ",
        name: "ZZ Q fund",
        underlyingPrice: 512.3,
        underlyingPriceDate: TODAY,
        underlyingPriceSource: "quote",
        staleCloseDate: null,
        holdingsAtAddByAccount: { 1: 2 },
        hasContractId: true,
      },
      underlyingPriceSource: "client-quote",
      appValuation: { price: 505, date: "2026-11-21", source: "daily-bar" },
    };
    const t = trialStateFromEntry(resp, "t7", optionDraft(), quote);
    expect(t.position).toEqual({ ...resp.entry.position, id: "t7" });
    // Sent back untouched: the field the engine marks against.
    expect(t.position.kind === "option" && t.position.valuationPriceAtEntry).toBe(505);
    expect(t.underlyingPriceSource).toBe("client-quote");
    expect(t.appValuation).toEqual(resp.appValuation);
    expect(t.priceSource).toBe("quote-mid");
    expect(t.quote).toEqual(quote);
    expect(t.holdingsAtAddByAccount).toEqual({ 1: 2 });
  });
});

describe("trial positions: editing keeps the click (P1)", () => {
  it("a contracts-only change after prices moved resizes and keeps the entry and the holdings snapshot", () => {
    const prev = optionState({ holdingsAtAddByAccount: { 1: 0 }, priceSource: "quote-mid", quote });
    const out = applyTrialEdit(prev, { ...draftFromTrial(prev), count: "25" });
    expect(out.kind).toBe("resize");
    if (out.kind !== "resize") return;
    expect(out.next.position).toEqual({ ...optionPosition, contracts: 25 });
    expect(out.next.holdingsAtAddByAccount).toBe(prev.holdingsAtAddByAccount);
    expect(out.next.quote).toBe(quote);
    expect(out.next.priceSource).toBe("quote-mid");
    // The holdings flag still compares against the click's snapshot.
    expect(holdingsChanged(out.next.holdingsAtAddByAccount, { 1: 10 })).toBe(true);
  });

  it("a strike, expiry, side, right, symbol or price change is a new entry", () => {
    const prev = optionState();
    const base = draftFromTrial(prev);
    for (const patch of [
      { strike: "495" },
      { expiry: "2027-06-18" },
      { side: "sell" as const },
      { right: "call" as const },
      { symbol: "ZZR" },
      { price: "6.5" },
    ]) {
      expect(applyTrialEdit(prev, { ...base, ...patch }).kind, JSON.stringify(patch)).toBe("new-entry");
    }
  });

  it("shares: a quantity change resizes; a price or side change is a new entry", () => {
    const prev = sharesState();
    const base = draftFromTrial(prev);
    const out = applyTrialEdit(prev, { ...base, count: "50" });
    expect(out.kind === "resize" && out.next.position).toEqual({ ...prev.position, quantity: 50 });
    expect(applyTrialEdit(prev, { ...base, price: "305" }).kind).toBe("new-entry");
    expect(applyTrialEdit(prev, { ...base, side: "buy" }).kind).toBe("new-entry");
  });

  it("the form opened for an edit reads back exactly what the position holds", () => {
    expect(draftFromTrial(optionState())).toEqual({
      kind: "option",
      symbol: "ZZQ",
      right: "put",
      side: "buy",
      expiry: "2027-03-20",
      strike: "500",
      count: "10",
      price: "6.4",
      editingId: "t1",
    });
  });
});

describe("trial positions: the form's replies are tied to the draft (P6)", () => {
  const opened = (): TrialFormState => trialFormReducer(initialTrialFormState(), { type: "open", draft: optionDraft(), quote: null });
  const quoteReply = (s: TrialFormState, id: number, q: TrialQuote) =>
    trialFormReducer(s, {
      type: "reply",
      kind: "quote",
      id,
      revision: s.revision,
      contractKey: s.contractKey,
      payload: { ok: true, quote: q },
    });

  it("the contract key is kind, symbol, right, strike and expiry", () => {
    expect(trialContractKey(optionDraft())).toBe("option|ZZQ|put|500|2027-03-20");
    expect(trialContractKey(optionDraft({ symbol: " zzq ", side: "sell", count: "3", price: "1" }))).toBe(
      "option|ZZQ|put|500|2027-03-20",
    );
  });

  it("every edit bumps the revision; a reply for an older revision is dropped", () => {
    let s = opened();
    s = trialFormReducer(s, { type: "request", kind: "quote", id: 1 });
    const rev = s.revision;
    const key = s.contractKey;
    s = trialFormReducer(s, { type: "edit", patch: { count: "11" } });
    expect(s.revision).toBe(rev + 1);
    const late = trialFormReducer(s, { type: "reply", kind: "quote", id: 1, revision: rev, contractKey: key, payload: { ok: true, quote } });
    expect(late).toBe(s);
  });

  it("an edit leaves no quote or entry pending, so the form is never stuck waiting on a reply it will drop", () => {
    let s = opened();
    s = trialFormReducer(s, { type: "request", kind: "lookup", id: 1 });
    s = trialFormReducer(s, { type: "request", kind: "entry", id: 2 });
    expect(Object.keys(s.pending)).toEqual(["lookup", "entry"]);
    const rev = s.revision;
    const key = s.contractKey;
    s = trialFormReducer(s, { type: "edit", patch: { count: "12" } });
    // The lookup is keyed by the symbol, which did not change: it stays pending.
    expect(s.pending).toEqual({ lookup: 1 });
    expect(
      trialFormReducer(s, { type: "reply", kind: "entry", id: 2, revision: rev, contractKey: key, payload: { ok: false, message: "x" } }),
    ).toBe(s);
  });

  it("a reply for another contract is dropped", () => {
    let s = opened();
    s = trialFormReducer(s, { type: "request", kind: "quote", id: 1 });
    const out = trialFormReducer(s, {
      type: "reply",
      kind: "quote",
      id: 1,
      revision: s.revision,
      contractKey: "option|ZZQ|put|495|2027-03-20",
      payload: { ok: true, quote },
    });
    expect(out).toBe(s);
  });

  it("out of order: only the latest request's reply is kept", () => {
    let s = opened();
    s = trialFormReducer(s, { type: "request", kind: "quote", id: 1 });
    s = trialFormReducer(s, { type: "request", kind: "quote", id: 2 });
    const newer = { ...quote, bid: 7, ask: 7.2, mid: 7.1 };
    const afterNewer = quoteReply(s, 2, newer);
    expect(afterNewer.quote).toEqual(newer);
    expect(afterNewer.draft.price).toBe("7.1");
    // The older reply arrives last: dropped.
    expect(quoteReply(afterNewer, 1, quote)).toBe(afterNewer);
    expect(isCurrentTrialReply(afterNewer, "quote", 1, afterNewer.revision, afterNewer.contractKey)).toBe(false);
  });

  it("a strike edit clears the quote; a size edit keeps it", () => {
    let s = opened();
    s = trialFormReducer(s, { type: "request", kind: "quote", id: 1 });
    s = quoteReply(s, 1, quote);
    expect(s.quote).toEqual(quote);
    const sized = trialFormReducer(s, { type: "edit", patch: { count: "20" } });
    expect(sized.quote).toEqual(quote);
    const struck = trialFormReducer(s, { type: "edit", patch: { strike: "495" } });
    expect(struck.quote).toBeNull();
    expect(struck.contractKey).toBe("option|ZZQ|put|495|2027-03-20");
  });

  it("a reply after cancel is dropped", () => {
    let s = opened();
    s = trialFormReducer(s, { type: "request", kind: "lookup", id: 1 });
    const rev = s.revision;
    const key = s.contractKey;
    s = trialFormReducer(s, { type: "cancel" });
    expect(s.open).toBe(false);
    expect(s.pending).toEqual({});
    const security: TrialLookup = {
      securityId: 10,
      symbol: "ZZQ",
      name: null,
      price: 505,
      priceDate: "2026-11-23",
      priceSource: "book",
      hasContractId: true,
      dailyBars: { count: 400, through: "2026-11-23" },
    };
    const out = trialFormReducer(s, { type: "reply", kind: "lookup", id: 1, revision: rev, contractKey: key, payload: { ok: true, security } });
    expect(out).toBe(s);
  });

  it("a symbol change forgets the name's lookup and chain; a refusal is kept as a sentence", () => {
    let s = opened();
    s = trialFormReducer(s, { type: "request", kind: "lookup", id: 1 });
    s = trialFormReducer(s, {
      type: "reply",
      kind: "lookup",
      id: 1,
      revision: s.revision,
      contractKey: s.contractKey,
      payload: { ok: false, message: "The app does not know ZZQ yet. Add it to the watchlist first." },
    });
    expect(s.messages.lookup).toBe("The app does not know ZZQ yet. Add it to the watchlist first.");
    expect(s.pending.lookup).toBeUndefined();
    s = trialFormReducer(s, { type: "edit", patch: { symbol: "ZZR" } });
    expect(s.messages.lookup).toBeUndefined();
    expect(s.security).toBeNull();
    expect(s.chain).toBeNull();
  });

  it("opening the form again starts a later revision, so an earlier session's reply cannot land", () => {
    const first = opened();
    const closed = trialFormReducer(first, { type: "cancel" });
    const again = trialFormReducer(closed, { type: "open", draft: optionDraft(), quote: null });
    expect(again.revision).toBeGreaterThan(first.revision);
  });
});

describe("fix round 1", () => {
  const security: TrialLookup = {
    securityId: 10,
    symbol: "ZZQ",
    name: null,
    price: 505,
    priceDate: "2026-11-23",
    priceSource: "book",
    hasContractId: true,
    dailyBars: { count: 400, through: "2026-11-23" },
  };
  const opened = (d: Partial<TrialDraft> = {}): TrialFormState =>
    trialFormReducer(initialTrialFormState(), { type: "open", draft: optionDraft(d), quote: null });
  const withQuote = (s: TrialFormState, q: TrialQuote): TrialFormState => {
    const r = trialFormReducer(s, { type: "request", kind: "quote", id: 50 });
    return trialFormReducer(r, { type: "reply", kind: "quote", id: 50, revision: r.revision, contractKey: r.contractKey, payload: { ok: true, quote: q } });
  };

  it("the selloff legend keeps its assumption", () => {
    expect(trialChartLineLabels("selloff")).toEqual({
      asIs: "book as it is, selloff case (an assumption)",
      withTrial: "book with your trial positions, selloff case (an assumption)",
    });
    expect(trialChartLineLabels("measured")).toEqual({ asIs: "book as it is, measured", withTrial: "book with your trial positions, measured" });
  });

  it("the cost share of the year's gain uses step 1's under-0.1% rule", () => {
    expect(trialCostShareCell(row(), gain(400_000))).toEqual({ kind: "pct", percent: 1.6 });
    expect(trialCostShareCell(row({ cost: { kind: "premium-paid", usd: 100 } }), gain(400_000))).toEqual({ kind: "under-tenth" });
    expect(trialCostShareCell(row({ cost: { kind: "premium-received", usd: 100 } }), gain(400_000))).toBeNull();
    expect(trialCostShareCell(row(), gain(400_000, "differs"))).toBeNull();
  });

  it("the lookup line promises a fetch only when one will happen", () => {
    const none = { ...security, dailyBars: { count: 0, through: null } };
    expect(lookupBarsLine(none, true)).toBe("No daily prices yet: they are fetched from the broker when you add it.");
    expect(lookupBarsLine({ ...none, hasContractId: false }, true)).toBe(
      "No daily prices, and no broker contract on file, so its link to the index cannot be measured. Type your own figure for it after adding.",
    );
    expect(lookupBarsLine(none, false)).toBe("No daily prices yet. Connect the broker to fetch them.");
    expect(lookupBarsLine(none, null)).toBeNull();
    expect(lookupBarsLine(security, null)).toBe("Daily prices through Nov 23.");
  });

  it("a typed strike matches the chain by value; a typed value off the chain is kept as typed", () => {
    const chain = { expirations: ["2027-03-20", "2027-06-18"], strikes: [470, 480, 490] };
    expect(trialContractKey(optionDraft({ strike: "480.0" }))).toBe(trialContractKey(optionDraft({ strike: "480" })));
    expect(chainFieldState(optionDraft({ strike: "480.0" }), chain)).toEqual({
      expiry: { inChain: true, value: "2027-03-20" },
      strike: { inChain: true, value: "480" },
    });
    expect(chainFieldState(optionDraft({ strike: "485", expiry: "2027-04-16" }), chain)).toEqual({
      expiry: { inChain: false, value: "2027-04-16" },
      strike: { inChain: false, value: "485" },
    });
    // An empty field picks from the list.
    expect(chainFieldState(optionDraft({ strike: "", expiry: "" }), chain)).toEqual({
      expiry: { inChain: true, value: "" },
      strike: { inChain: true, value: "" },
    });
  });

  it("lookup and chain are keyed by the symbol: a count, strike or price edit neither drops nor re-asks them", () => {
    let s = opened();
    s = trialFormReducer(s, { type: "request", kind: "lookup", id: 1 });
    s = trialFormReducer(s, { type: "request", kind: "chain", id: 2 });
    const sent = { revision: s.revision, contractKey: s.contractKey };
    s = trialFormReducer(s, { type: "edit", patch: { count: "7", strike: "490", price: "5" } });
    expect(s.pending).toEqual({ lookup: 1, chain: 2 });
    s = trialFormReducer(s, { type: "reply", kind: "lookup", id: 1, ...sent, symbol: "ZZQ", payload: { ok: true, security } });
    expect(s.security).toEqual(security);
    s = trialFormReducer(s, {
      type: "reply",
      kind: "chain",
      id: 2,
      ...sent,
      symbol: "ZZQ",
      payload: { ok: true, expirations: ["2027-03-20"], strikes: [480, 490] },
    });
    expect(s.chain).toEqual({ expirations: ["2027-03-20"], strikes: [480, 490] });
    // The chain never touches what the owner typed.
    expect(s.draft).toMatchObject({ count: "7", strike: "490", price: "5" });
    expect(s.pending).toEqual({});
  });

  it("a symbol edit drops the lookup and chain on the way", () => {
    let s = opened();
    s = trialFormReducer(s, { type: "request", kind: "lookup", id: 1 });
    const sent = { revision: s.revision, contractKey: s.contractKey };
    s = trialFormReducer(s, { type: "edit", patch: { symbol: "ZZR" } });
    expect(s.pending).toEqual({});
    expect(trialFormReducer(s, { type: "reply", kind: "lookup", id: 1, ...sent, symbol: "ZZQ", payload: { ok: true, security } })).toBe(s);
  });

  it("a contract change after a quote clears the price when it is still that quote's mid; a hand-typed price is kept", () => {
    const q = { ...quote, mid: 6.4 };
    let s = withQuote(opened({ strike: "480", price: "" }), q);
    expect(s.draft.price).toBe("6.4");
    s = trialFormReducer(s, { type: "edit", patch: { strike: "490" } });
    expect(s.quote).toBeNull();
    expect(s.draft.price).toBe("");
    let typed = opened({ strike: "480", price: "6.4" });
    typed = trialFormReducer(typed, { type: "edit", patch: { strike: "490" } });
    expect(typed.draft.price).toBe("6.4");
    // A quote whose mid the owner then overwrote: the typed price stays.
    let over = withQuote(opened({ strike: "480" }), q);
    over = trialFormReducer(over, { type: "edit", patch: { price: "6.9" } });
    over = trialFormReducer(over, { type: "edit", patch: { strike: "490" } });
    expect(over.draft.price).toBe("6.9");
  });

  it("an unmount runs cancel: an entry reply still on the way is dropped", () => {
    let s = opened();
    s = trialFormReducer(s, { type: "request", kind: "entry", id: 9 });
    const sent = { revision: s.revision, contractKey: s.contractKey };
    const gone = trialFormReducer(s, { type: "cancel" });
    const payload = { ok: false as const, message: "x" };
    expect(trialFormReducer(gone, { type: "reply", kind: "entry", id: 9, ...sent, payload })).toBe(gone);
    expect(isCurrentTrialReply(gone, "entry", 9, sent.revision, sent.contractKey)).toBe(false);
  });

  it("a lookup on the way never blocks Add; a quote, a fetch or an entry does", () => {
    let s = opened();
    s = trialFormReducer(s, { type: "request", kind: "lookup", id: 1 });
    s = trialFormReducer(s, { type: "request", kind: "chain", id: 2 });
    expect(addBlockedBy(s)).toBe(false);
    expect(addBlockedBy(trialFormReducer(s, { type: "request", kind: "quote", id: 3 }))).toBe(true);
    expect(addBlockedBy(trialFormReducer(s, { type: "request", kind: "ensure", id: 4 }))).toBe(true);
    expect(addBlockedBy(trialFormReducer(s, { type: "request", kind: "entry", id: 5 }))).toBe(true);
  });

  it("after a failed daily-price fetch, Add waits for the owner: try again, or add without daily prices", () => {
    const noBars = { ...security, dailyBars: { count: 0, through: null } };
    let s = opened();
    expect(barsStep(s, noBars, true)).toBe("fetch");
    expect(barsStep(s, noBars, false)).toBe("none");
    expect(barsStep(s, { ...noBars, hasContractId: false }, true)).toBe("none");
    expect(barsStep(s, security, true)).toBe("none");
    s = trialFormReducer(s, { type: "request", kind: "ensure", id: 1 });
    s = trialFormReducer(s, {
      type: "reply",
      kind: "ensure",
      id: 1,
      revision: s.revision,
      contractKey: s.contractKey,
      symbol: "ZZQ",
      payload: { ok: false, message: "Daily prices are being fetched for other names. Try again in a moment." },
    });
    expect(barsStep(s, noBars, true)).toBe("blocked");
    expect(barsStep(trialFormReducer(s, { type: "retry-bars" }), noBars, true)).toBe("fetch");
    expect(barsStep(trialFormReducer(s, { type: "skip-bars" }), noBars, true)).toBe("none");
    // A success ends the question.
    let ok = trialFormReducer(opened(), { type: "request", kind: "ensure", id: 2 });
    ok = trialFormReducer(ok, { type: "reply", kind: "ensure", id: 2, revision: ok.revision, contractKey: ok.contractKey, symbol: "ZZQ", payload: { ok: true, message: null } });
    expect(barsStep(ok, noBars, true)).toBe("none");
  });

  it("a size-only edit of an expired trial is allowed: the kept expiry is not re-checked", () => {
    const d = optionDraft({ expiry: "2026-11-20", editingId: "t1" });
    expect(trialFormProblem(d, 3, TODAY)).toBe("That expiry is before today. Pick a later one.");
    expect(trialFormProblem(d, 3, TODAY, { keptExpiry: "2026-11-20" })).toBeNull();
    expect(trialFormProblem({ ...d, expiry: "2026-11-21" }, 3, TODAY, { keptExpiry: "2026-11-20" })).not.toBeNull();
  });
});
