import { describe, it, expect } from "vitest";
import { deltaPctNumber, verdictFor, factsFromLines, directionSafeFacts, isContradictedAccepted } from "@/lib/print-watch/read-facts";
import { needsReverify } from "@/app/dashboard/today/live-print/helpers";
import type { LineContract, PrintWatchLine, TaggedCandidate } from "@/lib/print-watch/types";

function contract(metricId: string, o: Partial<LineContract> = {}): LineContract {
  return { metric_id: metricId, label: metricId, definition: "d", basis: "na", period: "Q", currency: "USD", unit: "usd", kind: "point", segment: null, ...o };
}
function cand(metricId: string, value: number, docId: number, o: Partial<TaggedCandidate> = {}): TaggedCandidate {
  return { metric_id: metricId, value, value_high: null, raw_text: null, snippet: null, location_hint: null, not_disclosed: false, doc_id: docId, representation: "repA", weak_pair: false, ...o };
}
function line(metricId: string, o: Partial<PrintWatchLine> = {}, c: Partial<LineContract> = {}): PrintWatchLine {
  return { metric_id: metricId, contract: contract(metricId, c), expected: null, state: "accepted", value: null, value_high: null, snippet: null, source_doc_id: 1, candidates_json: "[]", ...o };
}

describe("deltaPctNumber / verdictFor", () => {
  it("computes the signed percentage against |consensus| and rounds to 2 decimals", () => {
    expect(deltaPctNumber(100, 102.4567)).toBe(2.46);
    expect(deltaPctNumber(-1, -1.1)).toBe(-10);
    expect(deltaPctNumber(0, 5)).toBeNull();
    expect(deltaPctNumber(null, 5)).toBeNull();
  });
  it("beat above +0.5, miss below -0.5, inline inside the band, n/a on null", () => {
    expect(verdictFor(0.51)).toBe("beat");
    expect(verdictFor(0.5)).toBe("inline");
    expect(verdictFor(-0.5)).toBe("inline");
    expect(verdictFor(-0.51)).toBe("miss");
    expect(verdictFor(null)).toBe("n/a");
  });
});

describe("factsFromLines — validated rows only", () => {
  it("admits accepted lines with a value; never flash, agreed, single_source, conflict, pending", () => {
    const facts = factsFromLines(
      [
        line("revenue_q", { value: 898.2e6, expected: { value: 877.3e6, value_high: null, whisper: 880e6, source_label: "VK 8/30" }, candidates_json: JSON.stringify([cand("revenue_q", 898.2e6, 1)]) }),
        line("eps_gaap_q", { state: "agreed", value: 0.9 }, { unit: "per_share", basis: "gaap" }),
        line("seg_a", { state: "single_source", value: 5 }),
        line("seg_b", { state: "flash", value: 6 }),
        line("seg_c", { state: "conflict", value: null }),
        line("seg_d", { state: "pending", value: null }),
      ],
      null,
    );
    expect(facts.map((f) => f.metric_id)).toEqual(["revenue_q"]);
    expect(facts[0]).toMatchObject({ state: "accepted", actual: 898.2e6, expected_consensus: 877.3e6, expected_whisper: 880e6, expected_source: "VK 8/30", expected_consensus_vendor: null, expected_basis: "specified", delta_pct: 2.38, verdict: "beat", kind: "point" });
  });

  it("omits an accepted line contradicted by later non-flash evidence (parity with the panel's needsReverify)", () => {
    const contradicted = line("revenue_q", { value: 898.2e6, source_doc_id: 1, candidates_json: JSON.stringify([cand("revenue_q", 898.2e6, 1), cand("revenue_q", 901.0e6, 2)]) });
    const rivalOlder = line("revenue_q", { value: 898.2e6, source_doc_id: 2, candidates_json: JSON.stringify([cand("revenue_q", 901.0e6, 1), cand("revenue_q", 898.2e6, 2)]) });
    const flashOnly = line("revenue_q", { value: 898.2e6, source_doc_id: 1, candidates_json: JSON.stringify([cand("revenue_q", 898.2e6, 1), cand("revenue_q", 900e6, 0, { representation: "flash" })]) });
    for (const l of [contradicted, rivalOlder, flashOnly]) expect(isContradictedAccepted(l)).toBe(needsReverify(l));
    expect(isContradictedAccepted(contradicted)).toBe(true);
    expect(factsFromLines([contradicted, rivalOlder, flashOnly], null).map((f) => f.metric_id)).toEqual(["revenue_q", "revenue_q"]);
  });

  it("adjusted EPS with only a vendor consensus shows the vendor figure, basis unspecified, no delta", () => {
    const [fact] = factsFromLines([line("eps_adj_q", { value: 1.12 }, { unit: "per_share", basis: "non_gaap" })], 1.1);
    expect(fact).toMatchObject({ expected_consensus: null, expected_consensus_vendor: 1.1, expected_basis: "unspecified", expected_source: "vendor, basis unspecified", delta_pct: null, verdict: "n/a" });
  });

  it("adjusted EPS with a sheet consensus computes against the sheet figure and still carries the vendor figure for display", () => {
    const [fact] = factsFromLines([line("eps_adj_q", { value: 1.12, expected: { value: 1.09, value_high: null, whisper: null, source_label: "VK" } }, { unit: "per_share", basis: "non_gaap" })], 1.1);
    expect(fact).toMatchObject({ expected_consensus: 1.09, expected_consensus_vendor: 1.1, expected_basis: "specified", expected_source: "VK", delta_pct: 2.75, verdict: "beat" });
  });

  it("the vendor figure never attaches to any other metric", () => {
    const [fact] = factsFromLines([line("revenue_q", { value: 10 })], 1.1);
    expect(fact.expected_consensus_vendor).toBeNull();
    expect(fact.expected_basis).toBeNull();
  });

  it("range lines keep their consensus for display but never get a delta or a beat/miss", () => {
    const [guide] = factsFromLines(
      [line("revenue_guide_next", { value: 900e6, value_high: 905e6, expected: { value: 895e6, value_high: null, whisper: null, source_label: "VK" } }, { period: "NQ_guide", kind: "range" })],
      null,
    );
    expect(guide).toMatchObject({ actual: 900e6, actual_high: 905e6, expected_consensus: 895e6, expected_source: "VK", delta_pct: null, verdict: "range", kind: "range" });
    const [extra] = factsFromLines([line("extra_fy_guide", { value: 3.2e9, expected: { value: 3.1e9, value_high: null, whisper: 3.15e9, source_label: "VK" } }, { period: "FY_guide", kind: "point" })], null);
    expect(extra).toMatchObject({ expected_consensus: 3.1e9, expected_whisper: 3.15e9, delta_pct: 3.23, verdict: "beat" });
  });

  it("directionSafeFacts strips every number", () => {
    const facts = factsFromLines([line("revenue_q", { value: 10, expected: { value: 9, value_high: null, whisper: null, source_label: "s" } })], null);
    expect(directionSafeFacts(facts)).toEqual([{ metric_id: "revenue_q", label: "revenue_q", verdict: "beat" }]);
    expect(JSON.stringify(directionSafeFacts(facts))).not.toMatch(/10|9/);
  });
});
