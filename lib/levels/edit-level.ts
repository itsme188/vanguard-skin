/**
 * Edit one existing level in place (PATCH /api/levels, action "edit").
 *
 * Only the fields the add form takes can change. Everything else on the row
 * (security, provenance, review status, active flag, last-fired record) is
 * read back from the stored row and written unchanged, so an edit can never
 * approve a pending level, re-activate a paused one or re-attribute a
 * newsletter level — the plain PATCH body would do all three, because
 * upsertLevel defaults a missing `review_status` to auto_approved.
 *
 * Arming. An edit that changes what the scanner tests (type, price or
 * reference), or that brings a level back into the scanner's universe (a
 * later expiry on an expired level), puts a NEW condition in front of the
 * scanner. That is the same event as approving or reactivating, so it asks
 * the same guard (evaluateArmGuard, lib/alerts/arm-guard.ts) and stamps
 * `armed_crossed_at` by the same rule. A refusal rolls the write back.
 * An edit that touches only the thesis, author, timeframe, direction or
 * action of a level leaves the guard and the stamp alone.
 */
import type Database from "better-sqlite3";
import type {
  LevelActionHint,
  LevelDirection,
  LevelPriceSource,
  LevelTimeframe,
  LevelType,
  SecurityLevel,
} from "@/lib/types";
import {
  getLevelById,
  hasAlertToday,
  isLevelInArmedUniverse,
} from "@/lib/queries/security-levels";
import { upsertLevel } from "@/lib/mutations/security-levels";
import {
  ARMED_CROSSED_AT_SET_SQL,
  evaluateArmGuard,
  type ArmGuardRefusal,
} from "@/lib/alerts/arm-guard";
import { todayET } from "@/lib/calendar/date-utils";

const LEVEL_TYPES: readonly LevelType[] = [
  "support",
  "resistance",
  "entry",
  "exit",
  "stop",
  "scale_in",
];
const PRICE_SOURCES: readonly LevelPriceSource[] = [
  "static",
  "sma_9",
  "sma_21",
  "sma_50",
  "sma_200",
  "ema_9",
  "ema_21",
];
const DIRECTIONS: readonly LevelDirection[] = ["bullish", "bearish"];
const ACTION_HINTS: readonly LevelActionHint[] = [
  "new_position",
  "scale_in",
  "trim",
  "close",
  "watch",
];
const TIMEFRAMES: readonly LevelTimeframe[] = ["day", "week", "month"];

/** The fields an edit may change — the ones the add form takes. */
export interface EditableLevelFields {
  level_type: LevelType;
  price: number;
  price_source: LevelPriceSource;
  direction: LevelDirection | null;
  action_hint: LevelActionHint | null;
  source_author: string | null;
  thesis: string | null;
  timeframe: LevelTimeframe | null;
  expires_at: string | null;
}

export type EditLevelResult =
  | {
      ok: true;
      /** True when the scanner watches the level after the edit. */
      armed: boolean;
      /** True when the edit put a new condition in front of the scanner, so
       *  the arm guard was asked. False for a wording-only edit. */
      guardRan: boolean;
      /** The level already alerted in the scanner's current dedupe day. */
      alertedToday: boolean;
    }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "invalid"; message: string }
  | ({ ok: false; alertedToday: boolean } & ArmGuardRefusal);

