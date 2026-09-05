// Deterministic facts for the first-pass read (spec §4.4 "Deterministic facts
// first"): the scoreboard is computed HERE, in code, from VALIDATED sheet rows
// only — accepted, with a value, not contradicted by later evidence. No model
// output ever writes a fact. Slice E's recap composer may only ever see
// `directionSafeFacts` (verdict words), never a number from this module.
import type Database from "better-sqlite3";
import { getSheet } from "./store";
import { reconcile } from "./reconcile";
import type { ExpectedValue, PrintWatchLine, TaggedCandidate } from "./types";
import { INLINE_BAND_PCT, VENDOR_BASIS_LABEL, type DirectionSafeFacts, type ReadFact, type ReadVerdict } from "./first-pass-types";

export function deltaPctNumber(expected: number | null, actual: number | null): number | null {
  if (expected === null || actual === null) return null;
  if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected === 0) return null;
  return Math.round(((actual - expected) / Math.abs(expected)) * 100 * 100) / 100;
}

export function verdictFor(deltaPct: number | null): ReadVerdict {
  if (deltaPct === null) return "n/a";
  if (deltaPct > INLINE_BAND_PCT) return "beat";
  if (deltaPct < -INLINE_BAND_PCT) return "miss";
  return "inline";
}

function valuesDiverge(accepted: number | null, fresh: number | null): boolean {
  if (accepted === null && fresh === null) return false;
  if (accepted === null || fresh === null) return true;
  return Math.abs(accepted - fresh) > Math.max(1e-9, Math.abs(accepted) * 1e-6);
}

/**
 * Re-implementation of the panel's `needsReverify` (PrintWatchPanel.tsx) for
 * lib-side use — the panel is a "use client" module lib code must not import.
 * Trigger (a): a fresh independent agreement diverging from the locked value.
 * Trigger (b): any non-flash candidate from a STRICTLY LATER document that
 * diverges. tests/print-watch/read-facts.test.ts pins parity with the panel.
 */
export function isContradictedAccepted(line: PrintWatchLine): boolean {
  if (line.state !== "accepted" || line.value === null) return false;
  let candidates: TaggedCandidate[];
  try {
    const parsed: unknown = JSON.parse(line.candidates_json);
    if (!Array.isArray(parsed)) return false;
    candidates = parsed as TaggedCandidate[];
  } catch {
    return false;
  }
  if (candidates.length === 0) return false;

  // Trigger (a): a fresh independent agreement diverging from the locked
  // value.
  const expectedMap: Record<string, ExpectedValue> = {};
  const [fresh] = reconcile([line.contract], expectedMap, candidates, []);
  if (fresh && fresh.state === "agreed" && fresh.value !== null) {
    if (valuesDiverge(line.value, fresh.value) || valuesDiverge(line.value_high, fresh.value_high)) return true;
  }

  // Trigger (b): any non-flash candidate from a strictly later document that
  // conflicts with the locked value.
  for (const c of candidates) {
    if (c.representation === "flash") continue;
    if (c.not_disclosed || c.value === null) continue;
    if (typeof line.source_doc_id === "number" && c.doc_id <= line.source_doc_id) continue;
    if (valuesDiverge(line.value, c.value) || valuesDiverge(line.value_high, c.value_high)) return true;
  }
  return false;
}

/** `vendorEps` = the first non-null earnings_bogeys.eps_consensus_vendor for
 *  the event (lowest id), or null. */
export function factsFromLines(lines: PrintWatchLine[], vendorEps: number | null): ReadFact[] {
  const out: ReadFact[] = [];
  for (const l of lines) {
    if (l.state !== "accepted" || l.value === null) continue;
    if (isContradictedAccepted(l)) continue;
    const isRange = l.contract.kind === "range";
    const consensus = l.expected?.value ?? null;
    const isAdjEps = l.metric_id === "eps_adj_q";
    const vendor = isAdjEps ? vendorEps : null;
    const basis: "specified" | "unspecified" | null = consensus !== null ? "specified" : vendor !== null ? "unspecified" : null;
    const source = consensus !== null ? (l.expected?.source_label ?? null) : vendor !== null ? VENDOR_BASIS_LABEL : (l.expected?.source_label ?? null);
    const delta = isRange ? null : deltaPctNumber(consensus, l.value);
    out.push({
      metric_id: l.metric_id,
      label: l.contract.label,
      state: "accepted",
      unit: l.contract.unit,
      period: l.contract.period,
      kind: l.contract.kind,
      actual: l.value,
      actual_high: l.value_high,
      expected_consensus: consensus,
      expected_whisper: l.expected?.whisper ?? null,
      expected_source: source,
      expected_consensus_vendor: vendor,
      expected_basis: basis,
      delta_pct: delta,
      verdict: isRange ? "range" : verdictFor(delta),
    });
  }
  return out;
}

export function buildReadFacts(db: Database.Database, printId: number): ReadFact[] {
  const print = db.prepare(`SELECT event_id FROM print_watch_prints WHERE id = ?`).get(printId) as { event_id: number } | undefined;
  if (!print) return [];
  // Dedicated one-line SELECT rather than getBogeysForEvent (which orders by
  // linked-article received_at / uploaded_at DESC for the email composer's
  // "newest issue" needs, not by id) — see lib/queries/earnings-bogeys.ts.
  const vendorRow = db
    .prepare(`SELECT eps_consensus_vendor FROM earnings_bogeys WHERE event_id = ? AND eps_consensus_vendor IS NOT NULL ORDER BY id LIMIT 1`)
    .get(print.event_id) as { eps_consensus_vendor: number } | undefined;
  const vendor = vendorRow?.eps_consensus_vendor ?? null;
  return factsFromLines(getSheet(db, printId), vendor);
}

export function directionSafeFacts(facts: ReadFact[]): DirectionSafeFacts {
  const mapped = facts.map((f) => ({ metric_id: f.metric_id, label: f.label, verdict: f.verdict }));
  // THE ONE PLACE the direction-safe brand is applied (R-E2). Freezing makes
  // the runtime match the readonly type, so a consumer cannot push a fact with
  // numbers back in after the sanitising map.
  return Object.freeze(mapped) as DirectionSafeFacts;
}
