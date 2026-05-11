import type Database from "better-sqlite3";

/**
 * Reconcile cloud-fired price level alerts.
 *
 * Tier 4a: when the Mac is asleep, the Worker scans levels against Yahoo
 * prices and fires Pushover directly. It also writes a `cloud-fired-level-{id}`
 * KV marker. On every Mac wake, this routine pulls those markers, inserts
 * `level_alerts` rows so the inbox catches up, and deletes the markers.
 *
 * Pushover already fired in the cloud — reconcile is purely audit/UI. The
 * triggerLevel mutation would re-fire Pushover, so we INSERT into level_alerts
 * directly instead, and flip is_active=0 + triggered_at/price on the
 * security_levels row to match the Mac-side semantics.
 */

interface CloudFiredPayload {
  levelId: number;
  securityId: number;
  symbol: string;
  levelType: string;
  levelPrice: number;
  triggeredPrice: number;
  triggeredAt: string;
  sourceAuthor: string | null;
}

export interface CloudFiredReconcileResult {
  ok: boolean;
  reconciled: number;
  skipped_already_alerted: number;
  skipped_level_missing: number;
  errors?: { levelId: string; error: string }[];
  error?: string;
  note?: string;
  status?: number;
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

export async function reconcileCloudFiredLevels(
  db: Database.Database,
  secret: string,
): Promise<CloudFiredReconcileResult> {
  const base = workerBase();
  if (!base) {
    return {
      ok: true,
      reconciled: 0,
      skipped_already_alerted: 0,
      skipped_level_missing: 0,
      note: "WORKER_MARKER_URL unset — no-op",
    };
  }

  let payloads: Record<string, CloudFiredPayload> = {};
  try {
    const res = await fetch(`${base}/internal/cloud-fired-levels`, {
      headers: { "X-Cron-Secret": secret },
    });
    if (!res.ok) {
      return {
        ok: false,
        reconciled: 0,
        skipped_already_alerted: 0,
        skipped_level_missing: 0,
        error: `worker returned ${res.status}`,
        status: 502,
      };
    }
    const body = (await res.json()) as { payloads?: Record<string, CloudFiredPayload> };
    payloads = body.payloads ?? {};
  } catch (err) {
    return {
      ok: false,
      reconciled: 0,
      skipped_already_alerted: 0,
      skipped_level_missing: 0,
      error: err instanceof Error ? err.message : String(err),
      status: 502,
    };
  }

  const entries = Object.entries(payloads);
  if (entries.length === 0) {
    return { ok: true, reconciled: 0, skipped_already_alerted: 0, skipped_level_missing: 0 };
  }

  const selectLevel = db.prepare(
    `SELECT id, is_active, triggered_at FROM security_levels WHERE id = ?`,
  );
  const selectExistingAlert = db.prepare(
    `SELECT id FROM level_alerts
     WHERE level_id = ? AND date(triggered_at) = date(?)`,
  );
  const insertAlert = db.prepare(
    `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price, position_context)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const flipLevel = db.prepare(
    `UPDATE security_levels
     SET is_active = 0, triggered_at = ?, triggered_price = ?
     WHERE id = ?`,
  );

  let reconciled = 0;
  let skippedAlreadyAlerted = 0;
  let skippedLevelMissing = 0;
  const errors: { levelId: string; error: string }[] = [];

  for (const [levelIdStr, payload] of entries) {
    const levelId = Number(levelIdStr);
    if (!Number.isInteger(levelId)) continue;

    try {
      const level = selectLevel.get(levelId) as { id: number; is_active: number; triggered_at: string | null } | undefined;
      if (!level) {
        // Level was deleted between scan and reconcile — just clear KV marker.
        await deleteFromWorker(base, secret, levelId);
        skippedLevelMissing += 1;
        continue;
      }

      const existing = selectExistingAlert.get(levelId, payload.triggeredAt) as
        | { id: number }
        | undefined;
      if (existing) {
        await deleteFromWorker(base, secret, levelId);
        skippedAlreadyAlerted += 1;
        continue;
      }

      const positionContext = JSON.stringify({
        source: "cloud_scan",
        fired_at: payload.triggeredAt,
        symbol: payload.symbol,
        level_type: payload.levelType,
        level_price: payload.levelPrice,
        source_author: payload.sourceAuthor,
      });

      insertAlert.run(
        levelId,
        payload.securityId,
        payload.triggeredAt,
        payload.triggeredPrice,
        positionContext,
      );

      // Flip the level inactive + record trigger details. Matches the
      // Mac-side triggerLevel mutation post-fire state so the LevelsPanel
      // UI shows the same "alerted" treatment regardless of which side fired.
      if (level.is_active === 1) {
        flipLevel.run(payload.triggeredAt, payload.triggeredPrice, levelId);
      }

      reconciled += 1;
      await deleteFromWorker(base, secret, levelId);
    } catch (err) {
      errors.push({
        levelId: levelIdStr,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: true,
    reconciled,
    skipped_already_alerted: skippedAlreadyAlerted,
    skipped_level_missing: skippedLevelMissing,
    errors,
  };
}

async function deleteFromWorker(base: string, secret: string, levelId: number): Promise<void> {
  try {
    await fetch(`${base}/internal/cloud-fired-levels?levelId=${levelId}`, {
      method: "DELETE",
      headers: { "X-Cron-Secret": secret },
    });
  } catch {
    // If KV delete fails, payload re-reconciles on next wake — idempotent.
  }
}

/**
 * Post the "mac-recent-scan" marker to the Worker. Called fire-and-forget
 * after every successful auto-refresh pipeline completes detectAndFireAlerts.
 * Worker pre-checks this marker before firing a cloud scan — prevents
 * duplicate Pushover when Mac is alive.
 */
export async function postMacRecentScanMarker(secret: string): Promise<void> {
  const base = workerBase();
  if (!base) return;
  try {
    await fetch(`${base}/internal/mac-recent-scan`, {
      method: "POST",
      headers: { "X-Cron-Secret": secret },
    });
  } catch {
    // Fire-and-forget — never block the auto-refresh pipeline on Worker RTT.
  }
}
