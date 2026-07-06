import type Database from "better-sqlite3";
import { sendEarningsPrintPush } from "@/lib/alerts/print-push";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import {
  getEarningsSettings,
  shouldSendEarningsEmail,
} from "@/lib/queries/earnings-settings";

interface CloudEnrichedPayload {
  eventId: number;
  source_key: string;
  actual: string | null;
  consensus: string | null;
  source: string;
  deferred?: boolean;
  reason?: string;
  reaction: unknown;
  /** Absent on pre-Wave-1 Worker payloads — treated as fresh (see isStalePayload). */
  fetchedAt?: string;
}

export interface CloudReconcileResult {
  ok: boolean;
  reconciled: number;
  skipped_tws_wins: number;
  skipped_deferred: number;
  errors?: { eventId: string; error: string }[];
  error?: string;
  note?: string;
  status?: number;
}

// A days-old print is briefing material, not a push — if the Worker's
// cloud-enriched payload sat in KV long enough that the Mac only reconciles
// it well after the print, firing Pushover now would be a stale, confusing
// notification. Missing/unparseable fetchedAt is treated as fresh (never
// block the push over a formatting surprise).
const STALE_PAYLOAD_MS = 24 * 3600 * 1000;

function isStalePayload(fetchedAt: string | undefined, now: number = Date.now()): boolean {
  if (!fetchedAt) return false;
  const parsed = Date.parse(fetchedAt);
  if (Number.isNaN(parsed)) return false;
  return now - parsed > STALE_PAYLOAD_MS;
}

function workerBase(): string | null {
  const raw = process.env.WORKER_MARKER_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return null;
  }
}

