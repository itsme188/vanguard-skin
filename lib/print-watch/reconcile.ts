// Cross-document reconciler for the live print-watch subsystem (spec
// 2026-08-20 §5, Task 5). PURE — no db, no I/O. Takes every candidate ever
// produced for a print (across all documents and all representations) and
// computes the whole line-state sheet in ONE pass (Codex #4: no
// per-document overwrites — a document's absence must never erase another
// document's evidence).
//
// Rule summary (task-5-brief.md is the verbatim source of truth):
//   1. Per metric: split candidates into value-candidates (not_disclosed
//      false) and ND-candidates (not_disclosed true).
//   2. Agreement: two candidates from INDEPENDENT sources (different
//      doc_id, OR same doc_id + different representation + weak_pair=false
//      on BOTH) that match on value (1e-6 relative), value_high, and
//      table-provenance (both location_hints naming "table N" must name the
//      SAME N — only enforced within one doc_id; cross-doc hints are always
//      compatible) -> 'agreed'. value/source_doc_id/snippet come from the
//      lowest-doc_id candidate among those that support the agreed value.
//   3. No independent agreement: exactly one value candidate, or only
//      correlated (non-independent) duplicates that agree on value ->
//      'single_source' (renders "single source — verify", never green).
//      Two+ that disagree — either by value, or independently-sourced with
//      matching value but incompatible table provenance — -> 'conflict'
//      (no top-level value; every candidate stays visible via
//      candidates_json for the human to pick from).
//   4. Monotonic ND (Codex #4): ND-candidates never override a
//      value-candidate from another document — when ANY value-candidate
//      exists, ND-candidates are excluded entirely and the state is decided
//      purely by rules 2-3 over the value-candidate pool. Only when there
//      is NO value-candidate at all: all-ND across >=2 distinct docs ->
//      'blank'; all-ND from exactly one doc so far -> 'pending' (more
//      sources may still land).
//   5. Flash-representation candidates are excluded from rules 2-4 entirely
//      (flash can never green — pilot amendment #3), EXCEPT when they are
//      the ONLY candidates present for the metric, in which case the line
//      reports 'flash' with the earliest evidence as a provisional value.
//   6. acceptedLines pass through untouched — contract/expected/state/
//      value/value_high/snippet/source_doc_id all stay locked to what the
//      user accepted — except candidates_json, which always refreshes to
//      the latest full candidate set so the audit trail stays current. The
//      store layer (upsertLines) re-enforces this lock independently
//      (belt-and-braces); this module is expected to skip accepted lines
//      itself.
//
// Sign guard (belt-and-braces): a candidate whose raw_text parenthesizes
// the number — the universal financial-statement negative-number notation
// — but whose parsed `value` is >= 0 contradicts itself and is dropped
// before any of the above runs. Dropped candidates never appear in
// candidates_json.

import type { LineContract, ExpectedValue, TaggedCandidate, PrintWatchLine } from "./types";

const RELATIVE_TOLERANCE = 1e-6;
const TABLE_HINT = /table\s*(\d+)/i;
// Matches "(1,234)", "($1,234.5)", "(4.2%)" — parentheses wrapped around a
// number, the standard financial-statement negative-number notation.
const PARENTHESIZED_NUMBER = /\(\s*-?\$?\s*[\d,]*\d(?:\.\d+)?\s*%?\s*\)/;

function passesSignGuard(c: TaggedCandidate): boolean {
  if (c.value === null || c.raw_text === null) return true;
  if (PARENTHESIZED_NUMBER.test(c.raw_text) && c.value >= 0) return false;
  return true;
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
 *  caller) into agreed / single_source / conflict per rules 2-3. */
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

  const agreeingPairs: Array<[TaggedCandidate, TaggedCandidate]> = [];
  let hasConflictSignal = false;

  for (let i = 0; i < valueCandidates.length; i++) {
    for (let j = i + 1; j < valueCandidates.length; j++) {
      const a = valueCandidates[i];
      const b = valueCandidates[j];
      const valsMatch = candidatesAgreeOnValue(a, b);

      if (!valsMatch) {
        // Any two candidates that disagree on value are a conflict signal,
        // independent or not (rule 3's "two+ disagreeing").
        hasConflictSignal = true;
        continue;
      }
      if (!independent(a, b)) {
        // Correlated duplicates that agree — not enough for 'agreed', not a
        // conflict either (rule 3's "weak_pair-correlated duplicates").
        continue;
      }
      if (!locationCompatible(a, b)) {
        // Independent + matching value + incompatible provenance: an
        // explicit conflict signal even though the numbers match (pilot
        // amendment #2 — two disclosures rounding to the same figure from
        // different tables must not silently green).
        hasConflictSignal = true;
        continue;
      }
      agreeingPairs.push([a, b]);
    }
  }

  if (agreeingPairs.length > 0) {
    // Deterministic tie-break if disjoint agreeing clusters exist: the
    // earliest evidence (lowest doc_id pair) wins. The reported
    // "agreeing candidates" set is every value-candidate that matches THAT
    // value, so source_doc_id is the lowest doc_id among candidates that
    // actually support the reported value.
    agreeingPairs.sort((p1, p2) => {
      const min1 = Math.min(p1[0].doc_id, p1[1].doc_id);
      const min2 = Math.min(p2[0].doc_id, p2[1].doc_id);
      if (min1 !== min2) return min1 - min2;
      const max1 = Math.max(p1[0].doc_id, p1[1].doc_id);
      const max2 = Math.max(p2[0].doc_id, p2[1].doc_id);
      return max1 - max2;
    });
    const winner = agreeingPairs[0][0];
    const cluster = valueCandidates.filter((c) => candidatesAgreeOnValue(c, winner));
    const source = byLowestDocId(cluster);
    return {
      state: "agreed",
      value: source.value,
      value_high: source.value_high,
      snippet: source.snippet,
      source_doc_id: source.doc_id,
    };
  }

  if (hasConflictSignal) {
    return { state: "conflict", value: null, value_high: null, snippet: null, source_doc_id: null };
  }

  // Only correlated (non-independent) duplicates that all agree — one
  // effective source, reported from its lowest doc_id.
  const source = byLowestDocId(valueCandidates);
  return {
    state: "single_source",
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
  const nonFlash = candidates.filter((c) => c.representation !== "flash");

  if (nonFlash.length === 0) {
    if (candidates.length === 0) {
      return { ...base, state: "pending", value: null, value_high: null, snippet: null, source_doc_id: null, candidates_json };
    }
    // Rule 5 — flash candidates only. Flash can never green; report the
    // earliest evidence as a provisional value.
    const source = byLowestDocId(candidates);
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

  const valueCandidates = nonFlash.filter((c) => !c.not_disclosed);
  const ndCandidates = nonFlash.filter((c) => c.not_disclosed);

  if (valueCandidates.length === 0) {
    // Rule 4 — monotonic ND, no value-candidate anywhere: decide purely
    // from how many distinct documents said "not disclosed".
    const distinctDocs = new Set(ndCandidates.map((c) => c.doc_id));
    const state = distinctDocs.size >= 2 ? "blank" : "pending";
    return { ...base, state, value: null, value_high: null, snippet: null, source_doc_id: null, candidates_json };
  }

  // Rule 4 continued: a value-candidate exists, so ND-candidates from other
  // documents are excluded entirely — the state is decided purely by the
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
