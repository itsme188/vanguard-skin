import type Database from "better-sqlite3";
import type {
  LevelType,
  LevelDirection,
  LevelActionHint,
  LevelSource,
  LevelTimeframe,
  LevelPriceSource,
  LevelReviewStatus,
  AlertResponse,
} from "@/lib/types";
import { hasAlertToday } from "@/lib/queries/security-levels";

// ─── Level mutations ───────────────────────────────────────────────

export interface UpsertLevelInput {
  id?: number;
  security_id: number;
  level_type: LevelType;
  price: number;
  price_source?: LevelPriceSource;
  direction?: LevelDirection | null;
  action_hint?: LevelActionHint | null;
  source?: LevelSource;
  source_article_id?: number | null;
  source_author?: string | null;
  thesis?: string | null;
  timeframe?: LevelTimeframe | null;
  expires_at?: string | null;
  group_id?: string | null;
  notes?: string | null;
  review_status?: LevelReviewStatus;
}

export function upsertLevel(
  db: Database.Database,
  input: UpsertLevelInput
): number {
  const common = {
    security_id: input.security_id,
    level_type: input.level_type,
    price: input.price,
    price_source: input.price_source ?? "static",
    direction: input.direction ?? null,
    action_hint: input.action_hint ?? null,
    source: input.source ?? "user",
    source_article_id: input.source_article_id ?? null,
    source_author: input.source_author ?? null,
    thesis: input.thesis ?? null,
    timeframe: input.timeframe ?? null,
    expires_at: input.expires_at ?? null,
    group_id: input.group_id ?? null,
    notes: input.notes ?? null,
    review_status: input.review_status ?? "auto_approved",
  };

  if (input.id) {
    db.prepare(
      `UPDATE security_levels
       SET security_id = @security_id, level_type = @level_type, price = @price,
           price_source = @price_source,
           direction = @direction, action_hint = @action_hint, source = @source,
           source_article_id = @source_article_id, source_author = @source_author,
           thesis = @thesis, timeframe = @timeframe, expires_at = @expires_at,
           group_id = @group_id, notes = @notes, review_status = @review_status,
           updated_at = datetime('now')
       WHERE id = @id`
    ).run({ ...common, id: input.id });
    return input.id;
  }

  const result = db
    .prepare(
      `INSERT INTO security_levels
        (security_id, level_type, price, price_source, direction, action_hint, source,
         source_article_id, source_author, thesis, timeframe, expires_at,
         group_id, notes, review_status)
       VALUES
        (@security_id, @level_type, @price, @price_source, @direction, @action_hint, @source,
         @source_article_id, @source_author, @thesis, @timeframe, @expires_at,
         @group_id, @notes, @review_status)`
    )
    .run(common);
  return result.lastInsertRowid as number;
}

/**
 * Flip review_status for a pending newsletter-extracted level.
 * Approved → armed; rejected → kept in DB (for audit) but excluded from scans.
 */
export function setLevelReviewStatus(
  db: Database.Database,
  id: number,
  status: LevelReviewStatus
): void {
  db.prepare(
    `UPDATE security_levels
     SET review_status = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(status, id);
}

export function deactivateLevel(db: Database.Database, id: number): void {
  db.prepare(
    `UPDATE security_levels
     SET is_active = 0, updated_at = datetime('now')
     WHERE id = ?`
  ).run(id);
}

export function reactivateLevel(db: Database.Database, id: number): void {
  db.prepare(
    `UPDATE security_levels
     SET is_active = 1, triggered_at = NULL, triggered_price = NULL,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(id);
}

export function deleteLevel(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM security_levels WHERE id = ?").run(id);
}

/**
 * Mark a level as triggered and insert a corresponding alert.
 * Flips is_active=0 so the level won't re-fire until user re-activates (one alert per level).
 * Also checks hasAlertToday as a secondary guard in case is_active wasn't flipped for some reason.
 *
 * Return shape: when `deduped` is true, `reason` explains why so callers/UI can
 * show an informative state instead of silently no-op'ing.
 */
export type TriggerLevelResult =
  | { alertId: number; deduped: false; reason?: never }
  | { alertId: null; deduped: true; reason: "already_alerted_today" };

export function triggerLevel(
  db: Database.Database,
  opts: {
    levelId: number;
    securityId: number;
    triggeredPrice: number;
    triggeredAt?: string; // ISO timestamp; defaults to now
    positionContext?: string | null;
    suggestedAction?: string | null;
  }
): TriggerLevelResult {
  if (hasAlertToday(db, opts.levelId)) {
    return { alertId: null, deduped: true, reason: "already_alerted_today" };
  }

  const triggeredAt = opts.triggeredAt ?? new Date().toISOString();

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE security_levels
       SET triggered_at = ?, triggered_price = ?, is_active = 0,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(triggeredAt, opts.triggeredPrice, opts.levelId);

    const result = db
      .prepare(
        `INSERT INTO level_alerts
          (level_id, security_id, triggered_at, triggered_price,
           suggested_action, position_context)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        opts.levelId,
        opts.securityId,
        triggeredAt,
        opts.triggeredPrice,
        opts.suggestedAction ?? null,
        opts.positionContext ?? null
      );
    return result.lastInsertRowid as number;
  });

  const alertId = tx();
  return { alertId, deduped: false };
}

// ─── Alert mutations ───────────────────────────────────────────────

export function respondToAlert(
  db: Database.Database,
  id: number,
  response: AlertResponse,
  note?: string
): void {
  db.prepare(
    `UPDATE level_alerts
     SET user_response = ?, user_response_at = datetime('now'),
         user_response_note = ?
     WHERE id = ?`
  ).run(response, note ?? null, id);
}

export function setAlertSuggestion(
  db: Database.Database,
  id: number,
  suggestedAction: string
): void {
  db.prepare(
    "UPDATE level_alerts SET suggested_action = ? WHERE id = ?"
  ).run(suggestedAction, id);
}
