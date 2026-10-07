/**
 * QA finding alerts-review--move-needed-chip-blind-to-trigger-direction-approve-409:
 * a Review row printed "N% move needed" for a level whose condition already
 * held, and Approve then refused it as "already past this level".
 *
 * The row is a client component, so it reads the pure moveNeededView. These
 * tests pin that helper AND prove it agrees with the two server functions the
 * Approve button runs through: checkLevelTriggerState (the scanner's own
 * helper) and evaluateArmGuard (the refusal). If the direction rule ever
 * changes in one place only, the parity blocks fail.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  DOWNWARD_TRIGGER_LEVEL_TYPES,
  isLevelConditionMet,
  moveNeededView,
} from "@/lib/levels/scan-range";
import { checkLevelTriggerState } from "@/lib/queries/security-levels";
import { evaluateArmGuard } from "@/lib/alerts/arm-guard";
import { upsertLevel } from "@/lib/mutations/security-levels";
import { getLevelById } from "@/lib/queries/security-levels";
import type { LevelType } from "@/lib/types";

const ALL_TYPES: LevelType[] = [
  "support",
  "resistance",
  "entry",
  "exit",
  "stop",
  "scale_in",
];

describe("moveNeededView", () => {
  it("an entry level above spot is already met, whatever the percentage says", () => {
    // Entry at 500 with the price at 400: the entry condition (price at or
    // below 500) already holds. The old chip said "25.0% move needed".
    const view = moveNeededView("entry", 400, 500, "stock");
    expect(view).not.toBeNull();
    expect(view!.pct).toBeCloseTo(25, 6);
    expect(view!.alreadyMet).toBe(true);
  });

  it("an entry level below spot still needs a move down", () => {
    const view = moveNeededView("entry", 400, 360, "stock");
    expect(view!.pct).toBeCloseTo(-10, 6);
    expect(view!.alreadyMet).toBe(false);
  });

  it("a resistance or exit level below spot is already met", () => {
    expect(moveNeededView("resistance", 150, 100, "stock")!.alreadyMet).toBe(true);
    expect(moveNeededView("exit", 90, 80, "stock")!.alreadyMet).toBe(true);
  });

  it("a resistance level above spot still needs a move up", () => {
    const view = moveNeededView("resistance", 100, 110, "stock");
    expect(view!.pct).toBeCloseTo(10, 6);
    expect(view!.alreadyMet).toBe(false);
  });

  it("price exactly on the level counts as met in both directions", () => {
    expect(moveNeededView("support", 100, 100, "stock")!.alreadyMet).toBe(true);
    expect(moveNeededView("resistance", 100, 100, "stock")!.alreadyMet).toBe(true);
  });

  it("a level outside the scan range is never 'already met' (the guard refuses it for range instead)", () => {
    // Support at 700 with the price at 75 is past the level by direction, but
    // it is far outside the band, so the scanner never evaluates it.
    expect(moveNeededView("support", 75, 700, "stock")!.alreadyMet).toBe(false);
    // Options are exempt from the band, so direction decides.
    expect(moveNeededView("support", 75, 700, "option")!.alreadyMet).toBe(true);
  });

  it("returns null when a price is missing or spot is 0", () => {
    expect(moveNeededView("entry", null, 100, "stock")).toBeNull();
    expect(moveNeededView("entry", 100, null, "stock")).toBeNull();
    expect(moveNeededView("entry", 0, 100, "stock")).toBeNull();
  });

  it("the downward list is exactly the four types that fire at or below the level", () => {
    expect([...DOWNWARD_TRIGGER_LEVEL_TYPES].sort()).toEqual(
      ["entry", "scale_in", "stop", "support"],
    );
  });
});

describe("moveNeededView agrees with the server's trigger check and arm guard", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedSecurity(symbol: string): number {
    return db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
      )
      .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  }

  // Level at 100; spot below, on, above, and far outside the band each way.
  const SPOTS = [40, 80, 100, 120, 160];

  it("isLevelConditionMet and alreadyMet match checkLevelTriggerState for every type and side", () => {
    const secId = seedSecurity("AAA");
    for (const levelType of ALL_TYPES) {
      for (const spot of SPOTS) {
        const state = checkLevelTriggerState(
          db,
          {
            id: 1,
            security_id: secId,
            level_type: levelType,
            price: 100,
            price_source: "static",
            sec_type: "stock",
          },
          spot,
        );
        const label = `${levelType} @100, spot ${spot}`;
        if (!state.beyondScanRange) {
          expect(isLevelConditionMet(levelType, 100, spot), label).toBe(state.hit);
        }
        expect(moveNeededView(levelType, spot, 100, "stock")!.alreadyMet, label).toBe(
          state.hit,
        );
      }
    }
  });

  it("alreadyMet is true exactly when the arm guard would refuse with would_fire_immediately", () => {
    for (const levelType of ALL_TYPES) {
      for (const spot of SPOTS) {
        const secId = seedSecurity(`Z${levelType}${spot}`.toUpperCase());
        db.prepare(
          "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, date('now'), ?, 'manual')",
        ).run(secId, spot);
        const levelId = upsertLevel(db, {
          security_id: secId,
          level_type: levelType,
          price: 100,
          source: "newsletter",
          review_status: "pending_review",
        });
        const level = getLevelById(db, levelId)!;
        const verdict = evaluateArmGuard(db, level);
        const view = moveNeededView(levelType, spot, 100, "stock")!;
        expect(view.alreadyMet, `${levelType} @100, spot ${spot}`).toBe(
          verdict.refusal?.code === "would_fire_immediately",
        );
      }
    }
  });
});
