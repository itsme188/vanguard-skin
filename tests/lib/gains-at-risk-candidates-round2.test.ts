import { describe, expect, it } from "vitest";
import {
  CANDIDATE_SORT_OPTIONS,
  CANDIDATE_STEPS,
  EXPIRES_BEFORE_NOTE,
  STRIKES_NEAR_NOTE,
  candidateCells,
  candidateLegend,
  candidatesReducer,
  expiresBeforeText,
  expiresBeforeValuation,
  formatPerContractUsd,
  initialCandidatesState,
  perThousandHeading,
  perThousandSpent,
  priceMarkerIndex,
  quotedUnderlyingLines,
  sortCandidateRows,
  storedPriceLine,
  strikeSideText,
  visibleStrikes,
  type CandidateRowState,
  type CandidatesAction,
  type CandidatesState,
} from "@/lib/analysis/gains-at-risk-candidates-view";
import { GAINS_ANCHORS, pageDescription, pageGuideLines } from "@/lib/analysis/gains-at-risk-view";
import type {
  CandidateEntryRecord,
  CandidateQuoteFields,
  CandidateRow,
  CandidatesResponse,
} from "@/lib/analysis/gains-at-risk-candidates-input";
import type { GainsAtRiskCandidateCase } from "@/lib/compute/gains-at-risk";
import type { YearGainResult } from "@/lib/compute/year-gain";

// Every figure here is made up; every symbol is a synthetic ZZ name.

const ZZA = 7;
const ZZQ = 9;

function quote(over: Partial<CandidateQuoteFields> = {}): CandidateQuoteFields {
  return {
    bid: 3.1,
    ask: 3.3,
    mid: 3.2,
    tickKind: "live",
    session: "regular-session",
    optionObservedAt: "2026-11-25T19:32:10.000Z",
    underlyingObservedAt: "2026-11-25T19:32:00.000Z",
    underlyingPrice: 101.4,
    ...over,
  };
}

function record(conId: number): CandidateEntryRecord {
  return {
    entry: {
      ok: true,
      position: {
        kind: "option",
        underlyingSecurityId: ZZA,
        right: "put",
        side: "buy",
        expiry: "2026-11-30",
        strike: 95,
        contracts: 1,
        pricePaid: 3.2,
        entryUnderlyingPrice: 101.4,
        valuationPriceAtEntry: 100.9,
        entryVolatility: 0.31,
        brokerContractId: conId,
      },
      symbol: "ZZA",
      name: null,
      underlyingPrice: 101.4,
      underlyingPriceDate: "2026-11-25",
      underlyingPriceSource: "quote",
      staleCloseDate: null,
      holdingsAtAddByAccount: {},
      hasContractId: true,
    },
    underlyingPriceSource: "client-quote",
    appValuation: null,
  };
}

function cs(over: Partial<GainsAtRiskCandidateCase> = {}): GainsAtRiskCandidateCase {
  return {
    beta: 1,
    pnlByMove: [0],
    atSelectedMoveUsd: -4000,
    atZeroMoveUsd: -4000,
    crossing: { kind: "worse-at-every-move", deepestMove: -0.4 },
    crossingDirection: "fall",
    heldUnchanged: false,
    ...over,
  };
}

function priced(conId: number, costUsd: number, at: number): CandidateRow {
  return {
    conId,
    status: "priced",
    contracts: 10,
    capped: false,
    perContractUsd: costUsd / 10,
    costUsd,
    unspentUsd: 0,
    quote: { ...quote(), source: "client-supplied" },
    engine: {
      id: String(conId),
      identitySecurityId: ZZA,
      symbol: "ZZA",
      betaSource: "owner",
      valueUsd: 0,
      cost: { kind: "premium-paid", usd: costUsd },
      cases: { measured: cs({ atSelectedMoveUsd: at }), selloff: cs({ atSelectedMoveUsd: at }) },
    },
  };
}

