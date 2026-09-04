import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  ladderText,
  promoteSummary,
  needsReverify,
  canAcceptLine,
  acceptableRivals,
  deltaPct,
  printStateLabel,
  printCountLabel,
  candidateSourceLabel,
  dropOutcomeMessage,
  firstDroppedFile,
  PRE_GATE_DISCLOSURE,
  SUPERSEDED_CONFIRM_COPY,
  goStatusText,
  windowText,
} from "@/app/dashboard/today/live-print/helpers";
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

  // R-B16: the stored-IR-page lane is a KNOWN rung — before it was listed it
  // fell through to the unknown-key branch and rendered "Ir: ok — IR: …",
  // out of order and capitalised like a typo.
  it("renders the stored-IR-page lane as a known rung, right after RSS", () => {
    expect(
      ladderText({ ir: "ok — 3 matching links, 1 new", rss: "no feed", dj: "ok" }),
    ).toBe("DJ: ok · RSS: no feed · IR: ok — 3 matching links, 1 new");
  });
});

// ── printStateLabel ─────────────────────────────────────────────────────

describe("printStateLabel", () => {
  it("calls an expired print 'window closed', not 'expired'", () => {
    // "expired" reads as "this is over"; what actually happened is that the
    // automatic window closed without the wire delivering — the drop zone
    // stays live behind this chip, which is the whole point of the label.
    expect(printStateLabel("expired")).toEqual({ text: "window closed", tone: "warn" });
  });

  it("keeps the live states hot and the parsed state green", () => {
    expect(printStateLabel("window_open")).toEqual({ text: "window open", tone: "gold" });
    expect(printStateLabel("acquired")).toEqual({ text: "acquired", tone: "gold" });
    expect(printStateLabel("parsed")).toEqual({ text: "parsed", tone: "up" });
  });

  it("renders the remaining states neutrally with their underscore unspaced", () => {
    expect(printStateLabel("scheduled")).toEqual({ text: "scheduled", tone: "neutral" });
    expect(printStateLabel("disarmed")).toEqual({ text: "disarmed", tone: "neutral" });
  });
});

// ── printCountLabel ─────────────────────────────────────────────────────

describe("printCountLabel", () => {
  it("counts only non-expired prints as active", () => {
    // The header used to say "2 active prints" over two chips both reading
    // WINDOW CLOSED — expired prints stay listed (their drop zone is live)
    // but they are not active.
    expect(printCountLabel([{ state: "window_open" }, { state: "expired" }])).toBe(
      "1 active · 1 closed",
    );
  });

  it("says nothing about closed prints when there are none", () => {
    expect(printCountLabel([{ state: "window_open" }, { state: "parsed" }])).toBe(
      "2 active prints",
    );
    expect(printCountLabel([{ state: "scheduled" }])).toBe("1 active print");
  });

  it("reports an all-expired list as closed, never as zero active", () => {
    expect(printCountLabel([{ state: "expired" }])).toBe("1 closed print");
    expect(printCountLabel([{ state: "expired" }, { state: "expired" }])).toBe("2 closed prints");
  });
});

// ── candidateSourceLabel ────────────────────────────────────────────────

describe("candidateSourceLabel", () => {
  it("names the document kind beside the doc id", () => {
    expect(
      candidateSourceLabel({ doc_id: 12, representation: "repA" }, { 12: "edgar-ex99" }),
    ).toBe("doc #12 (edgar-ex99 · repA)");
  });

  it("distinguishes rival sources on a conflict row", () => {
    const documents = { 12: "edgar-ex99", 13: "user-drop" };
    expect(candidateSourceLabel({ doc_id: 13, representation: "repB" }, documents)).toBe(
      "doc #13 (user-drop · repB)",
    );
  });

  it("falls back to the bare doc id when the map has no entry (older server)", () => {
    expect(candidateSourceLabel({ doc_id: 12, representation: "repA" }, undefined)).toBe(
      "doc #12 (repA)",
    );
    expect(candidateSourceLabel({ doc_id: 99, representation: "repA" }, { 12: "dj-release" })).toBe(
      "doc #99 (repA)",
    );
  });

  it("says 'wire flash' for flash candidates — they have no document of record", () => {
    expect(candidateSourceLabel({ doc_id: 0, representation: "flash" }, {})).toBe("wire flash");
  });
});

