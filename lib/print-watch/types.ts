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
  | "accepted";

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

/** A candidate tagged with where it came from — reconciliation identity. */
export interface TaggedCandidate extends ParseCandidate {
  doc_id: number;
  representation: "repA" | "repB" | "flash";
  /** True when this doc was plain text parsed twice by the same prompt —
   *  such pairs are NOT independent and can never green alone (Codex #3). */
  weak_pair: boolean;
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
}

/** Raw row shape of `print_watch_documents` — 1:1 with the table's columns. */
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
}
