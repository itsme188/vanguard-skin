// Shared types for the live print-watch subsystem (spec 2026-08-20 §5, v1
// subset + Codex plan-review fixes). Task 1 foundation — later tasks depend
// on these EXACT names; do not rename without updating every consumer.

export type PrintWatchState =
  | "scheduled"
  | "window_open"
  | "acquired"
  | "parsed"
  | "expired"
  | "disarmed";

export type LineStateKind =
  | "pending"
  | "flash"
  | "single_source"
  | "agreed"
  | "conflict"
  | "blank"
  | "accepted"
  /** The contract this line was built from no longer applies to the print
   *  (089/slice B): the row survives as the audit trail of what was measured,
   *  but it is never promoted and never counted as coverage. */
  | "retired";

export interface LineContract {
  metric_id: string;
  label: string;
  definition: string;
  basis: "gaap" | "non_gaap" | "na";
  period: "Q" | "NQ_guide" | "FY_guide";
  currency: string;
  unit: "per_share" | "usd" | "percent" | "count";
  kind: "point" | "range";
  segment: string | null;
}

export interface ExpectedValue {
  value: number | null;
  value_high: number | null;
  whisper: number | null;
  source_label: string | null;
}

export interface ParseCandidate {
  metric_id: string;
  value: number | null;
  value_high: number | null;
  raw_text: string | null;
  snippet: string | null;
  location_hint: string | null;
  not_disclosed: boolean;
}

/**
 * How a candidate was READ out of its document. Two readings of the SAME
 * document only count as independent when they came off different
 * representations (`repA` tables vs `repB` raw text, or a PDF's extracted text
 * vs its native rendering) — see `weak_pair`.
 */
export type CandidateRepresentation = "repA" | "repB" | "flash" | "pdfText" | "pdfNative";

/** A candidate tagged with where it came from — reconciliation identity. */
export interface TaggedCandidate extends ParseCandidate {
  doc_id: number;
  representation: CandidateRepresentation;
  /** True when this doc was plain text parsed twice by the same prompt —
   *  such pairs are NOT independent and can never green alone (Codex #3). */
  weak_pair: boolean;
  /** Present on BOTH readings of a PDF until the pre-registered holdout
   *  passes (spec §4.2 "PDF"): the two readings of one PDF are provisionally
   *  treated as a weak pair, and this note says why. */
  pair_note?: "pdf-weak";
}

export interface PrintWatchLine {
  metric_id: string;
  contract: LineContract;
  expected: ExpectedValue | null;
  state: LineStateKind;
  value: number | null;
  value_high: number | null;
  snippet: string | null;
  source_doc_id: number | null;
  candidates_json: string; // JSON TaggedCandidate[]
  /** Append-only trail of what happened to this line (acceptances,
   *  supersessions). `undefined` from a caller means "not supplied" and
   *  PRESERVES whatever is stored — `upsertLines` never nulls it by omission. */
  audit_json?: string | null;
}

export type PrintWatchDocKind = "dj-release" | "edgar-ex99" | "ir-page" | "user-drop" | "user-url";

/** Raw row shape of `print_watch_prints` — 1:1 with the table's columns. */
export interface PrintRow {
  id: number;
  event_id: number;
  symbol: string;
  event_date: string;
  release_time_et: string | null;
  state: PrintWatchState;
  created_at: string;
  updated_at: string;
  /** ISO UTC; stamped ONCE by the first go press (spec §9 ruling 2). */
  forced_open_at: string | null;
  /** ISO UTC; every "Extend 30 min" press writes max(now, current end) + 30m. */
  window_extended_until: string | null;
}

export type GoRequestStatus = "queued" | "claimed" | "done" | "failed";
export type GoInputKind = "none" | "url" | "file";

export interface GoRequestRow {
  id: number;
  print_id: number;
  status: GoRequestStatus;
  requested_at: string;
  input_kind: GoInputKind;
  input_url: string | null;
  input_sha256: string | null;
  input_bytes_path: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  attempts: number;
  result_json: string | null;
  finished_at: string | null;
}

/** One road's answer to a go request — what `result_json` holds. `"system"`
 *  (amendment #12) covers a non-road failure such as an abandoned claim. */
export interface RoadReport {
  road: "user-drop" | "user-url" | "dj" | "edgar" | "ir" | "system";
  outcome: string;
  detail: string;
}

/** The two verdicts a document carries: one for its CONTENT (does this text
 *  belong to this event at all?) and one per ROAD it arrived by. */
export type GateVerdictKind = "accepted" | "rejected";

/** Where a document sits in the parse pipeline. `claimed` is held by ONE
 *  worker under a token; `failed` means the attempt budget is spent. */
export type ParseState = "queued" | "claimed" | "parsed" | "failed";

/** Raw row shape of `print_watch_documents` — 1:1 with migration 089's columns. */
export interface DocumentRow {
  id: number;
  print_id: number;
  kind: PrintWatchDocKind;
  source: string;
  url: string | null;
  sha256: string;
  bytes_path: string;
  parsed_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  gate_verdict: GateVerdictKind;
  gate_reason: string | null;
  gate_version: number;
  gate_fingerprint: string | null;
  parse_state: ParseState;
  parse_claim_token: string | null;
  parse_claimed_at: string | null;
  parse_attempts: number;
  parse_last_error: string | null;
  text_sha256: string | null;
}

/** Raw row shape of `print_watch_document_roads` — one provenance row per
 *  (document, kind, source) that delivered the same bytes. */
export interface DocumentRoadRow {
  document_id: number;
  kind: PrintWatchDocKind;
  source: string;
  url: string | null;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  road_verdict: GateVerdictKind;
  road_reason: string | null;
}

/** Raw row shape of `print_watch_ir_baseline` — the completion marker for one
 *  event's IR-page baseline, versioned by the IR URL's fingerprint. */
export interface IrBaselineRow {
  event_id: number;
  source_fingerprint: string;
  link_count: number;
  completed_at: string;
}

/** Raw row shape of `print_watch_sources` — the per-symbol IR newsroom page. */
export interface PrintWatchSourceRow {
  symbol: string;
  ir_page_url: string;
  link_must_contain: string | null;
  created_at: string;
  updated_at: string;
}
