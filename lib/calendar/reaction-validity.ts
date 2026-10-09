/**
 * One home for the question "is this reaction a measurement yet?".
 *
 * A reaction is the move from just before a release (or the prior close, for
 * earnings) to the price `window_min` minutes after it. Until that window has
 * elapsed there is nothing to measure, and a figure stored or shown before
 * then is a missing measurement dressed up as a number (owner ruling
 * 2026-10-08, finding
 * `today-week-ahead--reaction-line-zero-pct-from-window-that-never-elapsed`).
 *
 * Three users share this file, so the rule cannot drift between them:
 *   - the capture gate   (lib/calendar/enrichment-runner.ts) — refuses to
 *     store a snapshot before the window has elapsed, and stamps the capture
 *     instant on every snapshot it does store;
 *   - the renderers      (app/dashboard/components/calendar/EnrichmentChips.tsx)
 *     — show "pending", never a percent, for a leg that is not a measurement;
 *   - the repair script  (scripts/repair-premature-reaction-snapshots.ts);
 *   - every TEXT reader, through `readReactionLegs` below: the earnings email
 *     composer (scoreboard, recap prompt, read-through bullets), the weekly
 *     briefing, the macro-themes event line, the chat tool and the email
 *     viewer's rebuilt scoreboard. Outbound text and prompts OMIT a pending
 *     leg; only in-app surfaces may say "pending". The print push composer
 *     (lib/alerts/print-push-message.ts) is import-free by design and carries
 *     an inlined copy of the snapshot-only part of the rule.
 *
 * Client-safe and pure: the only import is the dependency-free
 * reaction-snapshot-core leaf (never lib/calendar/reaction-snapshot.ts, which
 * drags @stoqey/ib into a browser bundle).
 *
 * Evidence, strongest first:
 *   1. `captured_at` on the snapshot (written by the Mac runner since
 *      2026-10-08). Earlier than t0 + window  =>  the whole snapshot is
 *      premature. At or after it  =>  every usable leg is a measurement, even
 *      a flat one.
 *   2. No `captured_at` (older rows, and every snapshot the Worker captures):
 *      a) a pre/post pair with the identical price is not trusted as a move;
 *      b) a leg that rounds to exactly 0.00% on a row whose `enriched_at`
 *         stamp falls before the window could have been measured is not
 *         trusted either. `enriched_at` alone is NOT proof of an early
 *         capture (a cloud actual can stamp it minutes after the print while
 *         the reaction arrives two hours later), which is why it only counts
 *         together with a zero move.
 */

import {
  isUsableReactionLeg,
  type BenchmarkReaction,
  type ReactionSnapshot,
} from "./reaction-snapshot-core";

/** Every stored snapshot declares 120; used when the field is missing. */
export const DEFAULT_REACTION_WINDOW_MIN = 120;

/**
 * How far from its target a bar may sit and still count (the matcher's
 * nearest-bar tolerance). Single-sourced here; lib/calendar/reaction-snapshot.ts
 * imports it. The Worker keeps its own copy in workers/cron/src/reaction-matcher.ts.
 */
export const REACTION_BAR_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * How long after a release the Mac runner still tries to capture a missing
 * reaction (release + 150 minutes: the 120-minute window plus 30 of slack).
 * Past this a NULL reaction_snapshot stays NULL unless someone backfills it.
 * The runner's REACTION_SETTLE_MS is this value; the repair script reads it to
 * say whether a cleared row will be re-captured.
 */
export const REACTION_RECAPTURE_HORIZON_MS = 150 * 60 * 1000;

export const REACTION_LEG_KEYS = ["symbol", "spy", "qqq", "tlt", "sector"] as const;
export type ReactionLegKey = (typeof REACTION_LEG_KEYS)[number];
const CORE_LEG_KEYS: readonly ReactionLegKey[] = ["spy", "qqq", "tlt"];

function windowMinOf(snapshot: Pick<ReactionSnapshot, "window_min"> | null | undefined): number {
  const w = snapshot?.window_min as number | undefined;
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : DEFAULT_REACTION_WINDOW_MIN;
}

/** The instant the reaction window ends: release + window. */
export function reactionWindowEndMs(
  releaseMs: number,
  windowMin: number = DEFAULT_REACTION_WINDOW_MIN,
): number {
  return releaseMs + windowMin * 60 * 1000;
}

