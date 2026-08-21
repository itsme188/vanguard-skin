import { describe, it, expect } from "vitest";
import {
  ladderText,
  promoteSummary,
  needsReverify,
  deltaPct,
} from "@/app/dashboard/today/PrintWatchPanel";
import type { LineContract, PrintWatchLine, TaggedCandidate } from "@/lib/print-watch/types";

// ── fixtures ────────────────────────────────────────────────────────────

function makeContract(overrides: Partial<LineContract> = {}): LineContract {
  return {
    metric_id: "eps_adj_q",
    label: "EPS (adj)",
    definition: "Adjusted diluted EPS for the quarter",
    basis: "non_gaap",
    period: "Q",
    currency: "USD",
    unit: "per_share",
    kind: "point",
    segment: null,
    ...overrides,
  };
}

function makeLine(overrides: Partial<PrintWatchLine> = {}): PrintWatchLine {
  return {
    metric_id: "eps_adj_q",
    contract: makeContract(),
    expected: { value: 0.85, value_high: null, whisper: 0.9, source_label: "Street" },
    state: "pending",
    value: null,
    value_high: null,
    snippet: null,
    source_doc_id: null,
    candidates_json: "[]",
    ...overrides,
  };
}

function candidate(overrides: Partial<TaggedCandidate> = {}): TaggedCandidate {
  return {
    metric_id: "eps_adj_q",
    value: 0.91,
    value_high: null,
    raw_text: "0.91",
    snippet: "adjusted EPS of $0.91",
    location_hint: null,
    not_disclosed: false,
    doc_id: 10,
    representation: "repA",
    weak_pair: false,
    ...overrides,
  };
}

// ── deltaPct ────────────────────────────────────────────────────────────

describe("deltaPct", () => {
  it("returns null when the bogey side is missing", () => {
    expect(deltaPct(null, 0.91)).toBeNull();
  });

  it("returns null when the actual side is missing", () => {
    expect(deltaPct(0.85, null)).toBeNull();
  });

  it("returns null when the bogey is exactly zero (undefined percent base)", () => {
    expect(deltaPct(0, 0.5)).toBeNull();
  });

  it("signs a beat positive", () => {
    const d = deltaPct(0.85, 0.91);
    expect(d).not.toBeNull();
    expect(d?.sign).toBe(1);
    expect(d?.label).toBe("+7.1%");
  });

  it("signs a miss negative", () => {
    const d = deltaPct(0.85, 0.8);
    expect(d).not.toBeNull();
    expect(d?.sign).toBe(-1);
    expect(d?.label).toBe("-5.9%");
  });

  it("reports a near-zero gap as in-line, not a signed percent", () => {
    const d = deltaPct(100, 100.02);
    expect(d).not.toBeNull();
    expect(d?.sign).toBe(0);
    expect(d?.label).toBe("in-line");
  });
});

// ── ladderText ──────────────────────────────────────────────────────────

describe("ladderText", () => {
  it("renders empty string for no sources (pre-first-poll after a restart)", () => {
    expect(ladderText({})).toBe("");
  });

  it("orders known sources canonically regardless of input key order", () => {
    expect(
      ladderText({ edgar: "CIK unresolved", dj: "ok — 1 release(s)" }),
    ).toBe("DJ: ok — 1 release(s) · EDGAR: CIK unresolved");
  });

  it("labels the watcher lease note", () => {
    expect(ladderText({ watcher: "owned by 4821@3000" })).toBe(
      "Watcher: owned by 4821@3000",
    );
  });

  it("appends unrecognized keys alphabetically after the canonical ladder", () => {
    expect(ladderText({ zzz: "custom note", dj: "ok" })).toBe("DJ: ok · Zzz: custom note");
  });
});

// ── needsReverify ───────────────────────────────────────────────────────