// ── dropOutcomeMessage ──────────────────────────────────────────────────

describe("dropOutcomeMessage", () => {
  it("confirms a parsed drop as a finished action, not work in progress", () => {
    expect(dropOutcomeMessage("parsed", null)).toEqual({
      tone: "note",
      text: "Parsed — sheet updated.",
    });
  });

  it("surfaces a gate rejection with its reason, as an error", () => {
    expect(dropOutcomeMessage("rejected", "issuer not named (NVDA)")).toEqual({
      tone: "error",
      text: "Rejected: issuer not named (NVDA)",
    });
  });

  it("explains a rejection even when the server sent no reason", () => {
    const msg = dropOutcomeMessage("rejected", null);
    expect(msg.tone).toBe("error");
    expect(msg.text).toMatch(/^Rejected: /);
  });

  it("says a duplicate is already in hand rather than 'parsing now'", () => {
    expect(dropOutcomeMessage("duplicate", null)).toEqual({
      tone: "note",
      text: "Already ingested — no new evidence.",
    });
  });

  it("treats a missing outcome as a parsed drop (older server, still truthful)", () => {
    expect(dropOutcomeMessage(undefined, undefined).tone).toBe("note");
  });

  // Fix wave, finding C: a drop that landed while another process held the
  // watcher lease was reported as "parsed" — the sheet had not moved, and
  // nothing on screen said so.
  it("says a queued drop is waiting on the process that owns the watch", () => {
    expect(dropOutcomeMessage("queued", null)).toEqual({
      tone: "note",
      text: "Queued — another process owns the watch; it will parse shortly.",
    });
  });
});

// ── standing copy (fix wave, findings B + G) ────────────────────────────

describe("panel copy", () => {
  it("carries the pre-gate disclosure verbatim", () => {
    expect(PRE_GATE_DISCLOSURE).toBe(
      "Pre-gate build — machine-read values; verify every number before accepting.",
    );
  });

  it("asks its OWN question on a superseded promote — not the pre-print one", () => {
    expect(SUPERSEDED_CONFIRM_COPY).toBe(
      "Newer evidence disagrees with the accepted number — re-verify before promoting. Promote the accepted value anyway?",
    );
    expect(SUPERSEDED_CONFIRM_COPY).not.toMatch(/future/i);
  });
});

// ── firstDroppedFile ────────────────────────────────────────────────────