function gain(gainUsd: number | null): YearGainResult {
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
    reconciliation: { status: "agrees", throughMonth: null, differenceUsd: null },
  };
}

const run = (s: CandidatesState, ...a: CandidatesAction[]) => a.reduce(candidatesReducer, s);

/** Rows 101..10n quoted (ZZA, expiring Nov 30) with the given figures. */
function table(figures: CandidateRow[], quotes: CandidateQuoteFields[] = []): CandidatesState {
  const ids = figures.map((f) => f.conId);
  let s = run(
    initialCandidatesState(),
    { type: "open" },
    { type: "inputs-changed", key: "k" },
    {
      type: "quotes-request",
      mode: "pull",
      pullId: 1,
      underlyingSecurityId: ZZA,
      symbol: "ZZA",
      contracts: ids.map((conId) => ({ conId, right: "put", expiry: "2026-11-30", strike: 95, multiplier: 100, tradingClass: "ZZA" })),
    },
  );
  s = run(s, {
    type: "quotes-reply",
    pullId: 1,
    underlyingSecurityId: ZZA,
    reply: {
      underlyingSecurityId: ZZA,
      requestedConIds: ids,
      rows: ids.map((conId, i) => ({ conId, status: "quoted", quote: quotes[i] ?? quote(), record: record(conId) })),
    },
  });
  return run(s, { type: "compute-reply", seq: s.computeSeq, reply: { rows: figures } as unknown as CandidatesResponse });
}

describe("item 1: a contract that expires before the date", () => {
  it("compares calendar days; the same day is not before", () => {
    expect(expiresBeforeValuation("2026-11-30", "2026-12-31")).toBe(true);
    expect(expiresBeforeValuation("2026-12-31", "2026-12-31")).toBe(false);
    expect(expiresBeforeValuation("2027-01-15", "2026-12-31")).toBe(false);
    expect(expiresBeforeValuation("not a day", "2026-12-31")).toBe(false);
  });

  it("the row says so in place of the crossing text, and still has figures", () => {
    const s = table([priced(101, 5000, -5000)]);
    const cells = candidateCells(s.rows[0], "measured", gain(400_000), "ZZA", "2026-12-31");
    expect(cells.kind).toBe("priced");
    if (cells.kind !== "priced") return;
    expect(cells.expiresBeforeText).toBe("Expires before Dec 31. Counted as expiring before the move.");
    expect(expiresBeforeText("2026-12-31")).toBe(cells.expiresBeforeText);
    expect(EXPIRES_BEFORE_NOTE).toBe("To see a contract pay, set the date on or before its expiry.");
    const onOrBefore = candidateCells(s.rows[0], "measured", gain(400_000), "ZZA", "2026-11-30");
    expect(onOrBefore.kind === "priced" && onOrBefore.expiresBeforeText).toBeNull();
    // It sorts with figures, ahead of a row with none.
    const t = table([priced(101, 5000, -5000), { conId: 102, status: "zero-contracts", perContractUsd: 9999, quote: { ...quote(), source: "client-supplied" } }]);
    expect(sortCandidateRows(t.rows, "atSelected", "measured").map((r) => r.conId)).toEqual([101, 102]);
  });
});

