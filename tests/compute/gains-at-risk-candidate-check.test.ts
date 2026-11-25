import { describe, it, expect } from "vitest";
import {
  candidateItemProblem,
  candidatesProblem,
  type CandidateRequestItem,
} from "@/lib/compute/gains-at-risk-candidate-check";
import { CANDIDATE_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";

// Gains at risk step 3 (D3, F4): call 2's own validator. Synthetic contract
// ids and invented prices only.

function item(over: { conId?: number } = {}): CandidateRequestItem {
  const conId = over.conId ?? 7001;
  return {
    conId,
    underlyingSecurityId: 42,
    right: "put",
    expiry: "2027-02-19",
    strike: 95,
    multiplier: 100,
    tradingClass: "ZZA",
    quote: {
      bid: 0.1,
      ask: 0.2,
      mid: 0.15,
      tickKind: "live",
      session: "regular-session",
      optionObservedAt: "2026-11-10T15:00:05.000Z",
      underlyingObservedAt: "2026-11-10T15:00:00.000Z",
      underlyingPrice: 101.4,
    },
    entry: {
      kind: "option",
      underlyingSecurityId: 42,
      right: "put",
      side: "buy",
      expiry: "2027-02-19",
      strike: 95,
      contracts: 1,
      pricePaid: 0.15,
      entryUnderlyingPrice: 101.4,
      valuationPriceAtEntry: 100,
      entryVolatility: 0.3,
      brokerContractId: conId,
    },
  };
}

/** A deep copy with one dotted path set. */
function withField(path: string, value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(item())) as Record<string, unknown>;
  const parts = path.split(".");
  let at = copy;
  for (const p of parts.slice(0, -1)) at = at[p] as Record<string, unknown>;
  at[parts[parts.length - 1]] = value;
  return copy;
}

describe("candidateItemProblem (T26, D3)", () => {
  it("accepts a well-formed candidate", () => {
    expect(candidateItemProblem(item(), 0)).toBeNull();
    expect(candidatesProblem([item(), item({ conId: 7002 })])).toBeNull();
  });

  it.each<[string, string, unknown]>([
    ["a written option", "entry.side", "write"],
    ["right 'x'", "right", "x"],
    ["bid 0", "quote.bid", 0],
    ["bid > ask", "quote.bid", 0.3],
    ["bid 0.12345 (off the grid)", "quote.bid", 0.12345],
    ["ask off the grid", "quote.ask", 0.20001],
    ["mid 0.16 for 0.10/0.20", "quote.mid", 0.16],
    ["pricePaid !== mid", "entry.pricePaid", 0.14],
    ["entry strike differs", "entry.strike", 90],
    ["entry expiry differs", "entry.expiry", "2027-03-19"],
    ["entry brokerContractId differs", "entry.brokerContractId", 7999],
    ["entry underlying differs", "entry.underlyingSecurityId", 43],
    ["entry right differs", "entry.right", "call"],
    ["multiplier 10", "multiplier", 10],
    ["an empty tradingClass", "tradingClass", " "],
    ["conId 0", "conId", 0],
    ["conId 1.5", "conId", 1.5],
    ["entry contracts 0", "entry.contracts", 0],
    ["tickKind other", "quote.tickKind", "model"],
    ["session other", "quote.session", "pre-market"],
    ["option arrival unreadable", "quote.optionObservedAt", "soon"],
    ["underlying 31 s before the option", "quote.underlyingObservedAt", "2026-11-10T14:59:34.000Z"],
  ])("T26 refuses %s naming the field", (_label, field, value) => {
    const problem = candidateItemProblem(withField(field, value), 3);
    expect(problem).not.toBeNull();
    expect(problem).toContain(`candidates[3].${field}`);
  });

  it("refuses something that is not an object", () => {
    expect(candidateItemProblem(null, 0)).toContain("candidates[0]");
    expect(candidateItemProblem([], 0)).toContain("candidates[0]");
  });

  it.each<[string, unknown]>([
    ["entry.strike", 0],
    ["entry.strike", 100_001],
    ["entry.expiry", "2027-02-30"],
    ["entry.expiry", "20270219"],
    ["entry.entryUnderlyingPrice", 0],
    ["entry.entryUnderlyingPrice", 100_001],
    ["entry.valuationPriceAtEntry", 0],
    ["entry.valuationPriceAtEntry", -1],
    ["entry.entryVolatility", 0],
    ["entry.entryVolatility", 10.01],
    ["entry.pricePaid", 100_001],
    ["quote.underlyingPrice", 0],
    ["quote.bid", 1e12], // (bid + ask) x 50 not a safe integer
    ["entry.entryUnderlyingPrice", 150], // F5/P13: not the quote's own underlying (101.4)
    ["entry.entryUnderlyingPrice", 101.41],
  ])("F4 refuses %s = %o with a sentence naming candidates[0].%s", (field, value) => {
    const problem = candidateItemProblem(withField(field, value), 0);
    expect(problem).not.toBeNull();
    expect(problem).toContain(`candidates[0].${field}`);
  });

  it("F4 every scaled product must be a safe integer: a huge locked quote is refused, never sized", () => {
    const big = withField("quote.bid", 1e12) as CandidateRequestItem;
    big.quote.ask = 1e12;
    big.quote.mid = 1e12;
    big.entry.pricePaid = 1e12;
    expect(candidateItemProblem(big, 0)).toContain("candidates[0].quote.bid");
  });

  it("T26 accepts a locked quote (bid === ask) and an odd-unit half-unit mid", () => {
    const locked = withField("quote.ask", 0.1) as CandidateRequestItem;
    locked.quote.mid = 0.1;
    locked.entry.pricePaid = 0.1;
    expect(candidateItemProblem(locked, 0)).toBeNull();
    // bid 1 unit, ask 2 units: the mid is a half unit (0.00015), exact on the 1/20,000 grid.
    const half = withField("quote.bid", 0.0001) as CandidateRequestItem;
    half.quote.ask = 0.0002;
    half.quote.mid = 0.00015;
    half.entry.pricePaid = 0.00015;
    expect(candidateItemProblem(half, 0)).toBeNull();
  });
});

describe("F5/P13 the entry is solved at the quote's own underlying", () => {
  it("accepts an entry underlying equal to the quote's, refuses one a hundredth of a cent off", () => {
    expect(candidateItemProblem(item(), 0)).toBeNull();
    expect(candidateItemProblem(withField("entry.entryUnderlyingPrice", 101.4001), 0)).toContain("candidates[0].entry.entryUnderlyingPrice");
    // The same price written through float arithmetic is still equal in scaled units.
    expect(candidateItemProblem(withField("entry.entryUnderlyingPrice", 101.3 + 0.1), 0)).toBeNull();
  });
});

describe("candidatesProblem", () => {
  it("refuses a non-list, an empty list, a duplicate conId and 31 items", () => {
    expect(candidatesProblem({})).toContain("candidates");
    expect(candidatesProblem([])).toContain("candidates");
    expect(candidatesProblem([item(), item()])).toContain("candidates[1].conId");
    const many = Array.from({ length: CANDIDATE_BOUNDS.maxCandidates + 1 }, (_, i) => item({ conId: 8000 + i }));
    expect(candidatesProblem(many)).toContain(`at most ${CANDIDATE_BOUNDS.maxCandidates}`);
    expect(candidatesProblem(many.slice(0, CANDIDATE_BOUNDS.maxCandidates))).toBeNull();
  });

  it("names the first bad item by its index", () => {
    expect(candidatesProblem([item(), withField("quote.mid", 0.16)])).toContain("candidates[1].quote.mid");
  });
});
