import { describe, expect, it } from "vitest";
import {
  CANDIDATES_NOT_STORED_NOTE,
  ZERO_CONTRACTS_TEXT,
  candidateAddBlocked,
  candidateCells,
  candidateCostShareOfGain,
  candidateCrossingText,
  candidateRequestItems,
  candidateToTrial,
  candidatesBaseBody,
  candidatesReducer,
  chosenBatchContracts,
  crossingHeading,
  defaultCandidateUnderlying,
  driverNotListedNote,
  headingDirection,
  heldUnchangedNote,
  initialCandidatesState,
  isOldQuote,
  parseBudgetText,
  perContractUsdOf,
  pullProblem,
  quoteAgeLine,
  refreshBatches,
  sortCandidateRows,
  type CandidateRowState,
  type CandidatesAction,
  type CandidatesState,
  type PricedCandidateRow,
} from "@/lib/analysis/gains-at-risk-candidates-view";
import { TRIAL_LIMIT_TEXT, type TrialPositionState } from "@/lib/analysis/gains-at-risk-trial-view";
import type { GainsControls } from "@/lib/analysis/gains-at-risk-view";
import type {
  BatchContractRequest,
  CandidateEntryRecord,
  CandidateQuoteFields,
  CandidateRow,
  CandidatesResponse,
  ChainResponse,
  QuoteRow,
  QuotesResponse,
} from "@/lib/analysis/gains-at-risk-candidates-input";
import type { GainsAtRiskCandidateCase, GainsAtRiskCandidateResult } from "@/lib/compute/gains-at-risk";
import type { CandidateUnderlyingEntry, SingleNameDriverEntry } from "@/lib/compute/gains-at-risk-drivers";
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

function record(conId: number, underlying = ZZA): CandidateEntryRecord {
  return {
    entry: {
      ok: true,
      position: {
        kind: "option",
        underlyingSecurityId: underlying,
        right: "put",
        side: "buy",
        expiry: "2027-03-19",
        strike: 95,
        contracts: 1,
        pricePaid: 3.2,
        entryUnderlyingPrice: 101.4,
        valuationPriceAtEntry: 100.9,
        entryVolatility: 0.31,
        brokerContractId: conId,
      },
      symbol: underlying === ZZA ? "ZZA" : "ZZQ",
      name: "ZZA Holdings",
      underlyingPrice: 101.4,
      underlyingPriceDate: "2026-11-25",
      underlyingPriceSource: "quote",
      staleCloseDate: null,
      holdingsAtAddByAccount: { 3: 2 },
      hasContractId: true,
    },
    underlyingPriceSource: "client-quote",
    appValuation: { price: 100.9, date: "2026-11-24", source: "book" },
  };
}

function contract(conId: number, strike = 95): BatchContractRequest {
  return { conId, right: "put", expiry: "2027-03-19", strike, multiplier: 100, tradingClass: "ZZA" };
}

function crossingCase(over: Partial<GainsAtRiskCandidateCase> = {}): GainsAtRiskCandidateCase {
  return {
    beta: 1,
    pnlByMove: [100, -50],
    atSelectedMoveUsd: 4150,
    atZeroMoveUsd: -640,
    crossing: { kind: "pays-beyond", move: -0.061 },
    crossingDirection: "fall",
    heldUnchanged: false,
    ...over,
  };
}

function engine(conId: number, over: Partial<GainsAtRiskCandidateCase> = {}): GainsAtRiskCandidateResult {
  return {
    id: String(conId),
    identitySecurityId: ZZA,
    symbol: "ZZA",
    betaSource: "owner",
    valueUsd: 9920,
    cost: { kind: "premium-paid", usd: 9920 },
    cases: { measured: crossingCase(over), selloff: crossingCase({ ...over, atSelectedMoveUsd: 5000 }) },
  };
}