describe("item 2: strikes near the money", () => {
  const strikes = (list: number[]) => list.map((strike, i) => ({ conId: 1000 + i, strike }));
  const fifty = strikes(Array.from({ length: 50 }, (_, i) => 50 + i * 2.5)); // 50 .. 172.5

  it("a price between strikes: 15 below and 15 at or above", () => {
    const v = visibleStrikes(fifty, 101.4, []);
    expect(v).toHaveLength(30);
    expect(v[0].strike).toBe(65);
    expect(v[14].strike).toBe(100);
    expect(v[15].strike).toBe(102.5);
    expect(v[29].strike).toBe(137.5);
  });

  it("a price below the lowest strike, and above the highest", () => {
    const low = visibleStrikes(fifty, 10, []);
    expect(low.map((c) => c.strike)).toEqual(fifty.slice(0, 15).map((c) => c.strike));
    const high = visibleStrikes(fifty, 500, []);
    expect(high.map((c) => c.strike)).toEqual(fifty.slice(-15).map((c) => c.strike));
  });

  it("fewer than 15 on a side shows what there is", () => {
    const few = strikes([90, 95, 100, 105, 110]);
    expect(visibleStrikes(few, 101, []).map((c) => c.strike)).toEqual([90, 95, 100, 105, 110]);
  });

  it("a chosen far strike stays visible; no price shows every strike", () => {
    const far = fifty[49];
    const v = visibleStrikes(fifty, 101.4, [far.conId]);
    expect(v).toHaveLength(31);
    expect(v[v.length - 1]).toBe(far);
    expect(visibleStrikes(fifty, null, [])).toHaveLength(50);
  });

  it("item 3: the price marker sits between the strikes it falls between", () => {
    const few = strikes([90, 95, 100, 105, 110]);
    expect(priceMarkerIndex(few, 101.4)).toBe(3);
    expect(priceMarkerIndex(few, 100)).toBe(2);
    expect(priceMarkerIndex(few, 80)).toBe(0);
    expect(priceMarkerIndex(few, 200)).toBe(5);
    expect(priceMarkerIndex(few, null)).toBeNull();
  });
});

describe("item 3: the underlying price", () => {
  it("the line above the strikes, and which side is out of the money", () => {
    expect(storedPriceLine("ZZA", 101.4)).toBe("ZZA last stored 101.40.");
    expect(storedPriceLine("ZZA", 101.4, "2026-11-24", "book")).toBe("ZZA last stored 101.40, Nov 24.");
    expect(storedPriceLine("ZZA", 101.4, "2026-11-24", "stored-price")).toBe("ZZA last stored 101.40, Nov 24.");
    expect(storedPriceLine("ZZA", 101.4, "2026-11-24", "daily-bar")).toBe("ZZA last close 101.40, Nov 24.");
    // The day comes from the string itself: Dec 31 stays Dec 31 whatever the clock's zone.
    expect(storedPriceLine("ZZA", 101.4, "2026-12-31", "stored-price")).toBe("ZZA last stored 101.40, Dec 31.");
    expect(storedPriceLine("ZZA", 101.4, null, null)).toBe("ZZA last stored 101.40.");
    expect(storedPriceLine("ZZA", null)).toBeNull();
    expect(strikeSideText("put")).toBe("Below the price: out of the money for a put.");
    expect(strikeSideText("call")).toBe("Above the price: out of the money for a call.");
    expect(STRIKES_NEAR_NOTE).toBe("The five nearest out of the money are ticked to start. Only strikes near the price are listed.");
  });

  it("after a pull: each underlying's newest quoted price and its time", () => {
    const rows = [
      { conId: 1, underlyingSecurityId: ZZA, symbol: "ZZA", quote: quote() },
      { conId: 2, underlyingSecurityId: ZZA, symbol: "ZZA", quote: quote({ underlyingPrice: 102, underlyingObservedAt: "2026-11-25T19:40:00.000Z" }) },
      { conId: 3, underlyingSecurityId: ZZQ, symbol: "ZZQ", quote: quote({ underlyingPrice: 55.25 }) },
      { conId: 4, underlyingSecurityId: ZZQ, symbol: "ZZQ", quote: null },
    ] as unknown as CandidateRowState[];
    expect(quotedUnderlyingLines(rows)).toEqual(["ZZA quoted 102.00 at 14:40.", "ZZQ quoted 55.25 at 14:32."]);
  });
});

describe("item 4: per-contract prices group thousands", () => {
  it.each([
    [999.5, "$999.50"],
    [1010, "$1,010.00"],
    [12345.67, "$12,345.67"],
    [0.5, "$0.50"],
    [47.5, "$47.50"],
    [null, "—"],
  ])("%s → %s", (v, out) => {
    expect(formatPerContractUsd(v)).toBe(out);
  });
});

