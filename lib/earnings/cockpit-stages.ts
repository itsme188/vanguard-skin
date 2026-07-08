/**
 * Pure stage state machine for the earnings-day cockpit. No DB access —
 * callers pass event fields + pre-fetched email/skip/mute state. The cockpit
 * is READ-ONLY over the pipeline: this derives display state, never advances it.
 */
import { composeReleaseInstant } from "@/lib/calendar/reaction-snapshot";
import { isPlausibleEarnings } from "@/lib/earnings/plausibility";
import { parseFinnhubFigure } from "@/lib/format/finnhub-figure";
import { REACTION_READY_MS } from "@/lib/calendar/enrichment-runner";

/** Mirrors email-sweep's module-local BLOCKED_RECAP_MIN_AGE_MS (2h). */
export const COCKPIT_BLOCKED_MIN_AGE_MS = 2 * 60 * 60 * 1000;

export type EmailSendState = "sent" | "sent-by-cloud" | "in-flight" | null;
export type PreviewStage = "sent" | "sent-by-cloud" | "in-flight" | "skipped" | "pending" | "missed";
export interface ReleasedStage {
  state: "upcoming" | "released" | "unknown";
  releaseInstant: string | null;
}
export type ActualStageState = "pending" | "captured" | "implausible" | "blocked";
export interface ReactionStage {
  state: "pending" | "captured";
  source: string | null;
  readyAt: string | null;
}
export type RecapStage = "sent" | "sent-by-cloud" | "in-flight" | "skipped" | "waiting" | "blocked";

export interface EventStages {
  preview: PreviewStage;
  released: ReleasedStage;
  actual: ActualStageState;
  reaction: ReactionStage;
  recap: RecapStage;
}

export interface StageEventInputs {
  event_date: string;
  release_time: string | null;
  actual_value: string | null;
  consensus_estimate: string | null;
  consensus_value: string | null;
  reaction_snapshot: string | null;
}

export function deriveEventStages(
  ev: StageEventInputs,
  emails: { preview: EmailSendState; recap: EmailSendState },
  skips: { preview: boolean; recap: boolean },
  muted: boolean,
  now: Date,
  todayEt: string
): EventStages {
  const instant = ev.release_time
    ? composeReleaseInstant(ev.event_date, ev.release_time)
    : null;
  const isPastDay = ev.event_date < todayEt;

  // ── released ──
  let released: ReleasedStage;
  if (instant) {
    released = {
      state: now.getTime() >= instant.getTime() ? "released" : "upcoming",
      releaseInstant: instant.toISOString(),
    };
  } else if (isPastDay) {
    // Carryover row without a known time: the day is over, it has released.
    released = { state: "released", releaseInstant: null };
  } else {
    released = { state: "unknown", releaseInstant: null };
  }
  const hasReleased = released.state === "released";

  // ── preview ──
  let preview: PreviewStage;
  if (emails.preview) preview = emails.preview;
  else if (skips.preview || muted) preview = "skipped";
  else if (hasReleased) preview = "missed";
  else preview = "pending";

  // ── actual ──
  let actual: ActualStageState;
  if (ev.actual_value) {
    const cons = parseFinnhubFigure(ev.consensus_value ?? ev.consensus_estimate);
    const act = parseFinnhubFigure(ev.actual_value);
    actual = isPlausibleEarnings(cons.eps, act.eps, cons.revenue, act.revenue)
      ? "captured"
      : "implausible";
  } else if (
    hasReleased &&
    (instant
      ? now.getTime() - instant.getTime() >= COCKPIT_BLOCKED_MIN_AGE_MS
      : isPastDay)
  ) {
    // Blocked: ≥2h past a known release instant; for carryover rows with no known time,
    // the elapsed day itself is the evidence.
    actual = "blocked";
  } else {
    actual = "pending";
  }

  // ── reaction ──
  let reaction: ReactionStage;
  if (ev.reaction_snapshot) {
    let source: string | null = null;
    try {
      const parsed = JSON.parse(ev.reaction_snapshot) as { source?: string };
      source = typeof parsed.source === "string" ? parsed.source : null;
      reaction = { state: "captured", source, readyAt: null };
    } catch {
      reaction = {
        state: "pending",
        source: null,
        readyAt: instant
          ? new Date(instant.getTime() + REACTION_READY_MS).toISOString()
          : null,
      };
    }
  } else {
    reaction = {
      state: "pending",
      source: null,
      readyAt: instant
        ? new Date(instant.getTime() + REACTION_READY_MS).toISOString()
        : null,
    };
  }

  // ── recap ──
  let recap: RecapStage;
  if (emails.recap) recap = emails.recap;
  else if (skips.recap || muted) recap = "skipped";
  else if (actual === "blocked") recap = "blocked";
  else recap = "waiting";

  return { preview, released, actual, reaction, recap };
}
