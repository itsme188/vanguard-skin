/**
 * The ONE remapped-candidate rule (controller ruling R-B7b), shared by
 * migration 089 phase (5) and the event-merge handler. Pure, so it is pinned
 * here directly; the two callers pin it again end-to-end against a database.
 */
import { describe, it, expect } from "vitest";
import { dedupeRemappedCandidates } from "@/lib/print-watch/candidate-fate";
import type { TaggedCandidate } from "@/lib/print-watch/types";

function cand(
  docId: number,
  representation: TaggedCandidate["representation"],
  value = 1000,
): TaggedCandidate {
  return {
    metric_id: "revenue_q",
    value,
    value_high: null,
    raw_text: String(value),
    snippet: "s",
    location_hint: null,
    not_disclosed: false,
    doc_id: docId,
    representation,
    weak_pair: false,
  };
}

/** 2 was merged into 1; 1 and 3 keep their own ids; 0 (flash) and 9 are not ours. */
const remap = new Map<number, number>([
  [1, 1],
  [2, 1],
  [3, 3],
]);
const policy = { survivorOf: (id: number) => (id === 0 ? null : remap.get(id) ?? null) };

describe("dedupeRemappedCandidates", () => {
  it("keeps a twin's repA/repB pair when the survivor holds neither slot", () => {
    const out = dedupeRemappedCandidates([cand(2, "repA"), cand(2, "repB")], policy);
    expect(out.kept.map((c) => [c.doc_id, c.representation])).toEqual([
      [1, "repA"],
      [1, "repB"],
    ]);
    expect(out.archived).toEqual([]);
    expect(out.touched).toBe(true);
  });

  it("archives only the reading the survivor already carries", () => {
    const out = dedupeRemappedCandidates([cand(1, "repA"), cand(2, "repA"), cand(2, "repB")], policy);
    expect(out.kept.map((c) => [c.doc_id, c.representation])).toEqual([
      [1, "repA"],
      [1, "repB"],
    ]);
    expect(out.archived).toHaveLength(1);
    expect(out.archived[0]).toMatchObject({ reason: "duplicate-of:1" });
    expect(out.archived[0].candidate).toMatchObject({ doc_id: 2, representation: "repA" });
  });

  it("is order-independent: the survivor's own reading wins whichever side it sits on", () => {
    const forward = dedupeRemappedCandidates([cand(1, "repA"), cand(2, "repA")], policy);
    const reverse = dedupeRemappedCandidates([cand(2, "repA"), cand(1, "repA")], policy);
    expect(forward.kept.map((c) => c.doc_id)).toEqual([1]);
    expect(reverse.kept.map((c) => c.doc_id)).toEqual([1]);
    expect(reverse.kept[0].representation).toBe("repA");
    expect(reverse.archived[0].candidate.doc_id).toBe(2);
  });

  it("counts slots already held by candidates that are NOT in the list (the merge's target evidence)", () => {
    const out = dedupeRemappedCandidates([cand(2, "repA")], policy, [cand(1, "repA")]);
    expect(out.kept).toEqual([]);
    expect(out.archived).toHaveLength(1);
    expect(out.archived[0].reason).toBe("duplicate-of:1");
  });

  it("passes through the flash sentinel and a doc_id it never saw, untouched", () => {
    const out = dedupeRemappedCandidates([cand(0, "flash"), cand(9, "repB"), cand(3, "repA")], policy);
    expect(out.kept.map((c) => c.doc_id)).toEqual([0, 9, 3]);
    expect(out.touched).toBe(false);
  });

  it("archives evidence whose surviving document's bytes are gone, whatever its slot", () => {
    const out = dedupeRemappedCandidates([cand(1, "repA"), cand(2, "repB")], {
      ...policy,
      bytesMissing: (id) => id === 1,
    });
    expect(out.kept).toEqual([]);
    expect(out.archived.map((a) => a.reason)).toEqual(["bytes-missing", "bytes-missing"]);
    expect(out.touched).toBe(true);
  });

  it("conserves every candidate: kept + archived is always the input", () => {
    const input = [cand(1, "repA"), cand(2, "repA"), cand(2, "repB"), cand(0, "flash"), cand(3, "repB")];
    const out = dedupeRemappedCandidates(input, policy);
    expect(out.kept.length + out.archived.length).toBe(input.length);
  });
});