describe("firstDroppedFile", () => {
  const fakeFile = { name: "nvda-q2.html" } as unknown as File;

  it("takes the first file off a drag payload", () => {
    expect(firstDroppedFile({ files: [fakeFile] })).toBe(fakeFile);
  });

  it("returns null for a drag that carried no file (a link, selected text)", () => {
    expect(firstDroppedFile({ files: [] })).toBeNull();
    expect(firstDroppedFile({ files: null })).toBeNull();
    expect(firstDroppedFile({})).toBeNull();
    expect(firstDroppedFile(null)).toBeNull();
    expect(firstDroppedFile(undefined)).toBeNull();
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

  // CONFIRMED defect (parity twin of app/api/print-watch/accept/route.ts's
  // `divergentCandidates` — see tests/api/print-watch-accept.test.ts,
  // describe("promoteHeadline-only follow-up after a per-candidate accept —
  // document-order gate")): trigger (b) flagged ANY non-flash rival that
  // disagreed with the accepted value, with no document ordering. A
  // per-candidate accept (`acceptLineCandidate`) sets `source_doc_id` to the
  // chosen document and deliberately keeps the rejected OLDER rival sitting
  // in `candidates_json` — so the chip mislabeled a line the desk had just
  // verified "⟳ superseded — re-verify" on evidence it had already
  // out-verified by picking the newer document. Fix: trigger (b) now ignores
  // any candidate whose `doc_id <= line.source_doc_id` once `source_doc_id`
  // is a number, matching the route's `candidateSupersessionDetail` rule.
  //
  // Same (0.91 doc-B accepted / 0.89 doc-A rival) figures as the route's new
  // tests, so both surfaces are pinned to read the identical verdict.
  describe("needsReverify — per-candidate accept document order", () => {
    it("is false when the accepted candidate came from the LATER document and an older rival (0.89) still sits in candidates_json", () => {
      const candidates: TaggedCandidate[] = [
        candidate({ doc_id: 5, representation: "repA", value: 0.89 }),
        candidate({ doc_id: 7, representation: "repA", value: 0.91 }),
      ];
      const line = makeLine({
        state: "accepted",
        value: 0.91,
        source_doc_id: 7,
        candidates_json: JSON.stringify(candidates),
      });
      expect(needsReverify(line)).toBe(false);
    });

    it("is still true when the accepted candidate came from the STALE document and a later rival (0.91) disagrees", () => {
      const candidates: TaggedCandidate[] = [
        candidate({ doc_id: 5, representation: "repA", value: 0.89 }),
        candidate({ doc_id: 7, representation: "repA", value: 0.91 }),
      ];
      const line = makeLine({
        state: "accepted",
        value: 0.89,
        source_doc_id: 5,
        candidates_json: JSON.stringify(candidates),
      });
      expect(needsReverify(line)).toBe(true);
    });
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

// ── per-line accept control ────────────────────────────────────────────
//
// QA finding `today-print-watch--unaccept-one-way-no-per-line-accept-promote-
// falls-to-gaap`: the panel rendered an "unaccept" button on accepted lines
// and NOTHING on the others, while the bulk button takes only 'agreed' lines
// and clearLineAccepted parks an un-accepted line on 'pending' — so an
// accidental un-accept was one-way until the watcher polled again, and
// Promote silently fell back to the GAAP basis meanwhile.

describe("canAcceptLine", () => {
  it("is false for an already-accepted line — the unaccept control renders there instead", () => {
    expect(canAcceptLine(makeLine({ state: "accepted", value: 0.91 }))).toBe(false);
  });

  it("is true for an un-accepted line that still holds its number (the recovery case)", () => {
    // Exactly what clearLineAccepted leaves behind: state back to 'pending',
    // value untouched. The reconciler never produces this shape.
    expect(canAcceptLine(makeLine({ state: "pending", value: 0.91 }))).toBe(true);
  });

  it("is false for a pending line with no number yet — nothing to accept", () => {
    expect(canAcceptLine(makeLine({ state: "pending", value: null }))).toBe(false);
  });

  it("is true for an agreed line", () => {
    expect(canAcceptLine(makeLine({ state: "agreed", value: 0.91 }))).toBe(true);
  });

  it("is true for the eyes-on overrides the accept route already allows", () => {
    expect(canAcceptLine(makeLine({ state: "single_source", value: 0.91 }))).toBe(true);
    expect(canAcceptLine(makeLine({ state: "flash", value: 0.9 }))).toBe(true);
  });

  it("is false for a conflict line — resolve the rival numbers first", () => {
    expect(canAcceptLine(makeLine({ state: "conflict", value: 0.91 }))).toBe(false);
  });

  it("is false for a blank 'not disclosed' line — no figure the control could promise", () => {
    expect(canAcceptLine(makeLine({ state: "blank", value: null }))).toBe(false);
  });

  it("agrees with promoteSummary about the recovery round-trip", () => {
    // An un-accepted adjusted-EPS line drops the pair out of promotable range
    // (adj no longer accepted) — and is exactly the line canAcceptLine offers
    // back, so the desk can restore the adj basis without a watcher poll.
    const unaccepted = makeLine({ state: "pending", value: 0.91 });
    const revenue = makeLine({
      metric_id: "revenue_q",
      state: "accepted",
      value: 4_340_000_000,
      contract: makeContract({ metric_id: "revenue_q", label: "Revenue", unit: "usd" }),
    });
    expect(promoteSummary([unaccepted, revenue])).toBeNull();
    expect(canAcceptLine(unaccepted)).toBe(true);
  });
});

// ── per-candidate accept on a conflict row ─────────────────────────────
//
// QA finding `today-print-watch--unaccept-after-supersede-keeps-old-value-
// hides-newer-candidate` (HIGH), user ruling 2026-09-02 option 1. Un-accepting
// a superseded line now re-derives it, and a disagreeing pool lands on
// 'conflict' — which carries no top-level number and no line-level accept. The
// desk's move is to accept the rival figure it verified, naming the document.

describe("acceptableRivals", () => {
  it("offers one control per rival figure on a conflict line", () => {
    const line = makeLine({
      state: "conflict",
      value: null,
      candidates_json: JSON.stringify([
        candidate({ doc_id: 10, value: 0.91 }),
        candidate({ doc_id: 12, value: 0.87 }),
      ]),
    });
    const rivals = acceptableRivals(line);
    expect(rivals.map((c) => c.doc_id)).toEqual([10, 12]);
    expect(rivals.map((c) => c.value)).toEqual([0.91, 0.87]);
  });

  it("offers nothing on a line that is not in conflict — the line-level control covers those", () => {
    const candidates = JSON.stringify([candidate({ doc_id: 10 }), candidate({ doc_id: 12, value: 0.87 })]);
    expect(acceptableRivals(makeLine({ state: "agreed", value: 0.91, candidates_json: candidates }))).toEqual([]);
    expect(acceptableRivals(makeLine({ state: "accepted", value: 0.91, candidates_json: candidates }))).toEqual([]);
    expect(acceptableRivals(makeLine({ state: "pending", value: 0.91, candidates_json: candidates }))).toEqual([]);
  });

  it("skips candidates with no figure to lock in — wire flash, not-disclosed, null value", () => {
    const line = makeLine({
      state: "conflict",
      value: null,
      candidates_json: JSON.stringify([
        candidate({ doc_id: 10, value: 0.91 }),
        candidate({ doc_id: 0, representation: "flash", value: 0.9 }),
        candidate({ doc_id: 12, value: null, not_disclosed: true }),
        candidate({ doc_id: 13, value: null }),
      ]),
    });
    expect(acceptableRivals(line).map((c) => c.doc_id)).toEqual([10]);
  });

  it("keeps both readings when ONE document's two representations disagree — the desk names which it read", () => {
    const line = makeLine({
      state: "conflict",
      value: null,
      candidates_json: JSON.stringify([
        candidate({ doc_id: 10, representation: "repA", value: 0.91 }),
        candidate({ doc_id: 10, representation: "repB", value: 0.87 }),
      ]),
    });
    expect(acceptableRivals(line).map((c) => c.representation)).toEqual(["repA", "repB"]);
  });

  it("dedupes identical evidence so one figure gets one control", () => {
    const line = makeLine({
      state: "conflict",
      value: null,
      candidates_json: JSON.stringify([
        candidate({ doc_id: 10, value: 0.91 }),
        candidate({ doc_id: 10, value: 0.91 }),
        candidate({ doc_id: 12, value: 0.87 }),
      ]),
    });
    expect(acceptableRivals(line)).toHaveLength(2);
  });

  it("returns nothing rather than throwing on unreadable evidence", () => {
    expect(acceptableRivals(makeLine({ state: "conflict", candidates_json: "not json" }))).toEqual([]);
    expect(acceptableRivals(makeLine({ state: "conflict", candidates_json: '{"a":1}' }))).toEqual([]);
  });
});

// Slice F task 8: `PrintCard` became `LivePrintRow` and `LineRow` moved to
// `live-print/LineRow.tsx`. The split is the one the panel already had — the
// markup lives on the line, the handler on the row — so each assertion follows
// the code it was written about.
describe("per-candidate accept control (live-print source)", () => {
  const src = readFileSync("app/dashboard/today/live-print/LineRow.tsx", "utf8");
  const rowSrc = readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8");

  it("renders an 'accept this' control against each rival of a conflict row", () => {
    expect(src).toMatch(/acceptableRivals\(line\)/);
    expect(src).toMatch(/"accept this"/);
  });

  it("posts the metric AND the document it verified", () => {
    expect(rowSrc).toMatch(
      /postAccept\(\{ accept: \[\{ metric_id: metricId, doc_id: docId, representation \}\] \}\)/,
    );
  });

  it("reverts the in-flight state and explains a failure rather than swallowing it", () => {
    expect(rowSrc).toMatch(/setAcceptingCandidateKey\(null\)/);
    expect(rowSrc).not.toMatch(/catch \{\s*\}/);
  });

  it("has its own supersession confirm — a candidate accept is not a promote", () => {
    expect(rowSrc).toMatch(/SUPERSEDED_CANDIDATE_CONFIRM_COPY/);
  });
});

describe("per-line accept control (live-print source)", () => {
  const src = readFileSync("app/dashboard/today/live-print/LineRow.tsx", "utf8");
  const rowSrc = readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8");

  it("renders an accept button for non-accepted lines, not only unaccept for accepted ones", () => {
    expect(src).toMatch(/canAcceptLine\(line\)/);
    expect(src).toMatch(/accepting \? "Accepting…" : "accept"/);
  });

  it("posts the single metric through the same accept route the bulk path uses", () => {
    expect(rowSrc).toMatch(/postAccept\(\{ accept: \[metricId\] \}\)/);
    // ...and the bulk path it mirrors, so both still go through the one
    // postAccept helper that owns the pre_print / superseded 409 handling.
    expect(rowSrc).toMatch(/postAccept\(\{ accept: agreedIds \}\)/);
    expect(rowSrc).toMatch(/apiFetch\("\/api\/print-watch\/accept"/);
  });

  it("reverts the in-flight state and explains a failure rather than swallowing it", () => {
    expect(rowSrc).toMatch(/setAcceptingId\(null\)/);
    expect(rowSrc).toMatch(/if \(!res\.ok \|\| !data\?\.success\)/);
    expect(rowSrc).not.toMatch(/catch \{\s*\}/);
  });

  it("keeps the control visible rather than hover-only (touch tap-trap rule)", () => {
    expect(src).not.toMatch(/opacity-0/);
    expect(src).toMatch(/disabled=\{accepting \|\| noEventId\}/);
  });
});

// QA finding `mobile-today-printsheet--detail-column-snippet-offscreen-no-scrollfade`:
// the verify table was a bare `overflow-x-auto` div, so at narrow viewports
// the DETAIL column (every "snippet ▾" evidence expander) sat off-screen
// with no affordance hinting there was more to scroll to. Repo convention
// for horizontally-scrolling tables is the shared <ScrollFade> wrapper
// (see HoldingsTable/AllHoldingsTable) — this pins that it wraps the verify
// table directly, not nested inside a second scroller.
describe("verify table horizontal scroll affordance (live-print source)", () => {
  const src = readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8");

  it("imports the shared ScrollFade component", () => {
    expect(src).toMatch(/import \{ ScrollFade \} from "\.\.\/components\/ScrollFade"/);
  });

  it("wraps the verify table in ScrollFade rather than a bare overflow-x-auto div", () => {
    expect(src).toMatch(/<ScrollFade>\s*<table className="w-full text-\[13px\]"/);
    expect(src).not.toMatch(/<div className="overflow-x-auto">\s*<table className="w-full text-\[13px\]"/);
  });
});

// ── slice C: go request status + effective window (panel pure helpers) ─

describe("goStatusText", () => {
  it("is null with no request, names the phase while queued/claimed, and lists one road outcome per road when done", () => {
    expect(goStatusText(null)).toBeNull();
    expect(goStatusText({ id: 1, status: "queued", attempts: 0, requestedAt: "2026-09-03T20:00:00.000Z", result: null })).toBe("Print is live — queued, waking the watcher…");
    expect(goStatusText({ id: 1, status: "claimed", attempts: 1, requestedAt: "2026-09-03T20:00:00.000Z", result: null })).toBe("Print is live — acquiring (attempt 1)…");
    expect(goStatusText({ id: 1, status: "done", attempts: 1, requestedAt: "2026-09-03T20:00:00.000Z", result: [
      { road: "user-url", outcome: "rejected", detail: "wrong period" }, { road: "dj", outcome: "skipped", detail: "tws offline" }, { road: "edgar", outcome: "ok", detail: "ok — 1 filing(s), 1 exhibit(s)" }, { road: "ir", outcome: "skipped", detail: "IR: none configured" },
    ] })).toBe("Print is live — link: rejected (wrong period) · DJ: skipped (tws offline) · EDGAR: ok · IR: skipped (IR: none configured)");
    expect(goStatusText({ id: 1, status: "failed", attempts: 3, requestedAt: "2026-09-03T20:00:00.000Z", result: [{ road: "dj", outcome: "failed", detail: "scheduler exploded" }] })).toBe("Print is live — FAILED after 3 attempt(s): scheduler exploded");
  });
});

describe("windowText", () => {
  const w = { start: "2026-09-03T19:55:00.000Z", end: "2026-09-03T20:50:00.000Z" };
  it("says when the window opens, that it is open until, or that it closed — in ET — and drop-zone only with no window", () => {
    expect(windowText(null, Date.parse("2026-09-03T19:00:00.000Z"))).toBe("no auto window — drop zone only");
    expect(windowText(w, Date.parse("2026-09-03T19:00:00.000Z"))).toBe("window opens 3:55 PM ET");
    expect(windowText(w, Date.parse("2026-09-03T20:10:00.000Z"))).toBe("window open until 4:50 PM ET");
    expect(windowText(w, Date.parse("2026-09-03T21:00:00.000Z"))).toBe("window closed 4:50 PM ET");
  });
});

describe("live-print source — slice C controls", () => {
  const src = readFileSync("app/dashboard/today/live-print/GoControls.tsx", "utf8");
  const rowSrc = readFileSync("app/dashboard/today/LivePrintRow.tsx", "utf8");
  it("posts go and extend through apiFetch exactly once each and renders the go status inside the card", () => {
    // Slice F folded the button press, the pasted link and the pasted file into
    // ONE call site, so "exactly once" still holds — and now means all three
    // share the same 200/4xx handling and the same non-fatal-wake caveat.
    expect(src.match(/apiFetch\("\/api\/print-watch\/go"/g)?.length).toBe(1);
    expect(src.match(/apiFetch\("\/api\/print-watch\/extend"/g)?.length).toBe(1);
    expect(src).toContain("Print is live");
    expect(src).toContain("Extend 30 min");
    // Brief note (task-8-brief.md step 3.4): calling goStatusText directly on
    // the optional print.goRequest needs `?? null` for strict-null safety, so
    // the literal call site reads `goStatusText(print.goRequest ?? null)` —
    // the brief's own fallback names this prefix as the assertion to use.
    expect(rowSrc).toContain("goStatusText(print.goRequest");
  });
});
