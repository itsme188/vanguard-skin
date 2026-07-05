/**
 * Single shared earnings email sweep — used by BOTH the cron route
 * (/api/cron/earnings-sweep) and the launchd tsx fallback
 * (scripts/sweep-earnings-emails.ts).
 *
 * Carries the Phase-4 Mac↔cloud KV marker dance that previously lived only
 * in the (uncalled) per-event routes /api/cron/earnings-{preview,recap} —
 * without it, the Worker fallback and the Mac sweep double-sent every
 * preview whenever the Mac was awake (audit 2026-07-04, bug B1). Marker
 * helpers no-op gracefully when WORKER_MARKER_URL is unset.
 */

import type Database from "better-sqlite3";
import {
  findEmailCandidates,
  type EmailSweepOpts,
} from "./enrichment-runner";
import {
  sendEarningsPreview,
  sendEarningsRecap,
  EarningsEmailError,
  reapStaleEarningsEmailClaims,
} from "@/lib/digest/send-earnings-email";
import {
  checkEarningsCloudMarker,
  setEarningsRunningMarker,
  clearEarningsRunningMarker,
  writeMacSentEarningsMarker,
} from "@/lib/cron/earnings-marker-check";

export interface SweepCandidateResult {
  eventId: number;
  symbol: string;
  phase: "preview" | "recap";
  ok: boolean;
  skipped?: "cloud-already-sent";
  status?: number;
  message?: string;
  durationMs: number;
}

export interface SweepSummary {
  swept: number;
  sent: number;
  skipped: number;
  failed: number;
  results: SweepCandidateResult[];
}

/**
 * When the Worker fallback already delivered an email, mirror that fact into
 * the local audit table so (a) findEmailCandidates stops re-selecting the
 * event every tick and (b) the EarningsHub chips show it as sent.
 * ai_output_md stays NULL — the viewer knows there's no local copy.
 */
function recordCloudSentAudit(
  db: Database.Database,
  eventId: number,
  phase: "preview" | "recap",
): void {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error)
     VALUES (?, ?, 'cloud-fallback', NULL, 'sent-by-cloud')
     ON CONFLICT(event_id, phase) DO NOTHING`,
  ).run(eventId, phase);
}

export async function runEarningsEmailSweep(
  db: Database.Database,
  opts: EmailSweepOpts = {},
): Promise<SweepSummary> {
  // Reap stale (>30 min) 'in_progress' claim rows BEFORE candidate selection
  // — a stale claim from a dead process otherwise hides its event from
  // findEmailCandidates forever (the claim row satisfies the "already
  // audited" exclusion but no email was ever sent). See B3.
  const reaped = reapStaleEarningsEmailClaims(db);
  if (reaped > 0) {
    console.warn(
      `[earnings-sweep] reaped ${reaped} stale in-progress claim(s) from a dead process`,
    );
  }

  const candidates = findEmailCandidates(db, opts);
  const results: SweepCandidateResult[] = [];

  for (const cand of candidates) {
    const t0 = Date.now();

    const cloudMarker = await checkEarningsCloudMarker(cand.phase, cand.eventId);
    if (cloudMarker?.sentBy === "cloud") {
      recordCloudSentAudit(db, cand.eventId, cand.phase);
      results.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        ok: true,
        skipped: "cloud-already-sent",
        durationMs: Date.now() - t0,
      });
      continue;
    }

    void setEarningsRunningMarker(cand.phase, cand.eventId);
    try {
      if (cand.phase === "preview") {
        await sendEarningsPreview(db, cand.eventId);
      } else {
        await sendEarningsRecap(db, cand.eventId);
      }
      void writeMacSentEarningsMarker(cand.phase, cand.eventId);
      results.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        ok: true,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      const status = err instanceof EarningsEmailError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        ok: false,
        status,
        message,
        durationMs: Date.now() - t0,
      });
    } finally {
      void clearEarningsRunningMarker(cand.phase, cand.eventId);
    }
  }

  return {
    swept: candidates.length,
    sent: results.filter((r) => r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
