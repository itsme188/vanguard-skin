// Shared types for the live print-watch "first-pass read" subsystem (spec
// 2026-08-20 §4.4, slice D). ONE owner (task 2, ruling R-D4): written here in
// its FINAL shape so later tasks (5, 6, 8, 10, 11) never need to edit it.
import type { LineContract } from "./types";

export type ReadVerdict = "beat" | "inline" | "miss" | "range" | "n/a";

export type ExpectedBasis = "specified" | "unspecified";

export interface ReadFact {
  metric_id: string;
  label: string;
  state: "accepted";
  unit: LineContract["unit"];
  period: LineContract["period"];
  kind: LineContract["kind"];
  actual: number;
  actual_high: number | null;
  /** The line-level consensus (compileContracts: eps_consensus /
   *  revenue_consensus_usd / segment JSON) — the ONLY value a delta is ever
   *  computed against. */
  expected_consensus: number | null;
  expected_whisper: number | null;
  expected_source: string | null;
  /** The vendor (Finnhub) EPS figure, shown but never compared (slice A D1).
   *  Non-null only on eps_adj_q. */
  expected_consensus_vendor: number | null;
  /** "specified" when expected_consensus is present; "unspecified" when only
   *  the vendor figure exists; null when neither. */
  expected_basis: ExpectedBasis | null;
  delta_pct: number | null;
  verdict: ReadVerdict;
}

/** The ONLY view slice E's recap composer may receive (spec §4.4 data-flow
 *  contract): verdict words, no numbers. */
export type DirectionSafeFacts = ReadonlyArray<{ metric_id: string; label: string; verdict: ReadVerdict }>;

export type ReadStatus = "generating" | "done" | "failed" | "superseded";

export type ReadErrorCode = "model_error" | "timeout" | "sanitisation" | "model_drift" | "cites" | "attempt_cap" | "takeover";

export interface ReadRow {
  id: number;
  print_id: number;
  fingerprint: string;
  nonce: number;
  status: ReadStatus;
  claim_token: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  attempts: number;
  next_retry_at: string | null;
  model_id: string | null;
  facts_json: string | null;
  prose_json: string | null;
  error: string | null;
  error_code: ReadErrorCode | null;
  generated_at: string | null;
  created_at: string;
}

export interface ReadProse {
  read: string[];
  call_watch: string[];
  caveats: string[];
}

export type CalloutUnit = "usd" | "percent" | "per_share" | "count";

export type CalloutState = "proposed" | "accepted" | "revoked" | "superseded";

export interface CalloutProposal {
  label: string;
  value_text: string;
  snippet: string;
  doc_id: number;
}

export interface CalloutRow {
  id: number;
  print_id: number;
  read_id: number | null;
  label: string;
  label_norm: string;
  value: number;
  value_high: number | null;
  unit: CalloutUnit;
  value_text: string;
  snippet: string;
  doc_id: number | null;
  doc_sha256: string;
  evidence_sha256: string;
  verifier_version: number;
  vs_bogey_text: string | null;
  state: CalloutState;
  accepted_at: string | null;
  revoked_at: string | null;
  superseded_by_read_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface CalloutView extends CalloutRow {
  effective_state: CalloutState;
  doc_kind: string | null;
}

export const INLINE_BAND_PCT = 0.5;
export const VENDOR_BASIS_LABEL = "vendor, basis unspecified";