describe("needsReverify", () => {
  it("is false for a non-accepted line regardless of candidates", () => {
    const line = makeLine({ state: "agreed", value: 0.95 });
    expect(needsReverify(line)).toBe(false);
  });

  it("is false for an accepted line with no candidate evidence yet", () => {
    const line = makeLine({ state: "accepted", value: 0.91, candidates_json: "[]" });
    expect(needsReverify(line)).toBe(false);
  });

  it("is false when the freshest independent agreement matches the accepted value", () => {
    const candidates: TaggedCandidate[] = [
      candidate({ doc_id: 10, representation: "repA", value: 0.91 }),
      candidate({ doc_id: 11, representation: "repB", value: 0.91 }),
    ];
    const line = makeLine({
      state: "accepted",
      value: 0.91,
      candidates_json: JSON.stringify(candidates),
    });
    expect(needsReverify(line)).toBe(false);
  });

  it("is true when a fresh independent agreement diverges from the accepted value", () => {
    const candidates: TaggedCandidate[] = [
      candidate({ doc_id: 20, representation: "repA", value: 0.95 }),
      candidate({ doc_id: 21, representation: "repB", value: 0.95 }),
    ];
    const line = makeLine({
      state: "accepted",
      value: 0.91,
      candidates_json: JSON.stringify(candidates),
    });
    expect(needsReverify(line)).toBe(true);
  });

  it("is false when the only new evidence is a single non-independent source that MATCHES the accepted value", () => {
    // Trigger (a) requires an INDEPENDENT agreement (>=2 sources) — one
    // lone candidate can never resolve 'agreed' on its own (reconcile
    // reports 'single_source' for exactly one value-candidate), so this
    // exercises that trigger (a) doesn't misfire on a single source. It
    // must still stay false under trigger (b) too, which is why the
    // candidate's value MATCHES the accepted one — see the next test for
    // the case where a lone candidate DIVERGES (now `true`, fix round 2).
    const candidates: TaggedCandidate[] = [
      candidate({ doc_id: 30, representation: "repA", value: 0.91 }),
    ];
    const line = makeLine({
      state: "accepted",
      value: 0.91,
      candidates_json: JSON.stringify(candidates),
    });
    expect(needsReverify(line)).toBe(false);
  });

  // Fix round 2, literal ruling example: "accepted 1.10 + later non-flash
  // candidate 1.15 → true". A lone diverging candidate can never resolve
  // 'agreed' under trigger (a) (reconcile reports 'single_source'), but
  // trigger (b) doesn't require independence — any non-flash candidate
  // conflicting with the locked value is itself the signal.
  it("flags divergence from a single later non-flash candidate even though it can never resolve 'agreed' alone", () => {
    const candidates: TaggedCandidate[] = [
      candidate({ doc_id: 31, representation: "repA", value: 1.15 }),
    ];
    const line = makeLine({
      state: "accepted",
      value: 1.1,
      candidates_json: JSON.stringify(candidates),
    });
    expect(needsReverify(line)).toBe(true);
  });

  // Range-kind contracts (revenue_guide_next / eps_adj_guide_next) carry a
  // value_high alongside value — a fresh independent agreement that revises
  // only the TOP of a guidance range, with the floor unchanged, must still
  // flag "superseded — re-verify" (fix round 1: needsReverify originally
  // only compared `value`, never `value_high`).
  const rangeContract = makeContract({
    metric_id: "revenue_guide_next",
    label: "Revenue guide (next Q)",
    period: "NQ_guide",
    kind: "range",
    unit: "usd",
  });

  it("flags divergence when a fresh agreement revises the top of a guidance range but the floor holds", () => {
    const candidates: TaggedCandidate[] = [
      candidate({
        metric_id: "revenue_guide_next",
        doc_id: 40,
        representation: "repA",
        value: 19_500_000_000,
        value_high: 20_200_000_000,
      }),
      candidate({
        metric_id: "revenue_guide_next",
        doc_id: 41,
        representation: "repB",
        value: 19_500_000_000,
        value_high: 20_200_000_000,
      }),
    ];
    const line = makeLine({
      metric_id: "revenue_guide_next",
      contract: rangeContract,
      state: "accepted",
      value: 19_500_000_000,
      value_high: 20_000_000_000,
      candidates_json: JSON.stringify(candidates),
    });
    expect(needsReverify(line)).toBe(true);
  });

  it("does not flag divergence when a fresh agreement matches both ends of the accepted range", () => {
    const candidates: TaggedCandidate[] = [
      candidate({
        metric_id: "revenue_guide_next",
        doc_id: 50,
        representation: "repA",
        value: 19_500_000_000,
        value_high: 20_000_000_000,
      }),
      candidate({
        metric_id: "revenue_guide_next",
        doc_id: 51,
        representation: "repB",
        value: 19_500_000_000,
        value_high: 20_000_000_000,
      }),
    ];
    const line = makeLine({
      metric_id: "revenue_guide_next",
      contract: rangeContract,
      state: "accepted",
      value: 19_500_000_000,
      value_high: 20_000_000_000,
      candidates_json: JSON.stringify(candidates),
    });
    expect(needsReverify(line)).toBe(false);
  });

  // Fix round 2: trigger (a) alone (a fresh independent 'agreed' outcome)
  // structurally can never fire for a real-document correction, because
  // evidence is never removed and the reconciler's strict-unanimity rule
  // means any pool containing both the original agreeing candidates AND a
  // later disagreeing one can only ever resolve to 'conflict'. Trigger (b)
  // — any single non-flash candidate conflicting with the locked value —
  // covers exactly this case.
  it("flags divergence from a real correcting candidate even though the fresh recompute can only ever land on conflict", () => {
    const candidates: TaggedCandidate[] = [
      // The two original independent candidates that led to the accept.
      candidate({ doc_id: 60, representation: "repA", value: 1.1 }),
      candidate({ doc_id: 61, representation: "repB", value: 1.1 }),
      // A later correction (e.g. an 8-K/A) — evidence is never removed,
      // so this now sits alongside the original two, and any fresh
      // recompute over all three is unanimity-blocked into 'conflict'
      // forever (verified: reconcile() on this exact pool returns
      // 'conflict', not 'agreed' — trigger (a) cannot see this).
      candidate({ doc_id: 70, representation: "repA", value: 1.15 }),
    ];
    const line = makeLine({
      state: "accepted",
      value: 1.1,
      candidates_json: JSON.stringify(candidates),
    });
    expect(needsReverify(line)).toBe(true);
  });

  it("does not flag divergence from a flash-only candidate (wire rounding, not a correction signal)", () => {
    const candidates: TaggedCandidate[] = [
      candidate({ doc_id: 80, representation: "flash", value: 1.13 }),
    ];
    const line = makeLine({
      state: "accepted",
      value: 1.1,
      candidates_json: JSON.stringify(candidates),
    });
    expect(needsReverify(line)).toBe(false);
  });

  it("flags divergence when only the top of an accepted range diverges in a later non-flash candidate", () => {
    const epsRangeContract = makeContract({
      metric_id: "eps_adj_guide_next",
      label: "EPS (adj) guide (next Q)",
      period: "NQ_guide",
      kind: "range",
      unit: "per_share",
      basis: "non_gaap",
    });
    const candidates: TaggedCandidate[] = [
      candidate({
        metric_id: "eps_adj_guide_next",
        doc_id: 90,
        representation: "repA",
        value: 0.5,
        value_high: 0.55,
      }),
      candidate({
        metric_id: "eps_adj_guide_next",
        doc_id: 91,
        representation: "repB",
        value: 0.5,
        value_high: 0.55,
      }),
      // Later correction: floor unchanged, top revised.
      candidate({
        metric_id: "eps_adj_guide_next",
        doc_id: 100,
        representation: "repA",
        value: 0.5,
        value_high: 0.6,
      }),
    ];
    const line = makeLine({
      metric_id: "eps_adj_guide_next",
      contract: epsRangeContract,
      state: "accepted",
      value: 0.5,
      value_high: 0.55,
      candidates_json: JSON.stringify(candidates),
    });
    expect(needsReverify(line)).toBe(true);
  });

  it("is false when no candidate, flash or otherwise, diverges from the accepted value", () => {
    const candidates: TaggedCandidate[] = [
      candidate({ doc_id: 110, representation: "repA", value: 1.1 }),
      candidate({ doc_id: 111, representation: "flash", value: 1.1 }),
    ];
    const line = makeLine({
      state: "accepted",
      value: 1.1,
      candidates_json: JSON.stringify(candidates),
    });
    expect(needsReverify(line)).toBe(false);
  });
});

