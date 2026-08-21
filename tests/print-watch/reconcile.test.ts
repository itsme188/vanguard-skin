import { describe, it, expect } from "vitest";
import { reconcile } from "@/lib/print-watch/reconcile";
import type { LineContract, ExpectedValue, TaggedCandidate, PrintWatchLine } from "@/lib/print-watch/types";

function makeContract(metricId: string, overrides: Partial<LineContract> = {}): LineContract {
  return {
    metric_id: metricId,
    label: "EPS (Adj.)",
    definition: "Adjusted diluted EPS",
    basis: "non_gaap",
    period: "Q",
    currency: "USD",
    unit: "per_share",
    kind: "point",
    segment: null,
    ...overrides,
  };
}

function makeExpected(overrides: Partial<ExpectedValue> = {}): ExpectedValue {
  return { value: 1.5, value_high: null, whisper: null, source_label: "consensus", ...overrides };
}

function makeCandidate(overrides: Partial<TaggedCandidate> = {}): TaggedCandidate {
  return {
    metric_id: "eps_adj",
    value: 1.5,
    value_high: null,
    raw_text: "$1.50",
    snippet: "Adjusted EPS of $1.50",
    location_hint: null,
    not_disclosed: false,
    doc_id: 1,
    representation: "repA",
    weak_pair: false,
    ...overrides,
  };
}

function reconcileOne(
  contract: LineContract,
  candidates: TaggedCandidate[],
  opts: { expected?: Record<string, ExpectedValue>; accepted?: PrintWatchLine[] } = {},
): PrintWatchLine {
  const lines = reconcile([contract], opts.expected ?? {}, candidates, opts.accepted ?? []);
  expect(lines).toHaveLength(1);
  return lines[0];
}

