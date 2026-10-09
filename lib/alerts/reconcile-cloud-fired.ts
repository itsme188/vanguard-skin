import type Database from "better-sqlite3";
import { lastFiredDateET } from "@/lib/levels/last-fired-date";

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
  /** The security's trading currency (snapshot v12 onward). Not stored: the
   *  alert's price is read with the security's own currency. */
  currency?: string | null;
  /** When the Worker sent the alert (v12 onward). This is the alert's
   *  recorded time and the day it counts on (`alertTimeOf`) — the same field
   *  the Worker's own once-a-day guard reads. `triggeredAt` is the time of the
   *  quote it was judged on; a thinly traded name's last quote can be a day
   *  old. Markers written before v12 carry only `triggeredAt`. */
  firedAt?: string;
  /**
   * Fires on EARLIER Eastern days that this marker replaced before the Mac
   * had reconciled them (the Worker keeps one marker per level, for 7 days,
   * and carries the older records here, oldest first). Each is filed as its
   * own inbox row.
   */
  earlier?: CloudFiredPayload[];
}

/** A record the reconcile can file: it must at least say when and at what price. */
function isFilable(r: unknown): r is CloudFiredPayload {
  if (!r || typeof r !== "object") return false;
  const rec = r as Partial<CloudFiredPayload>;
  return (
    typeof rec.triggeredAt === "string" &&
    !Number.isNaN(Date.parse(rec.triggeredAt)) &&
    typeof rec.triggeredPrice === "number" &&
    Number.isFinite(rec.triggeredPrice)
  );
}

/**
 * The instant an alert went out: the push time when the marker has a readable
 * one, else the quote time (older markers). Worker and Mac must count "the
 * day" of a cloud alert from the same field, or the inbox shows a row on a
 * day with no push (workers/cron/src/level-scan.ts reads it the same way).
 */
function alertTimeOf(rec: CloudFiredPayload): string {
  return typeof rec.firedAt === "string" && !Number.isNaN(Date.parse(rec.firedAt))
    ? rec.firedAt
    : rec.triggeredAt;
}

/** How far either side of the cloud fire the same-day read looks before the
 *  Eastern-day test in JS. An Eastern day is at most 25 hours long. */
const SAME_DAY_LOOKAROUND_MS = 48 * 60 * 60 * 1000;

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
  // "Already alerted that day" is decided on the EASTERN day, the same day
  // the Mac's once-a-day guard uses (hasAlertToday, via lastFiredDateET).
  // `triggered_at` is a UTC instant, so the day is never a SQL date()
  // compare: that is the UTC day, which rolls over at 20:00 Eastern (19:00 in
  // winter). The SQL bound is only a coarse window, datetime() on both sides.
  const selectNearbyAlerts = db.prepare(
    `SELECT triggered_at FROM level_alerts
     WHERE level_id = ?
       AND datetime(triggered_at) >= datetime(?)
       AND datetime(triggered_at) <= datetime(?)`,
  );
  const alertedOnSameEasternDay = (levelId: number, firedAt: string): boolean => {
    const day = lastFiredDateET(firedAt);
    const ms = Date.parse(firedAt);
    if (day === null || Number.isNaN(ms)) return false;
    const rows = selectNearbyAlerts.all(
      levelId,
      new Date(ms - SAME_DAY_LOOKAROUND_MS).toISOString(),
      new Date(ms + SAME_DAY_LOOKAROUND_MS).toISOString(),
    ) as Array<{ triggered_at: string }>;
    return rows.some((r) => lastFiredDateET(r.triggered_at) === day);
  };
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

      // One marker per level; it may carry earlier days' fires. Oldest first,
      // so the newest fire is the one left on the level row. Each record is
      // deduped on its own Eastern day: one inbox row per level per day.
      const records = [
        ...(Array.isArray(payload.earlier) ? payload.earlier.filter(isFilable) : []),
        payload,
      ];
      let newest: CloudFiredPayload | null = null;
      for (const rec of records) {
        const alertAt = alertTimeOf(rec);
        if (alertedOnSameEasternDay(levelId, alertAt)) {
          skippedAlreadyAlerted += 1;
          continue;
        }

        const positionContext = JSON.stringify({
          source: "cloud_scan",
          fired_at: alertAt,
          // The quote the level was judged on, when it differs from the push
          // time (level_alerts has no column for it; this context is its home).
          ...(alertAt !== rec.triggeredAt ? { quote_at: rec.triggeredAt } : {}),
          symbol: rec.symbol ?? payload.symbol,
          level_type: rec.levelType ?? payload.levelType,
          level_price: rec.levelPrice ?? payload.levelPrice,
          source_author: rec.sourceAuthor ?? payload.sourceAuthor,
        });

        insertAlert.run(
          levelId,
          rec.securityId ?? payload.securityId,
          alertAt,
          rec.triggeredPrice,
          positionContext,
        );
        newest = rec;
        reconciled += 1;
      }

      // Flip the level inactive + record trigger details. Matches the
      // Mac-side triggerLevel mutation post-fire state so the LevelsPanel
      // UI shows the same "alerted" treatment regardless of which side fired.
      if (newest && level.is_active === 1) {
        flipLevel.run(alertTimeOf(newest), newest.triggeredPrice, levelId);
      }

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
