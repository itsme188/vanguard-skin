/**
 * scripts/repair-option-attached-levels.ts — re-points standing SHARE-priced
 * levels that are attached to an OCC option row onto the underlying equity,
 * and leaves genuine PREMIUM levels alone.
 *
 * All tickers and prices below are synthetic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  applyOptionLevelRepairs,
  collectOptionAttachedLevels,
  planOptionLevelRepairs,
} from "@/scripts/repair-option-attached-levels";

const TODAY = "2026-09-08";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedEquity(symbol: string, price: number | null): number {
  const id = db
    .prepare(
      "INSERT INTO securities (symbol, security_type, asset_class, multiplier) VALUES (?, 'Stock', 'equity', 1)",
    )
    .run(symbol).lastInsertRowid as number;
  if (price != null) {
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-09-04', ?, 'manual')",
    ).run(id, price);
  }
  return id;
}

function seedOption(symbol: string, underlying: string, premium: number | null): number {
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, security_type, asset_class, underlying_symbol, multiplier)
       VALUES (?, 'Option', 'equity', ?, 100)`,
    )
    .run(symbol, underlying).lastInsertRowid as number;
  if (premium != null) {
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-09-04', ?, 'manual')",
    ).run(id, premium);
  }
  return id;
}

function seedLevel(
  securityId: number,
  opts: {
    level_type?: string;
    direction?: string | null;
    price: number;
    review_status?: string;
    is_active?: number;
    notes?: string | null;
  },
): number {
  return db
    .prepare(
      `INSERT INTO security_levels
         (security_id, level_type, price, direction, source, review_status, is_active, notes)
       VALUES (?, ?, ?, ?, 'newsletter', ?, ?, ?)`,
    )
    .run(
      securityId,
      opts.level_type ?? "exit",
      opts.price,
      opts.direction ?? "bearish",
      opts.review_status ?? "auto_approved",
      opts.is_active ?? 1,
      opts.notes ?? null,
    ).lastInsertRowid as number;
}

function levelRow(id: number) {
  return db
    .prepare(
      `SELECT security_id, level_type, direction, price, review_status, is_active, notes
         FROM security_levels WHERE id = ?`,
    )
    .get(id) as {
    security_id: number;
    level_type: string;
    direction: string | null;
    price: number;
    review_status: string;
    is_active: number;
    notes: string | null;
  };
}

/** The live shape that produced this repair: a share-price exit sitting on a
 *  deep-ITM long-dated call whose premium is nowhere near it. */
function seedShareLevelOnOption(): { levelId: number; optId: number; eqId: number } {
  const eqId = seedEquity("ZZZ", 338.86);
  const optId = seedOption("ZZZ   270115C00220000", "ZZZ", 126.86);
  const levelId = seedLevel(optId, { price: 388 });
  return { levelId, optId, eqId };
}

// ─── collect ────────────────────────────────────────────────────────

describe("collectOptionAttachedLevels", () => {
  it("returns only levels whose security is an option, with the premium", () => {
    const { levelId, optId } = seedShareLevelOnOption();
    seedLevel(seedEquity("AAA", 10), { price: 9 }); // equity level — not collected

    const rows = collectOptionAttachedLevels(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].level_id).toBe(levelId);
    expect(rows[0].option_security_id).toBe(optId);
    expect(rows[0].option_price).toBe(126.86);
  });

  it("returns nothing when no level is attached to an option", () => {
    seedLevel(seedEquity("AAA", 10), { price: 9 });
    expect(collectOptionAttachedLevels(db)).toEqual([]);
  });
});

// ─── plan (dry run) ─────────────────────────────────────────────────