/** True once `nowMs` has reached release + window. NaN inputs fail closed. */
export function isReactionWindowElapsed(
  releaseMs: number,
  nowMs: number,
  windowMin: number = DEFAULT_REACTION_WINDOW_MIN,
): boolean {
  if (!Number.isFinite(releaseMs) || !Number.isFinite(nowMs)) return false;
  return nowMs >= reactionWindowEndMs(releaseMs, windowMin);
}

/** Window end of a stored snapshot, or null when its t0 cannot be read. */
export function snapshotWindowEndMs(snapshot: ReactionSnapshot | null | undefined): number | null {
  if (!snapshot?.t0_utc) return null;
  const t0 = Date.parse(snapshot.t0_utc);
  if (!Number.isFinite(t0)) return null;
  return reactionWindowEndMs(t0, windowMinOf(snapshot));
}

/**
 * Parse a stored timestamp as UTC. Accepts ISO ("2026-01-05T15:00:00.000Z")
 * and SQLite datetime('now') ("2026-01-05 15:00:00", UTC with no marker).
 */
export function parseUtcInstantMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const ms = Date.parse(hasZone ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export interface ReactionEvidence {
  /** The row's `enriched_at` (SQLite UTC or ISO). Weak evidence; see file header. */
  rowEnrichedAt?: string | null;
}

/**
 * - "absent":   no leg, or a dead/zero quote (isUsableReactionLeg) — show nothing / a dash.
 * - "pending":  a figure exists but is not a measurement — show "pending".
 * - "measured": show the percent.
 */
export type ReactionLegState = "measured" | "pending" | "absent";

export type ReactionLegReason =
  | "captured_before_window_end"
  | "identical_pre_post"
  | "zero_move_enriched_before_window_end";

export function reactionLegVerdict(
  snapshot: ReactionSnapshot | null | undefined,
  leg: BenchmarkReaction | null | undefined,
  evidence: ReactionEvidence = {},
): { state: ReactionLegState; reason?: ReactionLegReason } {
  if (!snapshot || !isUsableReactionLeg(leg)) return { state: "absent" };

  const windowEnd = snapshotWindowEndMs(snapshot);
  const capturedAt = parseUtcInstantMs(snapshot.captured_at);

  if (capturedAt != null) {
    // Strong evidence either way. An unreadable t0 fails closed.
    if (windowEnd == null || capturedAt < windowEnd) {
      return { state: "pending", reason: "captured_before_window_end" };
    }
    return { state: "measured" };
  }

  // No capture stamp: older rows and cloud-captured rows.
  if (leg.t_pre === leg.t_post) {
    return { state: "pending", reason: "identical_pre_post" };
  }
  if (leg.delta_pct === 0 && windowEnd != null) {
    const enrichedAt = parseUtcInstantMs(evidence.rowEnrichedAt);
    // The matcher itself accepts a bar up to the tolerance before the target,
    // so only an enrichment stamp earlier than that is "too early".
    if (enrichedAt != null && enrichedAt < windowEnd - REACTION_BAR_TOLERANCE_MS) {
      return { state: "pending", reason: "zero_move_enriched_before_window_end" };
    }
  }
  return { state: "measured" };
}

export function reactionLegState(
  snapshot: ReactionSnapshot | null | undefined,
  leg: BenchmarkReaction | null | undefined,
  evidence: ReactionEvidence = {},
): ReactionLegState {
  return reactionLegVerdict(snapshot, leg, evidence).state;
}

export interface ReactionSnapshotAssessment {
  /** The whole snapshot was captured before its window ended (strong evidence). */
  premature: boolean;
  /** Legs holding a figure that is not a measurement. */
  pendingLegs: Array<{ key: ReactionLegKey; reason: ReactionLegReason }>;
  /** Legs stored as a dead/zero quote (the old {t_pre 0, t_post 0} placeholder). */
  placeholderLegs: ReactionLegKey[];
  /** Legs that are real measurements. */
  measuredLegs: ReactionLegKey[];
  /** Nothing to repair. */
  valid: boolean;
}

/** Whole-snapshot view of reactionLegVerdict — what the repair script reads. */
export function assessReactionSnapshot(
  snapshot: ReactionSnapshot,
  evidence: ReactionEvidence = {},
): ReactionSnapshotAssessment {
  const pendingLegs: ReactionSnapshotAssessment["pendingLegs"] = [];
  const placeholderLegs: ReactionLegKey[] = [];
  const measuredLegs: ReactionLegKey[] = [];
  for (const key of REACTION_LEG_KEYS) {
    const leg = snapshot[key];
    if (leg == null) continue;
    const verdict = reactionLegVerdict(snapshot, leg, evidence);
    if (verdict.state === "absent") placeholderLegs.push(key);
    else if (verdict.state === "pending" && verdict.reason) pendingLegs.push({ key, reason: verdict.reason });
    else measuredLegs.push(key);
  }
  const capturedAt = parseUtcInstantMs(snapshot.captured_at);
  const windowEnd = snapshotWindowEndMs(snapshot);
  const premature = capturedAt != null && (windowEnd == null || capturedAt < windowEnd);
  return {
    premature,
    pendingLegs,
    placeholderLegs,
    measuredLegs,
    valid: !premature && pendingLegs.length === 0 && placeholderLegs.length === 0,
  };
}

/**
 * The capture gate. Given whatever a capture returned and the instant it was
 * taken, return the snapshot that may be stored, or null when nothing may be.
 *
 *   - before release + window: null (the caller leaves reaction_snapshot NULL
 *     and a later tick tries again);
 *   - a dead/zero-quote leg is dropped, never stored as a measurement;
 *   - with no usable SPY/QQQ/TLT leg left there is no snapshot;
 *   - what is stored carries `captured_at`, so every reader can tell later.
 */
export function admitCapturedReaction(
  snapshot: ReactionSnapshot | null | undefined,
  capturedAtMs: number,
): ReactionSnapshot | null {
  if (!snapshot) return null;
  const windowEnd = snapshotWindowEndMs(snapshot);
  if (windowEnd == null || !Number.isFinite(capturedAtMs) || capturedAtMs < windowEnd) return null;

  const admitted: ReactionSnapshot = { ...snapshot };
  for (const key of REACTION_LEG_KEYS) {
    if (admitted[key] != null && !isUsableReactionLeg(admitted[key])) delete admitted[key];
  }
  if (!CORE_LEG_KEYS.some((key) => admitted[key] != null)) return null;
  admitted.captured_at = new Date(capturedAtMs).toISOString();
  return admitted;
}

/**
 * Remove the named legs from a snapshot. Returns null when no usable
 * SPY/QQQ/TLT leg would remain (the snapshot then says nothing).
 */
export function withoutReactionLegs(
  snapshot: ReactionSnapshot,
  keys: readonly ReactionLegKey[],
): ReactionSnapshot | null {
  const next: ReactionSnapshot = { ...snapshot };
  for (const key of keys) delete next[key];
  if (!CORE_LEG_KEYS.some((key) => isUsableReactionLeg(next[key]))) return null;
  return next;
}

/** A leg as stored; `symbol` rides along on the sector and own-stock legs. */
export type StoredReactionLeg = BenchmarkReaction & { symbol?: string };

export interface ReactionLegRead {
  /** The parsed snapshot as stored (metadata: t0_utc, window_min, source, pre_anchor). */
  snapshot: ReactionSnapshot;
  /** Only the legs that are real measurements; safe to print as a percent. */
  measured: Partial<Record<ReactionLegKey, StoredReactionLeg>>;
  /** Legs holding a figure that is not a measurement. Never print their percent. */
  pending: ReactionLegKey[];
}

/**
 * The one read path for anything that turns a stored snapshot into text.
 *
 * Takes the raw `calendar_events.reaction_snapshot` column (or an already
 * parsed snapshot) and sorts each leg through `reactionLegVerdict`. Returns
 * null when there is nothing readable at all (NULL column, malformed JSON, a
 * non-object). A dead/zero-quote leg is in neither list (it is absent).
 *
 * Pass `rowEnrichedAt` whenever the row is at hand: without it only the
 * evidence the snapshot itself carries is used (`captured_at`, and an
 * identical pre/post pair on a snapshot with no capture stamp).
 */
export function readReactionLegs(
  raw: string | ReactionSnapshot | null | undefined,
  evidence: ReactionEvidence = {},
): ReactionLegRead | null {
  let snapshot: unknown = raw;
  if (typeof raw === "string") {
    try {
      snapshot = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (snapshot == null || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const snap = snapshot as ReactionSnapshot;
  const measured: ReactionLegRead["measured"] = {};
  const pending: ReactionLegKey[] = [];
  for (const key of REACTION_LEG_KEYS) {
    const leg = snap[key];
    const state = reactionLegState(snap, leg, evidence);
    if (state === "measured") measured[key] = leg as StoredReactionLeg;
    else if (state === "pending") pending.push(key);
  }
  return { snapshot: snap, measured, pending };
}