// ── promoteSummary ──────────────────────────────────────────────────────

describe("promoteSummary", () => {
  it("is null when nothing is accepted", () => {
    const lines = [
      makeLine({ metric_id: "eps_adj_q", state: "agreed", value: 0.91 }),
      makeLine({
        metric_id: "revenue_q",
        state: "agreed",
        value: 4_340_000_000,
        contract: makeContract({ metric_id: "revenue_q", label: "Revenue", unit: "usd" }),
      }),
    ];
    expect(promoteSummary(lines)).toBeNull();
  });

  it("is null when EPS is accepted but revenue is not", () => {
    const lines = [
      makeLine({ metric_id: "eps_adj_q", state: "accepted", value: 0.91 }),
      makeLine({
        metric_id: "revenue_q",
        state: "agreed",
        value: 4_340_000_000,
        contract: makeContract({ metric_id: "revenue_q", label: "Revenue", unit: "usd" }),
      }),
    ];
    expect(promoteSummary(lines)).toBeNull();
  });

  it("is null when revenue is accepted but no EPS line is accepted", () => {
    const lines = [
      makeLine({ metric_id: "eps_adj_q", state: "single_source", value: 0.91 }),
      makeLine({
        metric_id: "revenue_q",
        state: "accepted",
        value: 4_340_000_000,
        contract: makeContract({ metric_id: "revenue_q", label: "Revenue", unit: "usd" }),
      }),
    ];
    expect(promoteSummary(lines)).toBeNull();
  });

  it("prefers the adjusted EPS line when both adj and GAAP are accepted", () => {
    const lines = [
      makeLine({ metric_id: "eps_adj_q", state: "accepted", value: 0.91 }),
      makeLine({
        metric_id: "eps_gaap_q",
        state: "accepted",
        value: 0.75,
        contract: makeContract({ metric_id: "eps_gaap_q", label: "EPS (GAAP)", basis: "gaap" }),
      }),
      makeLine({
        metric_id: "revenue_q",
        state: "accepted",
        value: 4_340_000_000,
        contract: makeContract({ metric_id: "revenue_q", label: "Revenue", unit: "usd" }),
      }),
    ];
    const summary = promoteSummary(lines);
    expect(summary).not.toBeNull();
    expect(summary?.basisLabel).toBe("adj");
    expect(summary?.epsValue).toBe(0.91);
    expect(summary?.revenueValue).toBe(4_340_000_000);
    expect(summary?.label).toBe("Promote EPS+Rev (adj $0.91 · $4.34B)");
  });

  it("falls back to GAAP EPS with a gaap basisLabel when adj was not accepted", () => {
    const lines = [
      makeLine({
        metric_id: "eps_gaap_q",
        state: "accepted",
        value: -0.12,
        contract: makeContract({ metric_id: "eps_gaap_q", label: "EPS (GAAP)", basis: "gaap" }),
      }),
      makeLine({
        metric_id: "revenue_q",
        state: "accepted",
        value: 4_340_000_000,
        contract: makeContract({ metric_id: "revenue_q", label: "Revenue", unit: "usd" }),
      }),
    ];
    const summary = promoteSummary(lines);
    expect(summary).not.toBeNull();
    expect(summary?.basisLabel).toBe("gaap");
    expect(summary?.epsValue).toBe(-0.12);
    expect(summary?.label).toBe("Promote EPS+Rev (gaap -$0.12 · $4.34B)");
  });
});