function priced(conId: number, over: Partial<PricedCandidateRow> = {}, caseOver: Partial<GainsAtRiskCandidateCase> = {}): CandidateRow {
  return {
    conId,
    status: "priced",
    contracts: 31,
    capped: false,
    perContractUsd: 320,
    costUsd: 9920,
    unspentUsd: 80,
    quote: { ...quote(), source: "client-supplied" },
    engine: engine(conId, caseOver),
    ...over,
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

function run(state: CandidatesState, ...actions: CandidatesAction[]): CandidatesState {
  return actions.reduce(candidatesReducer, state);
}

const opened = () => run(initialCandidatesState(), { type: "open" }, { type: "set-underlying", securityId: ZZA });

function pullReq(pullId: number, conIds: number[], mode: "pull" | "refresh" = "pull", underlying = ZZA): CandidatesAction {
  return {
    type: "quotes-request",
    mode,
    pullId,
    underlyingSecurityId: underlying,
    symbol: underlying === ZZA ? "ZZA" : "ZZQ",
    contracts: conIds.map((id) => contract(id)),
  };
}

function quotedRow(conId: number, q = quote()): QuoteRow {
  return { conId, status: "quoted", quote: q, record: record(conId) };
}

function pullReply(pullId: number, rows: QuoteRow[], underlying = ZZA): CandidatesAction {
  const reply: QuotesResponse = { underlyingSecurityId: underlying, requestedConIds: rows.map((r) => r.conId), rows };
  return { type: "quotes-reply", pullId, underlyingSecurityId: underlying, reply };
}

function computeReply(seq: number, rows: CandidateRow[]): CandidatesAction {
  return { type: "compute-reply", seq, reply: { rows } as unknown as CandidatesResponse };
}

/** Rows 101 and 102 quoted, figures for the current seq. */
function withFigures(): CandidatesState {
  let s = run(opened(), { type: "inputs-changed", key: "k1" }, pullReq(1, [101, 102]), pullReply(1, [quotedRow(101), quotedRow(102)]));
  s = run(s, { type: "compute-request", seq: s.computeSeq }, computeReply(s.computeSeq, [priced(101), priced(102)]));
  return s;
}

describe("compute replies (P15)", () => {
  it("T18 a compute reply for an older seq, or after inputs-changed, is never shown", () => {
    let s = run(opened(), { type: "inputs-changed", key: "k1" }, pullReq(1, [101]), pullReply(1, [quotedRow(101)]));
    const old = s.computeSeq;
    s = run(s, { type: "compute-request", seq: old }, { type: "inputs-changed", key: "k2" });
    expect(s.computeSeq).toBe(old + 1);
    s = run(s, computeReply(old, [priced(101)]));
    expect(s.rows[0].figures).toBeNull();
    expect(s.figuresSeq).toBeNull();
    s = run(s, computeReply(s.computeSeq, [priced(101)]));
    expect(s.rows[0].figures).not.toBeNull();
    expect(s.figuresSeq).toBe(s.computeSeq);
  });

  it("the same inputs key twice is not a revision", () => {
    const s = withFigures();
    expect(run(s, { type: "inputs-changed", key: "k1" })).toBe(s);
  });

  it("a budget change clears figures and bumps the seq", () => {
    const s = withFigures();
    const t = run(s, { type: "budget", text: "5000" });
    expect(t.computeSeq).toBe(s.computeSeq + 1);
    expect(t.rows.every((r) => r.figures === null)).toBe(true);
    expect(t.budgetUsdText).toBe("5000");
  });

  it("F1 a scope change (inputs-changed after a remount): rows, quotes and records kept, figures null, computeSeq bumped", () => {
    const s = withFigures();
    const t = run(s, { type: "inputs-changed", key: '{"scope":"ibkr"}' });
    expect(t.rows.map((r) => r.conId)).toEqual([101, 102]);
    expect(t.rows.map((r) => r.quote)).toEqual(s.rows.map((r) => r.quote));
    expect(t.rows.map((r) => r.record)).toEqual(s.rows.map((r) => r.record));
    expect(t.rows.every((r) => r.figures === null)).toBe(true);
    expect(t.computeSeq).toBe(s.computeSeq + 1);
  });

  it("F6 an old compute reply arriving after a refresh that replaced a quote is dropped; a refresh that replaced nothing leaves figures", () => {
    const s = withFigures();
    const seqBefore = s.computeSeq;
    // A refresh that the limiter refused for every contract: nothing replaced.
    const refused: QuoteRow = {
      conId: 101,
      status: "not-quoted",
      reason: "not-quoted-rate-limit",
      retryAfterSeconds: 20,
      sentence: "Not quoted: too many quotes in a minute.",
      bid: null,
      ask: null,
    };
    const kept = run(s, pullReq(5, [101], "refresh"), pullReply(5, [refused]));
    expect(kept.computeSeq).toBe(seqBefore);
    expect(kept.rows[0].figures).not.toBeNull();
    // A refresh that replaced a quote: figures cleared, and an old reply is dropped.
    let t = run(s, { type: "compute-request", seq: seqBefore }, pullReq(6, [102], "refresh"));
    t = run(t, pullReply(6, [quotedRow(102, quote({ bid: 3.0, ask: 3.2, mid: 3.1 }))]));
    expect(t.computeSeq).toBe(seqBefore + 1);
    expect(t.rows.every((r) => r.figures === null)).toBe(true);
    t = run(t, computeReply(seqBefore, [priced(101), priced(102)]));
    expect(t.rows.every((r) => r.figures === null)).toBe(true);
  });
});

describe("quote age (P15)", () => {
  it("T19 isOldQuote: 14:59 ago false, 15:00 true", () => {
    const at = "2026-11-25T19:00:00.000Z";
    expect(isOldQuote(at, new Date(Date.parse(at) + 14 * 60_000 + 59_000))).toBe(false);
    expect(isOldQuote(at, new Date(Date.parse(at) + 15 * 60_000))).toBe(true);
  });

  it("the quote line names the kind and the age", () => {
    const now = new Date("2026-11-25T19:40:00.000Z");
    expect(quoteAgeLine(quote(), now)).toBe("14:32, live");
    expect(quoteAgeLine(quote({ tickKind: "delayed" }), now)).toBe("14:32, delayed");
    expect(quoteAgeLine(quote({ session: "market-closed" }), new Date("2026-11-25T20:00:00.000Z"))).toBe(
      "14:32, market closed: last quote, old quote",
    );
  });
});

describe("stale chain and quote replies (D8)", () => {
  const expiriesReply = (u = ZZA, right: "put" | "call" = "put"): ChainResponse => ({
    kind: "expiries",
    underlyingSecurityId: u,
    right,
    expiries: ["2027-03-19"],
  });

  it("T29 chain and quote replies dropped after clear, remove, underlying change, right change, a newer pull for the same contract, and close; never recreate a row", () => {
    // Chain: a newer request wins; clear, close, an underlying or right change drop the reply.
    const chain = (s: CandidatesState, rev: number) =>
      run(s, { type: "chain-reply", revision: rev, underlyingSecurityId: ZZA, right: "put", reply: expiriesReply() });
    let s = run(opened(), { type: "chain-request", revision: 3 });
    expect(chain(s, 3).expiries).toEqual(["2027-03-19"]);
    expect(chain(run(s, { type: "chain-request", revision: 4 }), 3).expiries).toBeNull();
    expect(chain(run(s, { type: "clear" }), 3).expiries).toBeNull();
    expect(chain(run(s, { type: "close" }), 3).expiries).toBeNull();
    expect(chain(run(s, { type: "set-underlying", securityId: ZZQ }), 3).expiries).toBeNull();
    expect(chain(run(s, { type: "set-right", right: "call" }), 3).expiries).toBeNull();
    // A reply naming another underlying than asked is dropped.
    expect(
      run(s, { type: "chain-reply", revision: 3, underlyingSecurityId: ZZA, right: "put", reply: expiriesReply(ZZQ) }).expiries,
    ).toBeNull();

    // Quotes.
    s = run(opened(), pullReq(1, [101, 102]));
    const reply = pullReply(1, [quotedRow(101), quotedRow(102)]);
    // Clear: the reply never recreates the rows.
    expect(run(s, { type: "clear" }, reply).rows).toEqual([]);
    // Remove: the removed row stays removed; the other is answered.
    const removed = run(s, { type: "remove", conId: 101 }, reply);
    expect(removed.rows.map((r) => r.conId)).toEqual([102]);
    expect(removed.rows[0].quote).not.toBeNull();
    // Underlying, right change and close: the pull's placeholder rows go and the reply is dropped.
    for (const a of [
      { type: "set-underlying", securityId: ZZQ },
      { type: "set-right", right: "call" },
      { type: "close" },
    ] as CandidatesAction[]) {
      expect(run(s, a, reply).rows).toEqual([]);
    }
    // A newer pull for the same contract: the older reply is dropped, the newer one taken.
    const newer = run(s, pullReq(2, [101]));
    const afterOld = run(newer, reply);
    expect(afterOld.rows.find((r) => r.conId === 101)?.quote).toBeNull();
    expect(afterOld.rows.find((r) => r.conId === 102)?.quote).not.toBeNull();
    const fresh = quote({ bid: 2.9, ask: 3.1, mid: 3.0 });
    expect(run(afterOld, pullReply(2, [quotedRow(101, fresh)])).rows.find((r) => r.conId === 101)?.quote).toEqual(fresh);
  });

  it("nothing is asked for a closed section", () => {
    const s = run(withFigures(), { type: "close" });
    expect(run(s, pullReq(8, [101], "refresh"))).toBe(s);
  });

  it("a refresh never recreates a removed row", () => {
    const s = run(withFigures(), { type: "remove", conId: 101 });
    const t = run(s, pullReq(9, [101, 102], "refresh"), pullReply(9, [quotedRow(101), quotedRow(102)]));
    expect(t.rows.map((r) => r.conId)).toEqual([102]);
  });

  it("a whole-pull refusal drops the pull's new rows, keeps old quotes, and says why", () => {
    const s = withFigures();
    const t = run(s, pullReq(7, [101, 103]), {
      type: "quotes-failure",
      pullId: 7,
      conIds: [101, 103],
      message: "A sync is running. Try again in a moment.",
    });
    expect(t.rows.map((r) => r.conId)).toEqual([101, 102]);
    expect(t.rows[0].quote).toEqual(s.rows[0].quote);
    expect(t.pullProblem).toBe("A sync is running. Try again in a moment.");
    expect(t.pulls).toEqual({});
  });

  it("the table never holds more than 30 rows", () => {
    const ids = Array.from({ length: 15 }, (_, i) => 200 + i);
    let s = run(opened(), pullReq(1, ids), pullReq(2, ids.map((id) => id + 100)));
    expect(s.rows).toHaveLength(30);
    expect(pullProblem(s.rows, [999])).toMatch(/At most 30 rows/);
    s = run(s, pullReq(3, [999]));
    expect(s.rows).toHaveLength(30);
  });
});

describe("refresh (D4)", () => {
  it("D4 refreshBatches splits two underlyings and 20 rows of one into calls of at most 15, per underlying", () => {
    const a = Array.from({ length: 20 }, (_, i) => 300 + i);
    let s = run(opened(), pullReq(1, a.slice(0, 15)), pullReq(2, a.slice(15)), pullReq(3, [900, 901], "pull", ZZQ));
    const batches = refreshBatches(s.rows);
    expect(batches).toEqual([
      { underlyingSecurityId: ZZA, conIds: a.slice(0, 15) },
      { underlyingSecurityId: ZZA, conIds: a.slice(15) },
      { underlyingSecurityId: ZZQ, conIds: [900, 901] },
    ]);
    s = run(s, pullReply(3, [quotedRow(900)], ZZA));
    // A reply carrying the wrong underlying replaces nothing.
    expect(s.rows.find((r) => r.conId === 900)?.quote).toBeNull();
  });

  it("a row the limiter refused keeps its old quote and record and is flagged by age", () => {
    const s = withFigures();
    const old = s.rows[0];
    const t = run(
      s,
      pullReq(4, [101], "refresh"),
      pullReply(4, [
        {
          conId: 101,
          status: "not-quoted",
          reason: "not-quoted-rate-limit",
          retryAfterSeconds: 30,
          sentence: "Not quoted: too many quotes in a minute. Try again in 30 seconds.",
          bid: null,
          ask: null,
        },
      ]),
    );
    expect(t.rows[0].quote).toEqual(old.quote);
    expect(t.rows[0].record).toEqual(old.record);
    expect(t.rows[0].quoteProblem).toMatch(/too many quotes/);
    expect(quoteAgeLine(t.rows[0].quote!, new Date("2026-11-25T19:50:00.000Z"))).toMatch(/old quote$/);
  });

  it("a no-entry reply replaces the quote and drops the record", () => {
    const s = withFigures();
    const t = run(
      s,
      pullReq(4, [101], "refresh"),
      pullReply(4, [{ conId: 101, status: "no-entry", quote: quote(), refusal: "below-intrinsic", sentence: "No entry." }]),
    );
    expect(t.rows[0].record).toBeNull();
    expect(t.rows[0].quoteProblem).toBe("No entry.");
    expect(t.computeSeq).toBe(s.computeSeq + 1);
  });
});

describe("Add (P14, F2, F10)", () => {
  it("T17/F2 candidateToTrial equals, field for field, a hand-built TrialPositionState from the record (toStrictEqual), contracts = row contracts, brokerContractId kept", () => {
    const s = withFigures();
    const r = s.rows[0];
    const rec = record(101);
    const expected: TrialPositionState = {
      position: {
        kind: "option",
        underlyingSecurityId: ZZA,
        right: "put",
        side: "buy",
        expiry: "2027-03-19",
        strike: 95,
        contracts: 31,
        pricePaid: 3.2,
        entryUnderlyingPrice: 101.4,
        valuationPriceAtEntry: 100.9,
        entryVolatility: 0.31,
        brokerContractId: 101,
        id: "t-new",
      },
      symbol: "ZZA",
      name: "ZZA Holdings",
      holdingsAtAddByAccount: { 3: 2 },
      priceSource: "quote-mid",
      quote: {
        tickKind: "live",
        session: "regular-session",
        bid: 3.1,
        ask: 3.3,
        mid: 3.2,
        underlyingLast: 101.4,
        fetchedAt: "2026-11-25T19:32:10.000Z",
      },
      staleCloseDate: null,
      underlyingPrice: 101.4,
      underlyingPriceDate: "2026-11-25",
      underlyingPriceSource: "client-quote",
      appValuation: rec.appValuation,
    };
    const trial = candidateToTrial(
      { ...r, record: r.record!, quote: r.quote!, figures: r.figures as PricedCandidateRow },
      "t-new",
    );
    expect(trial).toStrictEqual(expected);
  });

  const blockedCases: [string, () => { row: CandidateRowState; s: CandidatesState; trials: number }][] = [
    ["no-entry", () => {
      const s = withFigures();
      return { row: { ...s.rows[0], record: null }, s, trials: 0 };
    }],
    ["refused", () => {
      const s = withFigures();
      const figures: CandidateRow = {
        conId: 101,
        status: "refused",
        refusal: "expired",
        contracts: 31,
        perContractUsd: 320,
        quote: { ...quote(), source: "client-supplied" },
      };
      return { row: { ...s.rows[0], figures }, s, trials: 0 };
    }],
    ["zero-contracts", () => {
      const s = withFigures();
      const figures: CandidateRow = {
        conId: 101,
        status: "zero-contracts",
        perContractUsd: 320,
        quote: { ...quote(), source: "client-supplied" },
      };
      return { row: { ...s.rows[0], figures }, s, trials: 0 };
    }],
    ["figures-not-current", () => {
      // Figures from an older seq: the state has moved on.
      const s = withFigures();
      return { row: s.rows[0], s: { ...s, computeSeq: s.computeSeq + 1 }, trials: 0 };
    }],
    ["trial-limit", () => {
      const s = withFigures();
      return { row: s.rows[0], s, trials: 12 };
    }],
  ];
  it.each(blockedCases)("F10 Add blocked: %s", (reason, make) => {
    const { row, s, trials } = make();
    const blocked = candidateAddBlocked(row, s, s.figuresSeq, trials);
    expect(blocked?.reason).toBe(reason);
    if (reason === "trial-limit") expect(blocked?.text).toBe(TRIAL_LIMIT_TEXT);
    if (reason === "zero-contracts") expect(blocked?.text).toBe(ZERO_CONTRACTS_TEXT);
  });

  it("F10 Add blocked while computing: figures null", () => {
    const s = run(withFigures(), { type: "budget", text: "5000" }, { type: "compute-request", seq: 99 });
    expect(candidateAddBlocked(s.rows[0], s, s.figuresSeq, 0)?.reason).toBe("figures-not-current");
  });

  it("F10 Add allowed for a priced, current row with contracts > 0 and 11 trials", () => {
    const s = withFigures();
    expect(candidateAddBlocked(s.rows[0], s, s.figuresSeq, 11)).toBeNull();
  });
});

describe("defaults and words", () => {
  const list: CandidateUnderlyingEntry[] = [
    { securityId: ZZA, symbol: "ZZA", name: null, reasons: ["driver-list"] },
    { securityId: 50, symbol: "QQQ", name: null, reasons: ["index"] },
  ];
  const entry = (securityId: number | null, symbol: string): SingleNameDriverEntry => ({
    symbol,
    name: null,
    securityId,
    reasons: ["held"],
    hasContractId: securityId !== null,
  });

  it("F8 defaultCandidateUnderlying: the single-name driver's row; the index driver's row; null when the driver is not listed", () => {
    expect(defaultCandidateUnderlying(list, { kind: "single-name", entry: entry(ZZA, "ZZA") }, "QQQ")).toBe(ZZA);
    expect(defaultCandidateUnderlying(list, { kind: "index" }, "QQQ")).toBe(50);
    expect(defaultCandidateUnderlying(list, { kind: "index" }, "SPY")).toBeNull();
    // Review focus 2: a driver held only through options, with no securities row.
    expect(defaultCandidateUnderlying(list, { kind: "single-name", entry: entry(null, "ZZX") }, "QQQ")).toBeNull();
    expect(driverNotListedNote(list, { kind: "single-name", entry: entry(null, "ZZX") })).toMatch(/^ZZX has no broker contract/);
    expect(driverNotListedNote(list, { kind: "index" })).toBeNull();
  });

  it("P22 no default sort (none keeps request order); rows with no figures sort last under every picked column", () => {
    let s = run(opened(), { type: "inputs-changed", key: "k" }, pullReq(1, [101, 102, 103, 104]));
    s = run(s, pullReply(1, [quotedRow(101), quotedRow(102), quotedRow(103), { conId: 104, status: "no-entry", quote: quote(), refusal: "expired", sentence: "x" }]));
    s = run(
      s,
      computeReply(s.computeSeq, [
        priced(101, { costUsd: 9000, contracts: 40 }, { atSelectedMoveUsd: 300, atZeroMoveUsd: -10, crossing: { kind: "pays-beyond", move: -0.2 } }),
        { conId: 102, status: "zero-contracts", perContractUsd: 12000, quote: { ...quote(), source: "client-supplied" } },
        priced(103, { costUsd: 8000, contracts: 50 }, { atSelectedMoveUsd: 900, atZeroMoveUsd: -50, crossing: { kind: "pays-beyond", move: -0.05 } }),
      ]),
    );
    const ids = (key: Parameters<typeof sortCandidateRows>[1]) => sortCandidateRows(s.rows, key, "measured").map((r) => r.conId);
    expect(ids("none")).toEqual([101, 102, 103, 104]);
    expect(ids("cost")).toEqual([103, 101, 102, 104]);
    expect(ids("contracts")).toEqual([101, 103, 102, 104]);
    expect(ids("atSelected")).toEqual([101, 103, 102, 104]);
    expect(ids("atZero")).toEqual([103, 101, 102, 104]);
    expect(ids("crossing")).toEqual([103, 101, 102, 104]);
    expect(ids("costShare")).toEqual([103, 101, 102, 104]);
    // The input is untouched.
    expect(s.rows.map((r) => r.conId)).toEqual([101, 102, 103, 104]);
  });

  it("D5 crossingHeading and candidateCrossingText name the direction; heldUnchangedNote", () => {
    expect(crossingHeading("fall", "ZZA")).toBe("Pays once ZZA falls past");
    expect(crossingHeading("rise", "ZZA")).toBe("Pays once ZZA rises past");
    const sn = { kind: "single-name" as const, entry: entry(ZZA, "ZZA") };
    expect(headingDirection(sn, 0.2)).toBe("rise");
    expect(headingDirection(sn, 0)).toBe("fall");
    expect(headingDirection({ kind: "index" }, 0.2)).toBe("fall");
    expect(candidateCrossingText(crossingCase(), "ZZA")).toBe("ZZA -6.1%");
    expect(candidateCrossingText(crossingCase({ crossing: { kind: "pays-beyond", move: 0.09 }, crossingDirection: "rise" }), "ZZA")).toBe(
      "ZZA +9%",
    );
    expect(candidateCrossingText(crossingCase({ crossing: { kind: "worse-at-every-move", deepestMove: -0.4 } }), "ZZA")).toBe(
      "does not pay within the moves shown",
    );
    expect(candidateCrossingText(crossingCase({ crossing: { kind: "better-at-every-move" }, crossingDirection: "rise" }), "ZZA")).toBe(
      "at every rise shown",
    );
    expect(heldUnchangedNote("ZZQ")).toBe("ZZQ is held unchanged in this run, so this row shows cost only.");
  });

  it("P13a a held-unchanged row carries the note from the reply's flag", () => {
    let s = run(opened(), { type: "inputs-changed", key: "k" }, pullReq(1, [101]), pullReply(1, [quotedRow(101)]));
    s = run(s, computeReply(s.computeSeq, [priced(101, {}, { heldUnchanged: true, beta: 0 })]));
    const cells = candidateCells(s.rows[0], "measured", gain(400_000), "ZZB");
    expect(cells.kind === "priced" && cells.heldUnchangedText).toBe(heldUnchangedNote("ZZA"));
  });

  it("cells: zero contracts reads the sentence with no figures; cost share by the year's gain", () => {
    let s = run(opened(), { type: "inputs-changed", key: "k" }, pullReq(1, [101]), pullReply(1, [quotedRow(101)]));
    s = run(s, computeReply(s.computeSeq, [{ conId: 101, status: "zero-contracts", perContractUsd: 320, quote: { ...quote(), source: "client-supplied" } }]));
    expect(candidateCells(s.rows[0], "measured", gain(400_000), "ZZA")).toEqual({
      kind: "zero-contracts",
      perContractUsd: 320,
      text: ZERO_CONTRACTS_TEXT,
    });
    expect(candidateCostShareOfGain(10_000, gain(400_000))).toBeCloseTo(0.025, 12);
    expect(candidateCostShareOfGain(10_000, gain(-5))).toBeNull();
  });

  it("the budget box takes whole cents above 0 and at most the bound", () => {
    expect(parseBudgetText("45.00")).toEqual({ usd: 45 });
    expect(parseBudgetText("10000000")).toEqual({ usd: 10_000_000 });
    for (const bad of ["", "0", "-5", "12.345", "10000000.01", "abc"]) expect("problem" in parseBudgetText(bad)).toBe(true);
  });

  it("the per-contract price is exact (D9): mid 0.15 is $15, mid 0.475 is $47.50", () => {
    expect(perContractUsdOf({ bid: 0.1, ask: 0.2 })).toBe(15);
    expect(perContractUsdOf({ bid: 0.4, ask: 0.55 })).toBe(47.5);
  });

  it("the not-stored footer", () => {
    expect(CANDIDATES_NOT_STORED_NOTE).toBe("Quotes come from the broker. Nothing is stored. Nothing is traded from this page.");
  });
});

describe("requests", () => {
  const controls = (over: Partial<GainsControls> = {}): GainsControls => ({
    driverSymbol: "QQQ",
    driver: { kind: "index" },
    valuationDate: "2026-12-31",
    volChangePoints: 0,
    custom: null,
    priceOverrides: {},
    betaOverrides: { 4: 1.2 },
    ...over,
  });

  it("the compute body: index mode carries the selected move and the owner's figures", () => {
    const body = candidatesBaseBody({ scope: "all", controls: controls(), selectedMove: -0.1, trialPositions: [] });
    expect(body).not.toBeNull();
    expect(body!.selectedMove).toBe(-0.1);
    expect(body!.moves).toContain(-0.1);
    expect(body!.betaOverrides).toEqual({ 4: 1.2 });
    expect("driver" in body!).toBe(false);
    expect("trialPositions" in body!).toBe(false);
  });

  it("the compute body: single-name mode drops the owner's figures and names the driver", () => {
    const entry: SingleNameDriverEntry = { symbol: "ZZA", name: null, securityId: ZZA, reasons: ["held"], hasContractId: true };
    const body = candidatesBaseBody({
      scope: "vanguard",
      controls: controls({ driver: { kind: "single-name", entry } }),
      selectedMove: 0.2,
      trialPositions: [],
    });
    expect(body!.driver).toEqual({ kind: "single-name", securityId: ZZA });
    expect("betaOverrides" in body!).toBe(false);
    expect(body!.selectedMove).toBe(0.2);
  });

  it("the compute body is null when the selected move is not one of the moves", () => {
    expect(candidatesBaseBody({ scope: "all", controls: controls(), selectedMove: -0.37, trialPositions: [] })).toBeNull();
  });

  it("candidate items: only rows with a quote and an entry, each in call 1's shape", () => {
    let s = run(opened(), pullReq(1, [101, 102]));
    s = run(s, pullReply(1, [quotedRow(101), { conId: 102, status: "no-entry", quote: quote(), refusal: "expired", sentence: "x" }]));
    const items = candidateRequestItems(s.rows);
    expect(items.map((i) => i.conId)).toEqual([101]);
    expect(items[0].entry.brokerContractId).toBe(101);
    expect(items[0].entry.pricePaid).toBe(items[0].quote.mid);
    expect(items[0].tradingClass).toBe("ZZA");
  });

  it("the chosen strikes become quote-body contracts, defaults capped at 15", () => {
    const contracts = (base: number) =>
      Array.from({ length: 8 }, (_, i) => ({ conId: base + i, strike: 80 + i, tradingClass: "ZZA", multiplier: 100 as const }));
    const reply: ChainResponse = {
      kind: "strikes",
      underlyingSecurityId: ZZA,
      right: "put",
      valuationPrice: 90,
      byExpiry: ["2027-01-15", "2027-02-19", "2027-03-19"].map((expiry, k) => ({
        expiry,
        contracts: contracts(1000 * (k + 1)),
        defaultConIds: contracts(1000 * (k + 1)).slice(0, 6).map((c) => c.conId),
        droppedNonStandard: 0,
        droppedAmbiguous: 0,
      })),
    };
    let s = run(opened(), { type: "chain-request", revision: 2, expiries: ["2027-01-15"] });
    s = run(s, { type: "chain-reply", revision: 2, underlyingSecurityId: ZZA, right: "put", reply });
    expect(s.chosenConIds).toHaveLength(15);
    const body = chosenBatchContracts(s);
    expect(body).toHaveLength(15);
    expect(body[0]).toEqual({ conId: 1000, right: "put", expiry: "2027-01-15", strike: 80, multiplier: 100, tradingClass: "ZZA" });
    // Choosing more than 15 keeps 15; an id the chain did not offer is ignored.
    s = run(s, { type: "choose", conIds: [...s.chosenConIds, 3007, 424242] });
    expect(s.chosenConIds).toHaveLength(15);
  });
});
