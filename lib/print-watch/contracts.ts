// Contract compiler + PARALLEL expected-value map, compiled from
// `earnings_bogeys` (migration 043) at arm/watch time (spec 2026-08-20
// §4.4). `expected` is a SEPARATE structure from `contracts` (Codex #22):
// it feeds only the panel's bogey column and must never reach extraction
// (lib/print-watch/extract.ts, Task 4, takes `contracts` alone — no
// `expected` parameter exists on that call).

import type Database from "better-sqlite3";
import type { LineContract, ExpectedValue } from "./types";

interface BogeyRow {
  id: number;
  eps_consensus: number | null;
  eps_whisper: number | null;
  revenue_consensus_usd: number | null;
  revenue_whisper_usd: number | null;
  segment_breakdown_json: string | null;
  guidance_notes: string | null;
  source_label: string | null;
}

type SegmentBreakdown = Record<string, { consensus?: number | null; whisper?: number | null } | undefined>;

interface FieldPick {
  value: number | null;
  sourceLabel: string | null;
}

const NO_PICK: FieldPick = { value: null, sourceLabel: null };

/** Segment name -> URL/metric-id-safe slug: lowercase, non-alphanumeric
 *  runs collapsed to one underscore, trimmed. */
function slugifySegment(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** First non-null value across bogey rows in rowid order, plus the
 *  source_label of the row it came from ("first non-null by rowid wins" —
 *  task-2 brief, applied independently per field). */
function pickFirst(
  rows: BogeyRow[],
  field: "eps_consensus" | "eps_whisper" | "revenue_consensus_usd" | "revenue_whisper_usd",
): FieldPick {
  for (const row of rows) {
    const value = row[field];
    if (value !== null && value !== undefined) {
      return { value, sourceLabel: row.source_label };
    }
  }
  return NO_PICK;
}

/** Builds an ExpectedValue from independently-resolved consensus/whisper
 *  picks, or null when neither field carries any data across every row
 *  (nothing to show in the bogey column for this metric). `source_label`
 *  prefers the consensus pick's row (the headline number) and falls back to
 *  the whisper pick's row when only a whisper is present. */
function buildExpected(consensus: FieldPick, whisper: FieldPick): ExpectedValue | null {
  if (consensus.value === null && whisper.value === null) return null;
  return {
    value: consensus.value,
    value_high: null,
    whisper: whisper.value,
    source_label: consensus.sourceLabel ?? whisper.sourceLabel,
  };
}

const GUIDANCE_RANGE_NOTE = "the UPDATED range if prior and updated appear side by side";

/**
 * Compiles this print's line contracts, plus the PARALLEL bogey
 * consensus/whisper map keyed by metric_id — `symbol` is accepted for
 * signature parity with the rest of the print-watch call chain (arm/watch/
 * reconcile all key on event + symbol); `event_id` alone scopes the
 * `earnings_bogeys` query, so `symbol` is not otherwise consumed here.
 *
 * Always emits `eps_gaap_q` / `eps_adj_q` / `revenue_q`. Adds one
 * `seg_<slug>_revenue_q` contract per distinct segment name found across
 * every bogey row's `segment_breakdown_json`. Adds `revenue_guide_next` +
 * `eps_adj_guide_next` when any bogey row carries non-empty
 * `guidance_notes` — guidance is free text in this schema, so those two
 * contracts never get an `expected` entry (no numeric guidance consensus
 * to map). Definitions are static, value-free strings — the caller can
 * mechanically verify no expected value ever leaks into one.
 */
export function compileContracts(
  db: Database.Database,
  eventId: number,
  symbol: string,
): { contracts: LineContract[]; expected: Record<string, ExpectedValue> } {
  void symbol;

  const rows = db
    .prepare(
      `SELECT id, eps_consensus, eps_whisper, revenue_consensus_usd, revenue_whisper_usd,
              segment_breakdown_json, guidance_notes, source_label
         FROM earnings_bogeys
        WHERE event_id = ?
        ORDER BY id ASC`,
    )
    .all(eventId) as BogeyRow[];

  const contracts: LineContract[] = [];
  const expected: Record<string, ExpectedValue> = {};

  contracts.push({
    metric_id: "eps_gaap_q",
    label: "EPS (GAAP)",
    definition: "GAAP diluted earnings per share for the quarter.",
    basis: "gaap",
    period: "Q",
    currency: "USD",
    unit: "per_share",
    kind: "point",
    segment: null,
  });
  // No `expected` entry for eps_gaap_q: earnings_bogeys' eps_consensus /
  // eps_whisper are adjusted-basis by convention (task-2 brief).

  contracts.push({
    metric_id: "eps_adj_q",
    label: "EPS (Adj.)",
    definition: "Adjusted (non-GAAP) diluted earnings per share for the quarter.",
    basis: "non_gaap",
    period: "Q",
    currency: "USD",
    unit: "per_share",
    kind: "point",
    segment: null,
  });
  const epsAdjExpected = buildExpected(pickFirst(rows, "eps_consensus"), pickFirst(rows, "eps_whisper"));
  if (epsAdjExpected) expected["eps_adj_q"] = epsAdjExpected;

  contracts.push({
    metric_id: "revenue_q",
    label: "Revenue",
    definition: "Total quarterly revenue.",
    basis: "na",
    period: "Q",
    currency: "USD",
    unit: "usd",
    kind: "point",
    segment: null,
  });
  const revenueExpected = buildExpected(
    pickFirst(rows, "revenue_consensus_usd"),
    pickFirst(rows, "revenue_whisper_usd"),
  );
  if (revenueExpected) expected["revenue_q"] = revenueExpected;

  // Segments: merge segment_breakdown_json across every row for this event,
  // first non-null per (segment, field) wins by rowid order, contracts
  // ordered by first-seen segment name.
  const segmentOrder: string[] = [];
  const segmentPicks = new Map<string, { consensus: FieldPick; whisper: FieldPick }>();

  for (const row of rows) {
    if (!row.segment_breakdown_json) continue;
    let parsed: SegmentBreakdown;
    try {
      parsed = JSON.parse(row.segment_breakdown_json) as SegmentBreakdown;
    } catch {
      continue; // malformed stored JSON — skip silently, same convention as the digest composer
    }
    if (!parsed || typeof parsed !== "object") continue;

    for (const [segmentName, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== "object") continue;
      if (!segmentPicks.has(segmentName)) {
        segmentPicks.set(segmentName, { consensus: NO_PICK, whisper: NO_PICK });
        segmentOrder.push(segmentName);
      }
      const pick = segmentPicks.get(segmentName)!;
      if (pick.consensus.value === null && typeof entry.consensus === "number") {
        pick.consensus = { value: entry.consensus, sourceLabel: row.source_label };
      }
      if (pick.whisper.value === null && typeof entry.whisper === "number") {
        pick.whisper = { value: entry.whisper, sourceLabel: row.source_label };
      }
    }
  }

  for (const segmentName of segmentOrder) {
    const metricId = `seg_${slugifySegment(segmentName)}_revenue_q`;
    if (contracts.some((c) => c.metric_id === metricId)) continue; // slug-collision guard
    contracts.push({
      metric_id: metricId,
      label: `${segmentName} Revenue`,
      definition: "Segment revenue for the quarter.",
      basis: "na",
      period: "Q",
      currency: "USD",
      unit: "usd",
      kind: "point",
      segment: segmentName,
    });
    const pick = segmentPicks.get(segmentName)!;
    const segExpected = buildExpected(pick.consensus, pick.whisper);
    if (segExpected) expected[metricId] = segExpected;
  }

  // Guidance: any row carrying non-empty guidance_notes triggers both
  // next-quarter guidance contracts. No `expected` entries — guidance_notes
  // is free text, never a numeric consensus source.
  const hasGuidance = rows.some((r) => r.guidance_notes !== null && r.guidance_notes.trim() !== "");
  if (hasGuidance) {
    contracts.push({
      metric_id: "revenue_guide_next",
      label: "Revenue Guidance (Next Q)",
      definition: `Next-quarter revenue guidance range (${GUIDANCE_RANGE_NOTE}).`,
      basis: "na",
      period: "NQ_guide",
      currency: "USD",
      unit: "usd",
      kind: "range",
      segment: null,
    });
    contracts.push({
      metric_id: "eps_adj_guide_next",
      label: "EPS (Adj.) Guidance (Next Q)",
      definition: `Next-quarter adjusted EPS guidance range (${GUIDANCE_RANGE_NOTE}).`,
      basis: "non_gaap",
      period: "NQ_guide",
      currency: "USD",
      unit: "per_share",
      kind: "range",
      segment: null,
    });
  }

  return { contracts, expected };
}