describe("item 5: per $1,000 spent", () => {
  it("change at the move / cost x 1000; blank with no cost", () => {
    expect(perThousandSpent(4150, 9920)).toBeCloseTo(418.346774, 5);
    expect(perThousandSpent(-500, 5000)).toBe(-100);
    expect(perThousandSpent(100, 0)).toBeNull();
    expect(perThousandSpent(null, 100)).toBeNull();
    expect(perThousandHeading(-0.1)).toBe("At -10%, per $1,000 spent");
  });

  it("a cell and a sort column", () => {
    const s = table([priced(101, 10_000, 3000), priced(102, 5000, 2000)]);
    const c = candidateCells(s.rows[0], "measured", gain(400_000), "ZZA");
    expect(c.kind === "priced" && c.perThousandUsd).toBe(300);
    expect(CANDIDATE_SORT_OPTIONS.some((o) => o.key === "perThousand")).toBe(true);
    expect(sortCandidateRows(s.rows, "perThousand", "measured").map((r) => r.conId)).toEqual([101, 102]);
    expect(sortCandidateRows(s.rows, "atSelected", "measured").map((r) => r.conId)).toEqual([102, 101]);
  });
});

describe("item 6: guidance", () => {
  it("the orientation block: three lines, each linking to its section, the first carrying the page description", () => {
    for (const kind of ["index", "single-name"] as const) {
      const lines = pageGuideLines(kind);
      expect(lines.map((l) => l.name)).toEqual(["Chart and table", "Try a position", "Compare options"]);
      expect(lines.map((l) => l.anchor)).toEqual([GAINS_ANCHORS.results, GAINS_ANCHORS.trial, GAINS_ANCHORS.candidates]);
      const d = pageDescription(kind);
      expect(lines[0].text).toBe(d.charAt(0).toLowerCase() + d.slice(1));
    }
    expect(pageGuideLines("index")[1].text).toBe("adds one position you type or quote.");
    expect(pageGuideLines("index")[2].text).toBe("prices several contracts on one budget.");
  });

  it("the steps and the legend, word for word", () => {
    expect(CANDIDATE_STEPS).toEqual([
      "Pick the underlying and up to three expiries.",
      "Show strikes and tick up to 15 contracts.",
      "Get quotes.",
      "Set a budget and read the table.",
      "Add a row to try it in the chart.",
    ]);
    expect(candidateLegend(-0.1, "Pays once ZZA falls past")).toEqual([
      { term: "Contracts", text: "whole contracts the budget buys." },
      { term: "Cost", text: "contracts times the price per contract, at the mid." },
      {
        term: "At -10%",
        text: "the change in the book from this row alone, net of its cost, on top of the trial positions already listed.",
      },
      { term: "At -10%, per $1,000 spent", text: "the same change scaled to $1,000 of cost, so rows that spend different amounts compare." },
      { term: "At 0%", text: "what waiting costs by the date, with no move." },
      { term: "Pays once ZZA falls past", text: "the move where the row breaks even." },
      { term: "Cost / year's gain", text: "the cost as a share of the year's gain." },
    ]);
  });

  it("no paragraph runs past two sentences, and no banned words", () => {
    const texts = [
      ...CANDIDATE_STEPS,
      ...candidateLegend(0.2, "Pays once ZZA rises past").map((l) => `${l.term}: ${l.text}`),
      ...pageGuideLines("index").map((l) => l.text),
      ...pageGuideLines("single-name").map((l) => l.text),
      EXPIRES_BEFORE_NOTE,
      expiresBeforeText("2026-12-31"),
    ];
    for (const t of texts) {
      expect(t.split(/(?<=\.)\s+/).filter(Boolean).length).toBeLessThanOrEqual(2);
      expect(t).not.toMatch(/\b(hedges?|best|recommended)\b/i);
    }
  });
});
