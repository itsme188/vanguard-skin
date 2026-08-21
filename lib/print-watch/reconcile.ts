// Cross-document reconciler for the live print-watch subsystem (spec
// 2026-08-20 §5, Task 5). PURE — no db, no I/O. Takes every candidate ever
// produced for a print (across all documents and all representations) and
// computes the whole line-state sheet in ONE pass (Codex #4: no
// per-document overwrites — a document's absence must never erase another
// document's evidence).
//
// Rule summary (task-5-brief.md + task review ruling round 1 — the review
// found the original agreement rule let disjoint value clusters false-green
// via a lowest-doc_id tie-break; the ruling below replaces it with strict
// unanimity):
//   1. Per metric: split candidates into flash, then (from the rest)
//      value-candidates (not_disclosed false) and ND-candidates
//      (not_disclosed true).
//   2. Agreement (REVISED, review ruling round 1): 'agreed' requires ALL
//      non-flash value-candidates for the metric to be unanimous — every
//      pair matches on value (1e-6 relative) and value_high — AND at least
//      one INDEPENDENT pair among them (different doc_id, OR same doc_id +
//      different representation + weak_pair=false on BOTH). ANY
//      non-flash value disagreement (by value, or independently-sourced
//      with matching value but incompatible table-provenance — both
//      location_hints naming "table N" must name the SAME N, only
//      enforced within one doc_id, cross-doc hints always compatible) ->
//      'conflict', no tie-break, no outlier wins. Flash candidates never
//      participate in agreement and never block it — they are filtered out
//      before this rule runs at all.
//   3. Unanimous but no independent pair (only correlated/non-independent
//      duplicates) -> 'single_source' (renders "single source — verify",
//      never green). Exactly one value-candidate -> 'single_source'
//      trivially. Any disagreement -> 'conflict' (no top-level value;
//      every candidate stays visible via candidates_json for the human to
//      pick from).
//   4. Monotonic ND (Codex #4): ND-candidates never override a
//      value-candidate from another document — when ANY value-candidate
//      exists, ND-candidates are excluded entirely and the state is decided
//      purely by rules 2-3 over the value-candidate pool.
//   5. Flash (REVISED, review ruling round 1 — minor): when there is NO
//      non-flash value-candidate for the metric AND at least one flash
//      candidate exists, the line reports 'flash' with the earliest
//      evidence as a provisional value — regardless of how many ND
//      candidates are also present (an ND-only document must not suppress
//      a flash provisional value). Only when there is no value-candidate
//      AND no flash candidate does the ND-only branch decide: all-ND
//      across >=2 distinct docs -> 'blank'; all-ND from exactly one doc so
//      far -> 'pending'; no candidates at all -> 'pending'.
//   6. acceptedLines pass through untouched — contract/expected/state/
//      value/value_high/snippet/source_doc_id all stay locked to what the
//      user accepted — except candidates_json, which always refreshes to
//      the latest full candidate set so the audit trail stays current. The
//      store layer (upsertLines) re-enforces this lock independently
//      (belt-and-braces); this module is expected to skip accepted lines
//      itself.
//
// Sign guard (REVISED AGAIN, review ruling round 2 — belt-and-braces): the
// round-1 fix (scale-matching a parenthesized token against |value|) itself
// false-dropped when a coincidental footnote/year token happened to match
// |value| at one of the tried scales (e.g. "$(2,000)M (2)" with
// value=2,000,000,000 — the real "2,000" token correctly matches at 1e6,
// but the "(2)" footnote ALSO spuriously matches at 1e3). Round-2 ruling,
// implemented verbatim: the guard applies ONLY when the ENTIRE trimmed
// raw_text is a single parenthesized number — optionally a leading
// currency symbol and/or a trailing scale-letter/percent, e.g. "(7,604)",
// "$(7,604)", "(0.10)", "(3.2)%". In that unambiguous whole-cell case,
// value >= 0 is a genuine sign contradiction and the candidate is dropped.
// Any raw_text with additional content — footnotes, years, prose, more
// than one token — is NOT judged by this guard at all: mixed-string sign
// errors are an accepted risk (false drops silently cost coverage; the
// unanimity rule + human verify are the backstop for anything this narrow
// guard doesn't catch). Dropped candidates never appear in candidates_json.