function has(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/** Blank text is stored as NULL, as the add form sends it. */
function textOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Merge a request body onto the stored row. A key that is absent keeps the
 * stored value; a key that is present must be valid. Returns the merged
 * fields or the reason the body was refused. Pure.
 */
export function mergeLevelEdit(
  current: SecurityLevel,
  body: Record<string, unknown>,
  today: string,
): { ok: true; fields: EditableLevelFields } | { ok: false; message: string } {
  const fields: EditableLevelFields = {
    level_type: current.level_type,
    price: current.price,
    price_source: current.price_source,
    direction: current.direction,
    action_hint: current.action_hint,
    source_author: current.source_author,
    thesis: current.thesis,
    timeframe: current.timeframe,
    expires_at: current.expires_at,
  };

  if (has(body, "level_type")) {
    if (!oneOf(LEVEL_TYPES, body.level_type)) return { ok: false, message: "Unknown level type." };
    fields.level_type = body.level_type;
  }
  if (has(body, "price_source")) {
    if (!oneOf(PRICE_SOURCES, body.price_source)) return { ok: false, message: "Unknown price reference." };
    fields.price_source = body.price_source;
  }
  if (has(body, "price")) {
    if (typeof body.price !== "number") return { ok: false, message: "Price must be a number." };
    fields.price = body.price;
  }
  // Same rule as a create: a level marks a point on the price axis. Zero is
  // allowed only on a moving-average level, where `price` is a reference echo.
  if (
    !Number.isFinite(fields.price) ||
    fields.price < 0 ||
    (fields.price_source === "static" && fields.price <= 0)
  ) {
    return {
      ok: false,
      message: `Price ${fields.price} is not a valid level price — a level marks a point on the price axis, so it must be a positive amount.`,
    };
  }
  if (has(body, "direction")) {
    if (body.direction !== null && !oneOf(DIRECTIONS, body.direction)) {
      return { ok: false, message: "Unknown direction." };
    }
    fields.direction = body.direction;
  }
  if (has(body, "action_hint")) {
    if (body.action_hint !== null && !oneOf(ACTION_HINTS, body.action_hint)) {
      return { ok: false, message: "Unknown action." };
    }
    fields.action_hint = body.action_hint;
  }
  if (has(body, "timeframe")) {
    if (body.timeframe !== null && !oneOf(TIMEFRAMES, body.timeframe)) {
      return { ok: false, message: "Unknown timeframe." };
    }
    fields.timeframe = body.timeframe;
  }
  if (has(body, "source_author")) {
    const v = textOrNull(body.source_author);
    if (v === undefined) return { ok: false, message: "Source must be text." };
    fields.source_author = v;
  }
  if (has(body, "thesis")) {
    const v = textOrNull(body.thesis);
    if (v === undefined) return { ok: false, message: "Thesis must be text." };
    fields.thesis = v;
  }
  if (has(body, "expires_at")) {
    const v = textOrNull(body.expires_at);
    if (v === undefined || (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v))) {
      return { ok: false, message: "Expiry must be a date (YYYY-MM-DD) or empty." };
    }
    // An expiry that is kept as it was may be in the past (an old level being
    // re-worded). A NEW past expiry is refused, as on create.
    if (v !== null && v !== current.expires_at && v < today) {
      return {
        ok: false,
        message: `Expiry date ${v} is in the past — the scanner would ignore this level from now on. Pick today or a later date, or clear the expiry.`,
      };
    }
    fields.expires_at = v;
  }
  return { ok: true, fields };
}

/** Thrown inside editLevel's transaction to undo the trial write. */
class EditRefused extends Error {
  constructor(readonly refusal: ArmGuardRefusal) {
    super(refusal.code);
  }
}

export function editLevel(
  db: Database.Database,
  id: number,
  body: Record<string, unknown>,
  opts: { force?: boolean; today?: string } = {},
): EditLevelResult {
  const current = getLevelById(db, id);
  if (!current) return { ok: false, code: "not_found" };

  const merged = mergeLevelEdit(current, body, opts.today ?? todayET());
  if (!merged.ok) return { ok: false, code: "invalid", message: merged.message };
  const fields = merged.fields;

  const alertedToday = hasAlertToday(db, id);
  const conditionChanged =
    fields.level_type !== current.level_type ||
    fields.price !== current.price ||
    fields.price_source !== current.price_source;

  const tx = db.transaction((): { armed: boolean; guardRan: boolean } => {
    const wasArmed = isLevelInArmedUniverse(db, id);
    upsertLevel(db, {
      id,
      // Not editable — written back exactly as stored.
      security_id: current.security_id,
      source: current.source,
      source_article_id: current.source_article_id,
      group_id: current.group_id,
      notes: current.notes,
      review_status: current.review_status,
      ...fields,
    });
    const armed = isLevelInArmedUniverse(db, id);
    if (!armed || (wasArmed && !conditionChanged)) return { armed, guardRan: false };

    const verdict = evaluateArmGuard(db, { ...current, ...fields }, { force: opts.force });
    if (verdict.refusal) throw new EditRefused(verdict.refusal);
    db.prepare(`UPDATE security_levels SET ${ARMED_CROSSED_AT_SET_SQL} WHERE id = ?`).run(
      verdict.stampCrossed ? 1 : 0,
      id,
    );
    return { armed, guardRan: true };
  });

  try {
    return { ok: true, ...tx(), alertedToday };
  } catch (err) {
    if (err instanceof EditRefused) return { ok: false, alertedToday, ...err.refusal };
    throw err;
  }
}