export async function reconcileCloudEnrichment(
  db: Database.Database,
  secret: string,
): Promise<CloudReconcileResult> {
  const base = workerBase();
  if (!base) {
    return {
      ok: true,
      reconciled: 0,
      skipped_tws_wins: 0,
      skipped_deferred: 0,
      note: "WORKER_MARKER_URL unset — no-op",
    };
  }

  let payloads: Record<string, CloudEnrichedPayload> = {};
  try {
    const res = await fetch(`${base}/internal/cloud-enriched`, {
      headers: { "X-Cron-Secret": secret },
    });
    if (!res.ok) {
      return {
        ok: false,
        reconciled: 0,
        skipped_tws_wins: 0,
        skipped_deferred: 0,
        error: `worker returned ${res.status}`,
        status: 502,
      };
    }
    const body = (await res.json()) as { payloads?: Record<string, CloudEnrichedPayload> };
    payloads = body.payloads ?? {};
  } catch (err) {
    return {
      ok: false,
      reconciled: 0,
      skipped_tws_wins: 0,
      skipped_deferred: 0,
      error: err instanceof Error ? err.message : String(err),
      status: 502,
    };
  }

  const entries = Object.entries(payloads);
  if (entries.length === 0) {
    return { ok: true, reconciled: 0, skipped_tws_wins: 0, skipped_deferred: 0 };
  }

  let reconciled = 0;
  let skippedTwsWins = 0;
  let skippedDeferred = 0;
  const errors: { eventId: string; error: string }[] = [];

  const selectRow = db.prepare(
    `SELECT id, reaction_snapshot, consensus_value, consensus_estimate, enriched_at, actual_value, event_type, symbol
     FROM calendar_events
     WHERE id = ?`,
  );
  const updateWithReaction = db.prepare(
    `UPDATE calendar_events
     SET actual_value = COALESCE(?, actual_value),
         consensus_value = COALESCE(consensus_value, ?),
         reaction_snapshot = COALESCE(?, reaction_snapshot),
         enriched_at = COALESCE(enriched_at, datetime('now'))
     WHERE id = ?`,
  );
  const updateActualOnly = db.prepare(
    `UPDATE calendar_events
     SET actual_value = COALESCE(?, actual_value),
         consensus_value = COALESCE(consensus_value, ?),
         enriched_at = COALESCE(enriched_at, datetime('now'))
     WHERE id = ?`,
  );
  // TWS-wins branch, but the row still lacks an actual (Task 6 semantics):
  // update consensus only, leave enriched_at NULL so the Mac's enrichment
  // retry loop keeps trying to fetch the actual. Stamping here on a null
  // actual would prematurely kill that retry loop.
  const updateActualOnlyNoStamp = db.prepare(
    `UPDATE calendar_events
     SET actual_value = COALESCE(?, actual_value),
         consensus_value = COALESCE(consensus_value, ?)
     WHERE id = ?`,
  );
  // Reaction arrived but neither the payload nor the row has an actual yet:
  // store the reaction, leave enriched_at NULL so the Mac's enrichment
  // retry loop can still fetch the actual (Task 6 semantics).
  const updateReactionNoStamp = db.prepare(
    `UPDATE calendar_events
     SET reaction_snapshot = COALESCE(?, reaction_snapshot),
         consensus_value = COALESCE(consensus_value, ?)
     WHERE id = ?`,
  );

  for (const [idStr, payload] of entries) {
    const eventId = Number(idStr);
    if (!Number.isInteger(eventId)) continue;

    try {
      if (payload.deferred) {
        // "deferred" = the Worker explicitly punted this event to the Mac
        // (e.g. nonfred Claude fetches). Nothing to apply — drain the key.
        await deleteFromWorker(base, secret, eventId);
        skippedDeferred += 1;
        continue;
      }
      if (payload.actual == null && payload.consensus == null && payload.reaction == null) {
        // Empty payload — nothing to add. Drain so it doesn't re-reconcile forever.
        await deleteFromWorker(base, secret, eventId);
        skippedDeferred += 1;
        continue;
      }

      const existing = selectRow.get(eventId) as
        | {
            id: number;
            reaction_snapshot: string | null;
            consensus_value: string | null;
            consensus_estimate: string | null;
            enriched_at: string | null;
            actual_value: string | null;
            event_type: string;
            symbol: string | null;
          }
        | undefined;

      if (!existing) {
        await deleteFromWorker(base, secret, eventId);
        continue;
      }

      let existingIsTws = false;
      if (existing.reaction_snapshot) {
        try {
          const parsed = JSON.parse(existing.reaction_snapshot) as { source?: string };
          existingIsTws = parsed.source === "tws";
        } catch {
          existingIsTws = false;
        }
      }

      const rowHasOrGetsActual = payload.actual != null || existing.actual_value != null;

      if (existingIsTws) {
        if (rowHasOrGetsActual) {
          updateActualOnly.run(payload.actual, payload.consensus, eventId);
        } else {
          updateActualOnlyNoStamp.run(payload.actual, payload.consensus, eventId);
        }
        skippedTwsWins += 1;
      } else if (rowHasOrGetsActual) {
        updateWithReaction.run(
          payload.actual,
          payload.consensus,
          payload.reaction ? JSON.stringify(payload.reaction) : null,
          eventId,
        );
      } else {
        updateReactionNoStamp.run(
          payload.reaction ? JSON.stringify(payload.reaction) : null,
          payload.consensus,
          eventId,
        );
      }
      reconciled += 1;

      // Push-at-print for cloud-captured actuals (Wave 1 §2). The marker
      // check inside sendEarningsPrintPush dedups against a push the Worker
      // already fired at capture time. Best-effort. Skip when the payload is
      // stale — a days-old print belongs in the briefing, not a push.
      if (
        payload.actual != null &&
        existing.actual_value == null &&
        existing.event_type === "earnings" &&
        existing.symbol &&
        !isStalePayload(payload.fetchedAt)
      ) {
        try {
          const sym = existing.symbol.toUpperCase();
          const status = getSymbolStatus(db, [sym])[sym];
          const settings = getEarningsSettings(db);
          if (
            (status === "held" || status === "watchlist") &&
            shouldSendEarningsEmail(settings, sym)
          ) {
            await sendEarningsPrintPush({
              eventId,
              symbol: sym,
              actualValue: payload.actual,
              // renderHeadlineTable precedence: consensus_value (set at
              // release-time enrichment) wins over consensus_estimate (the
              // older Finnhub-sync-time snapshot) — see CLAUDE.md.
              consensusValue:
                payload.consensus ?? existing.consensus_value ?? existing.consensus_estimate,
              reactionJson: payload.reaction
                ? JSON.stringify(payload.reaction)
                : existing.reaction_snapshot,
            });
          }
        } catch (err) {
          console.warn(`[print-push] reconcile event ${eventId} failed:`, err);
        }
      }

      await deleteFromWorker(base, secret, eventId);
    } catch (err) {
      errors.push({
        eventId: idStr,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    reconciled,
    skipped_tws_wins: skippedTwsWins,
    skipped_deferred: skippedDeferred,
    errors,
  };
}

async function deleteFromWorker(base: string, secret: string, eventId: number): Promise<void> {
  try {
    await fetch(`${base}/internal/cloud-enriched?eventId=${eventId}`, {
      method: "DELETE",
      headers: { "X-Cron-Secret": secret },
    });
  } catch {
    // If KV delete fails, the payload will reconcile again on the next wake.
  }
}