import type { LineContract, ExpectedValue, TaggedCandidate, PrintWatchLine } from "./types";

const RELATIVE_TOLERANCE = 1e-6;
const TABLE_HINT = /table\s*(\d+)/i;
// The ENTIRE trimmed raw_text must be exactly this shape: optional leading
// "$", a parenthesized number (optional inner "-"/"$", digits/commas,
// optional decimal), then an optional trailing scale letter (M/B/K/T, up
// to 2 chars) and/or "%". Anything else in the string (footnotes, years,
// prose, a second token) fails this match and is left unjudged.
const WHOLE_CELL_PARENTHESIZED = /^\$?\s*\(\s*-?\$?\s*[\d,]+(?:\.\d+)?\s*\)\s*[A-Za-z]{0,2}%?$/;

function passesSignGuard(c: TaggedCandidate): boolean {
  if (c.value === null || c.raw_text === null) return true;
  if (c.value < 0) return true; // already negative — parens can't contradict this
  const isWholeCellContradiction = WHOLE_CELL_PARENTHESIZED.test(c.raw_text.trim());
  return !isWholeCellContradiction;
}

function relativeMatch(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / scale <= RELATIVE_TOLERANCE;
}

function valueHighMatches(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return relativeMatch(a, b);
}

function candidatesAgreeOnValue(a: TaggedCandidate, b: TaggedCandidate): boolean {
  if (a.value === null || b.value === null) return false;
  return relativeMatch(a.value, b.value) && valueHighMatches(a.value_high, b.value_high);
}

function tableNumber(hint: string | null): number | null {
  if (!hint) return null;
  const m = hint.match(TABLE_HINT);
  return m ? Number(m[1]) : null;
}

/** Table-provenance compatibility — only enforced within one doc_id;
 *  cross-doc hints are always compatible (rule 2). */
function locationCompatible(a: TaggedCandidate, b: TaggedCandidate): boolean {
  if (a.doc_id !== b.doc_id) return true;
  const ta = tableNumber(a.location_hint);
  const tb = tableNumber(b.location_hint);
  if (ta === null || tb === null) return true;
  return ta === tb;
}

/** Independent sources per rule 2: different doc_id always qualifies; same
 *  doc_id requires differing representation AND weak_pair=false on both. */
function independent(a: TaggedCandidate, b: TaggedCandidate): boolean {
  if (a.doc_id !== b.doc_id) return true;
  return a.representation !== b.representation && !a.weak_pair && !b.weak_pair;
}

function byLowestDocId(candidates: TaggedCandidate[]): TaggedCandidate {
  return candidates.reduce((min, c) => (c.doc_id < min.doc_id ? c : min));
}

interface ValueOutcome {
  state: "agreed" | "single_source" | "conflict";
  value: number | null;
  value_high: number | null;
  snippet: string | null;
  source_doc_id: number | null;
}

/** Resolves the value-candidate pool (ND and flash already excluded by the
 *  caller) into agreed / single_source / conflict per rules 2-3 (REVISED,
 *  review ruling round 1 — strict unanimity, no tie-break / outlier-wins). */
function reconcileValueCandidates(valueCandidates: TaggedCandidate[]): ValueOutcome {
  if (valueCandidates.length === 1) {
    const c = valueCandidates[0];
    return {
      state: "single_source",
      value: c.value,
      value_high: c.value_high,
      snippet: c.snippet,
      source_doc_id: c.doc_id,
    };
  }

  // Pass 1 — unanimity: EVERY pair must match on value (rule 3's "two+
  // disagreeing" now covers any pairwise mismatch, not just some pairs; a
  // disjoint agreeing cluster is disagreement, not an outlier to discard).
  for (let i = 0; i < valueCandidates.length; i++) {
    for (let j = i + 1; j < valueCandidates.length; j++) {
      if (!candidatesAgreeOnValue(valueCandidates[i], valueCandidates[j])) {
        return { state: "conflict", value: null, value_high: null, snippet: null, source_doc_id: null };
      }
    }
  }

  // Pass 2 — every candidate agrees on value. Now require at least one
  // INDEPENDENT pair for 'agreed'; an independent pair with matching value
  // but incompatible table-provenance is still an explicit conflict signal
  // (pilot amendment #2 — two disclosures rounding to the same figure from
  // different tables must not silently green).
  let hasIndependentPair = false;
  for (let i = 0; i < valueCandidates.length; i++) {
    for (let j = i + 1; j < valueCandidates.length; j++) {
      const a = valueCandidates[i];
      const b = valueCandidates[j];
      if (!independent(a, b)) continue;
      if (!locationCompatible(a, b)) {
        return { state: "conflict", value: null, value_high: null, snippet: null, source_doc_id: null };
      }
      hasIndependentPair = true;
    }
  }

  // All candidates agree on value (and, for any independent pair, on
  // location too) — reporting fields come from the lowest doc_id, which is
  // unambiguous now since every candidate carries the same value.
  const source = byLowestDocId(valueCandidates);
  return {
    state: hasIndependentPair ? "agreed" : "single_source",
    value: source.value,
    value_high: source.value_high,
    snippet: source.snippet,
    source_doc_id: source.doc_id,
  };
}