describe("reconcile", () => {
  it("cross-doc agreement (dj-release + edgar) -> agreed", () => {
    const contract = makeContract("eps_adj");
    const dj = makeCandidate({ doc_id: 1, representation: "repA", value: 1.5, snippet: "DJ says 1.50" });
    const edgar = makeCandidate({ doc_id: 2, representation: "repA", value: 1.5, snippet: "EDGAR says 1.50" });
    const line = reconcileOne(contract, [dj, edgar]);

    expect(line.state).toBe("agreed");
    expect(line.value).toBe(1.5);
    expect(line.source_doc_id).toBe(1); // lowest doc_id among agreeing candidates
    expect(line.snippet).toBe("DJ says 1.50");
    expect(JSON.parse(line.candidates_json)).toHaveLength(2);
  });

  it("same-doc A/B agreement (repA vs repB, weak_pair=false) -> agreed", () => {
    const contract = makeContract("eps_adj");
    const repA = makeCandidate({ doc_id: 5, representation: "repA", weak_pair: false, value: 2.02 });
    const repB = makeCandidate({ doc_id: 5, representation: "repB", weak_pair: false, value: 2.02 });
    const line = reconcileOne(contract, [repA, repB]);

    expect(line.state).toBe("agreed");
    expect(line.value).toBe(2.02);
    expect(line.source_doc_id).toBe(5);
  });

  it("weak_pair duplicates alone (same doc, differing representation, weak_pair=true, matching value) -> single_source", () => {
    const contract = makeContract("eps_adj");
    const a = makeCandidate({ doc_id: 7, representation: "repA", weak_pair: true, value: 1.91 });
    const b = makeCandidate({ doc_id: 7, representation: "repB", weak_pair: true, value: 1.91 });
    const line = reconcileOne(contract, [a, b]);

    expect(line.state).toBe("single_source");
    expect(line.value).toBe(1.91);
    expect(line.source_doc_id).toBe(7);
  });

  it("weak_pair duplicates that DISAGREE -> conflict (not single_source)", () => {
    const contract = makeContract("eps_adj");
    const a = makeCandidate({ doc_id: 7, representation: "repA", weak_pair: true, value: 1.91 });
    const b = makeCandidate({ doc_id: 7, representation: "repB", weak_pair: true, value: 2.5 });
    const line = reconcileOne(contract, [a, b]);

    expect(line.state).toBe("conflict");
    expect(line.value).toBeNull();
    expect(JSON.parse(line.candidates_json)).toHaveLength(2);
  });

  it("AMZN TTM FCF: -7,604,000,000 (table) vs -7,600,000,000 (prose), 0.05% apart -> conflict under 1e-6 relative tolerance", () => {
    const contract = makeContract("fcf_ttm", { unit: "usd", label: "Free Cash Flow (TTM)" });
    const table = makeCandidate({
      metric_id: "fcf_ttm",
      doc_id: 3,
      representation: "repA",
      value: -7604000000,
      raw_text: "(7,604)",
      location_hint: "Table 4",
      snippet: "Free cash flow ... $(7,604) million",
    });
    const prose = makeCandidate({
      metric_id: "fcf_ttm",
      doc_id: 3,
      representation: "repB",
      value: -7600000000,
      raw_text: "($7.6 billion)",
      location_hint: null,
      snippet: "free cash flow of negative $7.6 billion",
    });
    const line = reconcileOne(contract, [table, prose]);

    expect(line.state).toBe("conflict");
    expect(line.value).toBeNull();
    const stored = JSON.parse(line.candidates_json) as TaggedCandidate[];
    expect(stored).toHaveLength(2);
    expect(stored.map((c) => c.value)).toEqual(expect.arrayContaining([-7604000000, -7600000000]));
  });

  it("table-hint mismatch, SAME doc -> conflict (matching value, incompatible provenance)", () => {
    const contract = makeContract("revenue_segment", { unit: "usd" });
    const a = makeCandidate({
      metric_id: "revenue_segment",
      doc_id: 9,
      representation: "repA",
      weak_pair: false,
      value: 42200000000,
      location_hint: "Table 2, row 3",
    });
    const b = makeCandidate({
      metric_id: "revenue_segment",
      doc_id: 9,
      representation: "repB",
      weak_pair: false,
      value: 42200000000,
      location_hint: "Table 5, row 1",
    });
    const line = reconcileOne(contract, [a, b]);

    expect(line.state).toBe("conflict");
    expect(line.value).toBeNull();
  });

  it("table-hint mismatch, CROSS-doc -> hints ignored, still agreed", () => {
    const contract = makeContract("revenue_segment", { unit: "usd" });
    const a = makeCandidate({
      metric_id: "revenue_segment",
      doc_id: 1,
      representation: "repA",
      value: 42200000000,
      location_hint: "Table 2",
    });
    const b = makeCandidate({
      metric_id: "revenue_segment",
      doc_id: 2,
      representation: "repA",
      value: 42200000000,
      location_hint: "Table 9",
    });
    const line = reconcileOne(contract, [a, b]);

    expect(line.state).toBe("agreed");
    expect(line.value).toBe(42200000000);
    expect(line.source_doc_id).toBe(1);
  });

  it("ND from supplement + value from release -> value survives at its own agreement level (single_source)", () => {
    const contract = makeContract("guidance_rev_low", { period: "NQ_guide" });
    const value = makeCandidate({
      metric_id: "guidance_rev_low",
      doc_id: 1,
      representation: "repA",
      value: 5000000000,
      not_disclosed: false,
    });
    const nd = makeCandidate({
      metric_id: "guidance_rev_low",
      doc_id: 2,
      representation: "repA",
      value: null,
      raw_text: null,
      snippet: null,
      not_disclosed: true,
    });
    const line = reconcileOne(contract, [value, nd]);

    expect(line.state).toBe("single_source");
    expect(line.value).toBe(5000000000);
    expect(line.source_doc_id).toBe(1);
    // both candidates preserved in the audit trail
    expect(JSON.parse(line.candidates_json)).toHaveLength(2);
  });

  it("ND from supplement + TWO agreeing value docs -> still agreed (ND never blocks agreement)", () => {
    const contract = makeContract("guidance_rev_low", { period: "NQ_guide" });
    const v1 = makeCandidate({ metric_id: "guidance_rev_low", doc_id: 1, representation: "repA", value: 5000000000 });
    const v2 = makeCandidate({ metric_id: "guidance_rev_low", doc_id: 2, representation: "repA", value: 5000000000 });
    const nd = makeCandidate({
      metric_id: "guidance_rev_low",
      doc_id: 3,
      representation: "repA",
      value: null,
      raw_text: null,
      snippet: null,
      not_disclosed: true,
    });
    const line = reconcileOne(contract, [v1, v2, nd]);

    expect(line.state).toBe("agreed");
    expect(line.value).toBe(5000000000);
  });

  it("all-ND across two independent docs -> blank", () => {
    const contract = makeContract("segment_x");
    const nd1 = makeCandidate({
      metric_id: "segment_x",
      doc_id: 1,
      representation: "repA",
      value: null,
      raw_text: null,
      snippet: null,
      not_disclosed: true,
    });
    const nd2 = makeCandidate({
      metric_id: "segment_x",
      doc_id: 2,
      representation: "repA",
      value: null,
      raw_text: null,
      snippet: null,
      not_disclosed: true,
    });
    const line = reconcileOne(contract, [nd1, nd2]);

    expect(line.state).toBe("blank");
    expect(line.value).toBeNull();
  });

  it("all-ND from a single doc so far -> pending", () => {
    const contract = makeContract("segment_x");
    const nd1 = makeCandidate({
      metric_id: "segment_x",
      doc_id: 1,
      representation: "repA",
      value: null,
      raw_text: null,
      snippet: null,
      not_disclosed: true,
    });
    const nd2 = makeCandidate({
      metric_id: "segment_x",
      doc_id: 1,
      representation: "repB",
      value: null,
      raw_text: null,
      snippet: null,
      not_disclosed: true,
    });
    const line = reconcileOne(contract, [nd1, nd2]);

    expect(line.state).toBe("pending");
    expect(line.value).toBeNull();
  });

  it("no candidates at all yet -> pending", () => {
    const contract = makeContract("eps_adj");
    const line = reconcileOne(contract, []);

    expect(line.state).toBe("pending");
    expect(line.value).toBeNull();
    expect(line.candidates_json).toBe("[]");
  });

  it("flash candidates only -> flash, with earliest evidence reported provisionally", () => {
    const contract = makeContract("revenue_q_guide", { period: "NQ_guide" });
    const flash1 = makeCandidate({
      metric_id: "revenue_q_guide",
      doc_id: 4,
      representation: "flash",
      value: 3000000000,
      snippet: "* Flash: revenue guide $3.0B",
    });
    const flash2 = makeCandidate({
      metric_id: "revenue_q_guide",
      doc_id: 6,
      representation: "flash",
      value: 3000000000,
      snippet: "* Flash (dup wire): $3.0B",
    });
    const line = reconcileOne(contract, [flash1, flash2]);

    expect(line.state).toBe("flash");
    expect(line.value).toBe(3000000000);
    expect(line.source_doc_id).toBe(4); // lowest doc_id
  });

  it("flash never greens even when it numerically matches an independent value candidate", () => {
    const contract = makeContract("eps_adj");
    const flash = makeCandidate({ doc_id: 1, representation: "flash", value: 1.5 });
    const release = makeCandidate({ doc_id: 2, representation: "repA", value: 1.5 });
    const line = reconcileOne(contract, [flash, release]);

    // Flash is excluded from the reconciliation pool once a real document
    // exists — this is a single value-candidate, so single_source.
    expect(line.state).toBe("single_source");
    expect(line.value).toBe(1.5);
    expect(line.source_doc_id).toBe(2);
  });

  it("accepted lines pass through untouched except candidates_json refresh", () => {
    const contract = makeContract("eps_adj");
    const accepted: PrintWatchLine = {
      metric_id: "eps_adj",
      contract: makeContract("eps_adj", { label: "STALE LABEL" }),
      expected: makeExpected({ value: 999 }),
      state: "accepted",
      value: 42,
      value_high: null,
      snippet: "accepted snippet",
      source_doc_id: 99,
      candidates_json: "[]",
    };
    // New, CONFLICTING evidence arrives after acceptance — must not move
    // any locked field.
    const newConflicting = makeCandidate({ doc_id: 1, representation: "repA", value: 7.77 });
    const line = reconcileOne(contract, [newConflicting], { accepted: [accepted] });

    expect(line.state).toBe("accepted");
    expect(line.value).toBe(42);
    expect(line.value_high).toBeNull();
    expect(line.snippet).toBe("accepted snippet");
    expect(line.source_doc_id).toBe(99);
    expect(line.contract.label).toBe("STALE LABEL");
    expect(line.expected?.value).toBe(999);
    // Only candidates_json refreshes to the latest full set.
    expect(JSON.parse(line.candidates_json)).toHaveLength(1);
    expect(JSON.parse(line.candidates_json)[0].value).toBe(7.77);
  });

  it("sign guard: a positive value whose raw_text is parenthesized is dropped as malformed", () => {
    const contract = makeContract("eps_adj");
    const malformed = makeCandidate({ doc_id: 1, representation: "repA", value: 1234, raw_text: "(1,234)" });
    const line = reconcileOne(contract, [malformed]);

    expect(line.state).toBe("pending"); // the only candidate was dropped
    expect(line.candidates_json).toBe("[]");
  });

  it("sign guard: a genuinely negative parenthesized value is NOT dropped", () => {
    const contract = makeContract("eps_adj");
    const valid = makeCandidate({ doc_id: 1, representation: "repA", value: -1234, raw_text: "(1,234)" });
    const line = reconcileOne(contract, [valid]);

    expect(line.state).toBe("single_source");
    expect(line.value).toBe(-1234);
  });

  it("sign guard: unparenthesized raw_text never triggers the guard, positive or negative", () => {
    const contract = makeContract("eps_adj");
    // Positive value with NO parens at all — this is the case that
    // actually exercises the "no parenthesized token found" path (a
    // negative value short-circuits the guard before parens are even
    // examined, so that alone wouldn't prove this).
    const posNoParens = makeCandidate({ doc_id: 1, representation: "repA", value: 1234, raw_text: "1,234" });
    const line = reconcileOne(contract, [posNoParens]);

    expect(line.state).toBe("single_source");
    expect(line.value).toBe(1234);

    const negNoParens = makeCandidate({ doc_id: 1, representation: "repA", value: -1234, raw_text: "-1,234" });
    const line2 = reconcileOne(contract, [negNoParens]);
    expect(line2.state).toBe("single_source");
    expect(line2.value).toBe(-1234);
  });

  it("sign guard round-1 fix: a footnote marker in parens does NOT contradict an unrelated positive value", () => {
    // Reviewer repro: "Diluted EPS $1.50(1)" — the "(1)" is a footnote
    // reference, not a negative-number assertion about 1.50.
    const contract = makeContract("eps_adj");
    const c = makeCandidate({
      doc_id: 1,
      representation: "repA",
      value: 1.5,
      raw_text: "Diluted EPS $1.50(1)",
    });
    const line = reconcileOne(contract, [c]);

    expect(line.state).toBe("single_source");
    expect(line.value).toBe(1.5);
  });

  it("sign guard round-1 fix: a parenthesized year does NOT contradict an unrelated positive value", () => {
    // Reviewer repro: "$1.50 (2024)".
    const contract = makeContract("eps_adj");
    const c = makeCandidate({
      doc_id: 1,
      representation: "repA",
      value: 1.5,
      raw_text: "$1.50 (2024)",
    });
    const line = reconcileOne(contract, [c]);

    expect(line.state).toBe("single_source");
    expect(line.value).toBe(1.5);
  });

  it("sign guard round-2 fix: whole-cell \"(7,604)\" with value +7,604,000,000 is dropped", () => {
    // Ruling item 1 — bare whole-cell parenthesized number, no currency.
    const contract = makeContract("fcf_ttm", { unit: "usd" });
    const c = makeCandidate({
      metric_id: "fcf_ttm",
      doc_id: 1,
      representation: "repA",
      value: 7604000000, // should have been negative given the parens
      raw_text: "(7,604)",
    });
    const line = reconcileOne(contract, [c]);

    expect(line.state).toBe("pending"); // dropped — the only candidate
    expect(line.candidates_json).toBe("[]");
  });

  it("sign guard round-2 fix: whole-cell \"$(7,604)\" with value +7,604,000,000 is dropped", () => {
    // Ruling item 2 — whole-cell with a leading currency symbol.
    const contract = makeContract("fcf_ttm", { unit: "usd" });
    const c = makeCandidate({
      metric_id: "fcf_ttm",
      doc_id: 1,
      representation: "repA",
      value: 7604000000,
      raw_text: "$(7,604)",
    });
    const line = reconcileOne(contract, [c]);

    expect(line.state).toBe("pending");
    expect(line.candidates_json).toBe("[]");
  });

  it("sign guard round-1/2 fix: (0.10) genuinely matching a negative -0.10 is kept, not dropped", () => {
    // Ruling item 3.
    const contract = makeContract("eps_adj");
    const c = makeCandidate({ doc_id: 1, representation: "repA", value: -0.1, raw_text: "$(0.10)" });
    const line = reconcileOne(contract, [c]);

    expect(line.state).toBe("single_source");
    expect(line.value).toBe(-0.1);
  });

  it("sign guard round-2 fix: a WHOLE-CELL parenthesized value with a trailing percent is dropped", () => {
    // "(3.2)%" is the ruling's own example of the allowed whole-cell shape
    // (trailing scale-letter/percent) — proves the guard still fires here.
    const contract = makeContract("op_margin_delta", { unit: "percent" });
    const c = makeCandidate({
      metric_id: "op_margin_delta",
      doc_id: 1,
      representation: "repA",
      value: 3.2, // should have been negative given the parens
      raw_text: "(3.2)%",
    });
    const line = reconcileOne(contract, [c]);

    expect(line.state).toBe("pending");
    expect(line.candidates_json).toBe("[]");
  });

  it("sign guard round-2 fix: mixed string \"Revenue guidance $(2,000)M (2)\" is NOT judged (accepted risk) — kept", () => {
    // Reviewer's round-2 repro: the round-1 scale-matching approach
    // false-dropped this because the coincidental footnote token "(2)"
    // ALSO matched value=2,000,000,000 at the 1e3 (thousands) scale, even
    // though the REAL sign-bearing token is "(2,000)" at the 1e6 scale.
    // Ruling: raw_text with more than just the whole cell is never judged
    // by this guard at all — a deliberate accepted-risk tradeoff (false
    // drops silently cost coverage; the unanimity rule + human verify are
    // the backstop here, not this narrow guard).
    const contract = makeContract("revenue_q_guide", { unit: "usd", period: "NQ_guide" });
    const c = makeCandidate({
      metric_id: "revenue_q_guide",
      doc_id: 1,
      representation: "repA",
      value: 2000000000,
      raw_text: "Revenue guidance $(2,000)M (2)",
    });
    const line = reconcileOne(contract, [c]);

    expect(line.state).toBe("single_source");
    expect(line.value).toBe(2000000000);
  });

  it("sign guard round-2 fix: a bare footnote \"(2)\" inside a longer string is NOT judged — kept", () => {
    // Ruling item 7 — the same accepted-risk rule stated with a simpler
    // string: a footnote reference embedded in prose never triggers the
    // guard, no matter what value happens to be nearby.
    const contract = makeContract("some_metric", { unit: "usd" });
    const c = makeCandidate({
      metric_id: "some_metric",
      doc_id: 1,
      representation: "repA",
      value: 2000,
      raw_text: "Includes a one-time adjustment (2)",
    });
    const line = reconcileOne(contract, [c]);

    expect(line.state).toBe("single_source");
    expect(line.value).toBe(2000);
  });

  it("sign guard drops a malformed candidate but keeps its independent well-formed sibling for agreement", () => {
    const contract = makeContract("eps_adj");
    const malformed = makeCandidate({ doc_id: 1, representation: "repA", value: 5, raw_text: "(5.00)" });
    const wellFormed = makeCandidate({ doc_id: 2, representation: "repA", value: -5 });
    const line = reconcileOne(contract, [malformed, wellFormed]);

    expect(line.state).toBe("single_source");
    expect(line.value).toBe(-5);
    expect(JSON.parse(line.candidates_json)).toHaveLength(1);
  });

  it("value_high mismatch alone (point values equal, range high disagrees) -> conflict, not agreed", () => {
    const contract = makeContract("revenue_q_guide", { kind: "range", period: "NQ_guide" });
    const a = makeCandidate({
      metric_id: "revenue_q_guide",
      doc_id: 1,
      representation: "repA",
      value: 5000000000,
      value_high: 5200000000,
    });
    const b = makeCandidate({
      metric_id: "revenue_q_guide",
      doc_id: 2,
      representation: "repA",
      value: 5000000000,
      value_high: 5300000000,
    });
    const line = reconcileOne(contract, [a, b]);

    expect(line.state).toBe("conflict");
  });

  it("relative tolerance: sub-1e-6 float noise still agrees", () => {
    const contract = makeContract("eps_adj");
    const a = makeCandidate({ doc_id: 1, representation: "repA", value: 1.9999999999 });
    const b = makeCandidate({ doc_id: 2, representation: "repA", value: 2.0 });
    const line = reconcileOne(contract, [a, b]);

    expect(line.state).toBe("agreed");
  });

  it("multiple metrics reconciled together (whole-sheet single pass)", () => {
    const epsContract = makeContract("eps_adj");
    const revContract = makeContract("revenue_q", { unit: "usd", label: "Revenue" });
    const epsA = makeCandidate({ metric_id: "eps_adj", doc_id: 1, representation: "repA", value: 1.5 });
    const epsB = makeCandidate({ metric_id: "eps_adj", doc_id: 2, representation: "repA", value: 1.5 });
    const revOnly = makeCandidate({ metric_id: "revenue_q", doc_id: 1, representation: "repA", value: 8e9 });

    const lines = reconcile(
      [epsContract, revContract],
      { eps_adj: makeExpected({ value: 1.45 }), revenue_q: makeExpected({ value: 7.9e9 }) },
      [epsA, epsB, revOnly],
      [],
    );

    expect(lines).toHaveLength(2);
    const eps = lines.find((l) => l.metric_id === "eps_adj")!;
    const rev = lines.find((l) => l.metric_id === "revenue_q")!;
    expect(eps.state).toBe("agreed");
    expect(rev.state).toBe("single_source");
    expect(rev.expected?.value).toBe(7.9e9);
  });

  it("expected is null when the metric has no consensus entry", () => {
    const contract = makeContract("eps_adj");
    const line = reconcileOne(contract, [], { expected: {} });
    expect(line.expected).toBeNull();
  });

  describe("agreement round-1 fix: strict unanimity, no tie-break / outlier-wins", () => {
    it("both-camps disjoint clusters (100,100 vs 200,200 across 4 independent docs) -> conflict, NOT agreed(100)", () => {
      // Reviewer repro exactly: doc1=100, doc2=100, doc3=200, doc4=200 must
      // no longer false-green via a lowest-doc_id tie-break.
      const contract = makeContract("eps_adj");
      const doc1 = makeCandidate({ doc_id: 1, representation: "repA", value: 100 });
      const doc2 = makeCandidate({ doc_id: 2, representation: "repA", value: 100 });
      const doc3 = makeCandidate({ doc_id: 3, representation: "repA", value: 200 });
      const doc4 = makeCandidate({ doc_id: 4, representation: "repA", value: 200 });
      const line = reconcileOne(contract, [doc1, doc2, doc3, doc4]);

      expect(line.state).toBe("conflict");
      expect(line.value).toBeNull();
      expect(JSON.parse(line.candidates_json)).toHaveLength(4);
    });

    it("corroborated pair + a lone disagreeing outlier -> conflict, the pair does not win", () => {
      const contract = makeContract("eps_adj");
      const doc1 = makeCandidate({ doc_id: 1, representation: "repA", value: 100 });
      const doc2 = makeCandidate({ doc_id: 2, representation: "repA", value: 100 });
      const doc3 = makeCandidate({ doc_id: 3, representation: "repA", value: 999 });
      const line = reconcileOne(contract, [doc1, doc2, doc3]);

      expect(line.state).toBe("conflict");
      expect(line.value).toBeNull();
    });

    it("a pair plus an agreeing third (all unanimous, independent) -> agreed", () => {
      const contract = makeContract("eps_adj");
      const doc1 = makeCandidate({ doc_id: 1, representation: "repA", value: 100 });
      const doc2 = makeCandidate({ doc_id: 2, representation: "repA", value: 100 });
      const doc3 = makeCandidate({ doc_id: 3, representation: "repA", value: 100 });
      const line = reconcileOne(contract, [doc1, doc2, doc3]);

      expect(line.state).toBe("agreed");
      expect(line.value).toBe(100);
      expect(line.source_doc_id).toBe(1);
    });

    it("a pair plus a disagreeing FLASH candidate -> still agreed (flash never blocks agreement)", () => {
      // Reviewer's wire-bullets-round example: a flash headline reads
      // "$47.86B" (rounded) while two independent real documents both
      // report the exact 47,861,000,000 — the flash must never force a
      // conflict.
      const contract = makeContract("revenue_q", { unit: "usd", label: "Revenue" });
      const release1 = makeCandidate({ metric_id: "revenue_q", doc_id: 1, representation: "repA", value: 47861000000 });
      const release2 = makeCandidate({ metric_id: "revenue_q", doc_id: 2, representation: "repA", value: 47861000000 });
      const flash = makeCandidate({
        metric_id: "revenue_q",
        doc_id: 3,
        representation: "flash",
        value: 47860000000, // "$47.86B" rounded — genuinely different number
        snippet: "* Flash: revenue $47.86B",
      });
      const line = reconcileOne(contract, [release1, release2, flash]);

      expect(line.state).toBe("agreed");
      expect(line.value).toBe(47861000000);
      expect(line.source_doc_id).toBe(1);
      expect(JSON.parse(line.candidates_json)).toHaveLength(3); // flash still visible in the audit trail
    });
  });

  it("4-candidate mixed value/ND case: monotonic ND composes with strict unanimity (2 agreeing values + 2 ND docs) -> agreed", () => {
    const contract = makeContract("guidance_rev_low", { period: "NQ_guide" });
    const v1 = makeCandidate({ metric_id: "guidance_rev_low", doc_id: 1, representation: "repA", value: 5000000000 });
    const v2 = makeCandidate({ metric_id: "guidance_rev_low", doc_id: 2, representation: "repA", value: 5000000000 });
    const nd1 = makeCandidate({
      metric_id: "guidance_rev_low",
      doc_id: 3,
      representation: "repA",
      value: null,
      raw_text: null,
      snippet: null,
      not_disclosed: true,
    });
    const nd2 = makeCandidate({
      metric_id: "guidance_rev_low",
      doc_id: 4,
      representation: "repA",
      value: null,
      raw_text: null,
      snippet: null,
      not_disclosed: true,
    });
    const line = reconcileOne(contract, [v1, v2, nd1, nd2]);

    expect(line.state).toBe("agreed");
    expect(line.value).toBe(5000000000);
    expect(JSON.parse(line.candidates_json)).toHaveLength(4); // NDs stay in the audit trail even though excluded from the decision
  });

  it("flash round-1 fix (MINOR): flash + one ND-only document -> state flash, not pending/blank", () => {
    // An ND-only document must not suppress a flash provisional value.
    const contract = makeContract("revenue_q_guide", { period: "NQ_guide" });
    const flash = makeCandidate({
      metric_id: "revenue_q_guide",
      doc_id: 1,
      representation: "flash",
      value: 3000000000,
      snippet: "* Flash: revenue guide $3.0B",
    });
    const nd = makeCandidate({
      metric_id: "revenue_q_guide",
      doc_id: 2,
      representation: "repA",
      value: null,
      raw_text: null,
      snippet: null,
      not_disclosed: true,
    });
    const line = reconcileOne(contract, [flash, nd]);

    expect(line.state).toBe("flash");
    expect(line.value).toBe(3000000000);
    expect(line.source_doc_id).toBe(1);
    expect(JSON.parse(line.candidates_json)).toHaveLength(2);
  });

  it("flash round-1 fix (MINOR): flash + TWO ND-only documents (would otherwise be blank) -> still flash", () => {
    const contract = makeContract("revenue_q_guide", { period: "NQ_guide" });
    const flash = makeCandidate({
      metric_id: "revenue_q_guide",
      doc_id: 1,
      representation: "flash",
      value: 3000000000,
    });
    const nd1 = makeCandidate({
      metric_id: "revenue_q_guide",
      doc_id: 2,
      representation: "repA",
      value: null,
      raw_text: null,
      snippet: null,
      not_disclosed: true,
    });
    const nd2 = makeCandidate({
      metric_id: "revenue_q_guide",
      doc_id: 3,
      representation: "repA",
      value: null,
      raw_text: null,
      snippet: null,
      not_disclosed: true,
    });
    const line = reconcileOne(contract, [flash, nd1, nd2]);

    expect(line.state).toBe("flash");
    expect(line.value).toBe(3000000000);
  });
});