describe("planOptionLevelRepairs", () => {
  it("classifies the share-priced level as move and writes nothing", () => {
    const { levelId, optId, eqId } = seedShareLevelOnOption();

    const plan = planOptionLevelRepairs(db, { today: TODAY });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      levelId,
      verdict: "move",
      targetSecurityId: eqId,
      targetSymbol: "ZZZ",
    });
    expect(plan[0].nextNotes).toBe(
      "re-pointed from ZZZ   270115C00220000 by repair-option-attached-levels on 2026-09-08",
    );

    // Dry run: the DB is untouched.
    expect(levelRow(levelId).security_id).toBe(optId);
    expect(levelRow(levelId).notes).toBeNull();
  });

  it("leaves a genuine premium level alone", () => {
    seedEquity("VVV", null); // no equity price — cannot read it as a share level
    const optId = seedOption("VVV   260918C00300000", "VVV", 8.58);
    const levelId = seedLevel(optId, { level_type: "entry", direction: "bullish", price: 8.25 });

    const plan = planOptionLevelRepairs(db, { today: TODAY });
    expect(plan[0].verdict).toBe("leave");
    expect(plan[0].nextNotes).toBeNull();
    expect(levelRow(levelId).security_id).toBe(optId);
  });

  it("flags an ambiguous deep-ITM LEAP for review", () => {
    seedEquity("III", 95.89);
    const optId = seedOption("III   270115C00045000", "III", 47.85);
    seedLevel(optId, { price: 80 });

    const plan = planOptionLevelRepairs(db, { today: TODAY });
    expect(plan[0].verdict).toBe("review");
    expect(plan[0].reason).toContain("in band against both");
  });

  it("reviews (never moves) a contract whose underlying has no security row", () => {
    const optId = seedOption("QQZ   270115C00220000", "QQZ", 12.5);
    const levelId = seedLevel(optId, { price: 388 });

    const plan = planOptionLevelRepairs(db, { today: TODAY });
    expect(plan[0].verdict).toBe("review");
    expect(plan[0].targetSecurityId).toBeNull();
    expect(levelRow(levelId).security_id).toBe(optId);
  });

  it("reports duplicate when the equity already carries the identical level", () => {
    const eqId = seedEquity("ZZZ", 338.86);
    const optId = seedOption("ZZZ   270115C00220000", "ZZZ", 126.86);
    seedLevel(eqId, { price: 388 }); // same type + direction + price
    seedLevel(optId, { price: 388 });

    const plan = planOptionLevelRepairs(db, { today: TODAY });
    expect(plan).toHaveLength(1);
    expect(plan[0].verdict).toBe("duplicate");
    expect(plan[0].reason).toContain("already carries an identical level");
  });

  it("does not call a different level_type or direction a duplicate", () => {
    const eqId = seedEquity("ZZZ", 338.86);
    const optId = seedOption("ZZZ   270115C00220000", "ZZZ", 126.86);
    seedLevel(eqId, { level_type: "entry", price: 388 });
    seedLevel(eqId, { direction: "bullish", price: 388 });
    seedLevel(optId, { price: 388 });

    expect(planOptionLevelRepairs(db, { today: TODAY })[0].verdict).toBe("move");
  });

  it("marks the SECOND identical mover in one run as a duplicate", () => {
    seedEquity("ZZZ", 338.86);
    const optA = seedOption("ZZZ   270115C00220000", "ZZZ", 126.86);
    const optB = seedOption("ZZZ   280121C00250000", "ZZZ", 130.0);
    seedLevel(optA, { price: 388 });
    seedLevel(optB, { price: 388 });

    const plan = planOptionLevelRepairs(db, { today: TODAY });
    expect(plan.map((r) => r.verdict)).toEqual(["move", "duplicate"]);
  });

  it("parses the OCC symbol when the row has no underlying_symbol column value", () => {
    const eqId = seedEquity("ZZZ", 338.86);
    const optId = db
      .prepare(
        `INSERT INTO securities (symbol, security_type, asset_class, multiplier)
         VALUES ('ZZZ   270115C00220000', 'Option', 'equity', 100)`,
      )
      .run().lastInsertRowid as number;
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-09-04', 126.86, 'manual')",
    ).run(optId);
    seedLevel(optId, { price: 388 });

    const plan = planOptionLevelRepairs(db, { today: TODAY });
    expect(plan[0].verdict).toBe("move");
    expect(plan[0].targetSecurityId).toBe(eqId);
  });

  it("folds a dual-class contract onto its issuer sibling", () => {
    const googId = seedEquity("GOOG", 338.86);
    const optId = seedOption("GOOGL 270115C00220000", "GOOGL", 126.86);
    seedLevel(optId, { price: 388 });

    const plan = planOptionLevelRepairs(db, { today: TODAY });
    expect(plan[0].verdict).toBe("move");
    expect(plan[0].targetSecurityId).toBe(googId);
    expect(plan[0].targetSymbol).toBe("GOOG");
  });
});

// ─── apply ──────────────────────────────────────────────────────────