function reconcileMetric(
  contract: LineContract,
  expectedForMetric: ExpectedValue | null,
  candidates: TaggedCandidate[],
): PrintWatchLine {
  const candidates_json = JSON.stringify(candidates);
  const base = { metric_id: contract.metric_id, contract, expected: expectedForMetric };

  const flashCandidates = candidates.filter((c) => c.representation === "flash");
  const nonFlash = candidates.filter((c) => c.representation !== "flash");
  const valueCandidates = nonFlash.filter((c) => !c.not_disclosed);
  const ndCandidates = nonFlash.filter((c) => c.not_disclosed);

  if (valueCandidates.length === 0) {
    // Rule 5 (REVISED, review ruling round 1 — minor): flash renders
    // whenever there is no non-flash value-candidate, regardless of how
    // many ND documents are also present — an ND-only document must not
    // suppress a flash provisional value.
    if (flashCandidates.length > 0) {
      const source = byLowestDocId(flashCandidates);
      return {
        ...base,
        state: "flash",
        value: source.value,
        value_high: source.value_high,
        snippet: source.snippet,
        source_doc_id: source.doc_id,
        candidates_json,
      };
    }
    if (ndCandidates.length === 0) {
      // No evidence at all yet.
      return { ...base, state: "pending", value: null, value_high: null, snippet: null, source_doc_id: null, candidates_json };
    }
    // Rule 4 — monotonic ND, no value-candidate and no flash: decide
    // purely from how many distinct documents said "not disclosed".
    const distinctDocs = new Set(ndCandidates.map((c) => c.doc_id));
    const state = distinctDocs.size >= 2 ? "blank" : "pending";
    return { ...base, state, value: null, value_high: null, snippet: null, source_doc_id: null, candidates_json };
  }

  // Rule 4 continued: a value-candidate exists, so ND-candidates AND flash
  // candidates are excluded entirely — the state is decided purely by the
  // value-candidate pool (rules 2-3).
  const outcome = reconcileValueCandidates(valueCandidates);
  return {
    ...base,
    state: outcome.state,
    value: outcome.value,
    value_high: outcome.value_high,
    snippet: outcome.snippet,
    source_doc_id: outcome.source_doc_id,
    candidates_json,
  };
}

export function reconcile(
  contracts: LineContract[],
  expected: Record<string, ExpectedValue>,
  all: TaggedCandidate[],
  acceptedLines: PrintWatchLine[],
): PrintWatchLine[] {
  const wellFormed = all.filter(passesSignGuard);

  const byMetric = new Map<string, TaggedCandidate[]>();
  for (const c of wellFormed) {
    const bucket = byMetric.get(c.metric_id);
    if (bucket) bucket.push(c);
    else byMetric.set(c.metric_id, [c]);
  }

  const acceptedByMetric = new Map<string, PrintWatchLine>();
  for (const line of acceptedLines) acceptedByMetric.set(line.metric_id, line);

  return contracts.map((contract) => {
    const candidates = byMetric.get(contract.metric_id) ?? [];
    const accepted = acceptedByMetric.get(contract.metric_id);
    if (accepted) {
      // Rule 6 — locked except candidates_json, which always refreshes.
      return { ...accepted, candidates_json: JSON.stringify(candidates) };
    }
    return reconcileMetric(contract, expected[contract.metric_id] ?? null, candidates);
  });
}