describe("applyOptionLevelRepairs", () => {
  it("re-points the level and appends provenance, touching nothing else", () => {
    const { levelId, eqId } = seedShareLevelOnOption();
    const before = levelRow(levelId);

    const { moved } = applyOptionLevelRepairs(db, { today: TODAY });
    expect(moved).toBe(1);

    const after = levelRow(levelId);
    expect(after.security_id).toBe(eqId);
    expect(after.notes).toBe(
      "re-pointed from ZZZ   270115C00220000 by repair-option-attached-levels on 2026-09-08",
    );
    expect(after.review_status).toBe(before.review_status);
    expect(after.is_active).toBe(before.is_active);
    expect(after.price).toBe(before.price);
    expect(after.level_type).toBe(before.level_type);
    expect(after.direction).toBe(before.direction);
  });

  it("preserves an existing notes value", () => {
    const eqId = seedEquity("ZZZ", 338.86);
    const optId = seedOption("ZZZ   270115C00220000", "ZZZ", 126.86);
    const levelId = seedLevel(optId, { price: 388, notes: "author reiterated" });

    applyOptionLevelRepairs(db, { today: TODAY });
    const after = levelRow(levelId);
    expect(after.security_id).toBe(eqId);
    expect(after.notes).toBe(
      "author reiterated\nre-pointed from ZZZ   270115C00220000 by repair-option-attached-levels on 2026-09-08",
    );
  });

  it("does not touch a rejected level's review_status while re-pointing it", () => {
    const eqId = seedEquity("ZZZ", 338.86);
    const optId = seedOption("ZZZ   270115C00220000", "ZZZ", 126.86);
    const levelId = seedLevel(optId, { price: 388, review_status: "rejected" });

    applyOptionLevelRepairs(db, { today: TODAY });
    expect(levelRow(levelId).security_id).toBe(eqId);
    expect(levelRow(levelId).review_status).toBe("rejected");
  });

  it("is idempotent — a second run finds nothing to do", () => {
    seedShareLevelOnOption();
    expect(applyOptionLevelRepairs(db, { today: TODAY }).moved).toBe(1);

    const second = applyOptionLevelRepairs(db, { today: "2026-09-09" });
    expect(second.moved).toBe(0);
    expect(second.plan).toEqual([]);
    expect(collectOptionAttachedLevels(db)).toEqual([]);
  });

  it("writes nothing for leave / review / duplicate rows", () => {
    // leave
    seedEquity("VVV", null);
    const vvvOpt = seedOption("VVV   260918C00300000", "VVV", 8.58);
    const leaveId = seedLevel(vvvOpt, { level_type: "entry", direction: "bullish", price: 8.25 });
    // review (ambiguous)
    seedEquity("III", 95.89);
    const iiiOpt = seedOption("III   270115C00045000", "III", 47.85);
    const reviewId = seedLevel(iiiOpt, { price: 80 });
    // duplicate
    const zzzEq = seedEquity("ZZZ", 338.86);
    const zzzOpt = seedOption("ZZZ   270115C00220000", "ZZZ", 126.86);
    seedLevel(zzzEq, { price: 388 });
    const dupId = seedLevel(zzzOpt, { price: 388 });

    const { moved } = applyOptionLevelRepairs(db, { today: TODAY });
    expect(moved).toBe(0);
    expect(levelRow(leaveId).security_id).toBe(vvvOpt);
    expect(levelRow(reviewId).security_id).toBe(iiiOpt);
    expect(levelRow(dupId).security_id).toBe(zzzOpt);
    expect(levelRow(dupId).notes).toBeNull();
  });

  it("moves only the movers when the set is mixed", () => {
    const { levelId: moverId, eqId } = seedShareLevelOnOption();
    seedEquity("VVV", null);
    const vvvOpt = seedOption("VVV   260918C00300000", "VVV", 8.58);
    const leaveId = seedLevel(vvvOpt, { level_type: "entry", direction: "bullish", price: 8.25 });

    const { moved, plan } = applyOptionLevelRepairs(db, { today: TODAY });
    expect(moved).toBe(1);
    expect(plan.map((r) => r.verdict).sort()).toEqual(["leave", "move"]);
    expect(levelRow(moverId).security_id).toBe(eqId);
    expect(levelRow(leaveId).security_id).toBe(vvvOpt);
  });
});
