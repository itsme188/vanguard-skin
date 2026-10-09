/** D5 — repair-alert-suggestions: dry-run default, clears only stale MA advice. */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertLevel, triggerLevel, setAlertSuggestion } from "@/lib/mutations/security-levels";
import {
  findStaleMaAdvice,
  clearStaleAdvice,
  assertRepairAcknowledged,
  quotedPrices,
} from "../../scripts/repair-alert-suggestions";

let db: Database.Database;
let n = 0;

function seed(opts: {
  source: string;
  threshold: number | null;
  advice: string | null;
  levelPrice?: number;
}): number {
  n++;
  const secId = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, 'Syn', 'stock', 'equity', 1)",
    )
    .run(`ZZ${n}`).lastInsertRowid as number;
  const levelId = upsertLevel(db, {
    security_id: secId,
    level_type: "support",
    price: opts.levelPrice ?? 60,
    price_source: opts.source as never,
  });
  const { alertId } = triggerLevel(db, {
    levelId,
    securityId: secId,
    triggeredPrice: 99,
    thresholdPrice: opts.threshold ?? undefined,
  });
  if (opts.advice) setAlertSuggestion(db, alertId as number, opts.advice);
  return alertId as number;
}

const stored = (id: number) =>
  (db.prepare("SELECT suggested_action FROM level_alerts WHERE id = ?").get(id) as {
    suggested_action: string | null;
  }).suggested_action;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  n = 0;
});

describe("quotedPrices", () => {
  it("reads dollar amounts and decimals, ignores bare counts", () => {
    expect(quotedPrices("Trim 50 shares near $1,234.50 or 98.25.")).toEqual([
      { value: 1234.5, decimals: 2 },
      { value: 98.25, decimals: 2 },
    ]);
  });
});

describe("findStaleMaAdvice", () => {
  it("flags MA advice that quotes the old snapshot and not the threshold", () => {
    const id = seed({ source: "sma_9", threshold: 100, advice: "Hold, support at $60.00 failed." });
    expect(findStaleMaAdvice(db).map((r) => r.alertId)).toEqual([id]);
  });
  it("leaves advice that quotes the current threshold", () => {
    seed({ source: "sma_9", threshold: 100, advice: "Wait for a hold above $100.00." });
    expect(findStaleMaAdvice(db)).toEqual([]);
  });
  it("leaves advice with no price in it, and static levels", () => {
    seed({ source: "sma_9", threshold: 100, advice: "Wait for confirmation." });
    seed({ source: "static", threshold: 100, advice: "Support at $60.00 failed.", levelPrice: 100 });
    expect(findStaleMaAdvice(db)).toEqual([]);
  });
  it("does not flag advice that only quotes the fire price besides the threshold", () => {
    seed({ source: "ema_20", threshold: 100, advice: "Crossed $100.00 at $99.00; wait." });
    expect(findStaleMaAdvice(db)).toEqual([]);
  });
});

describe("clearStaleAdvice", () => {
  it("clears only the flagged rows, makes no model call, and is idempotent", () => {
    const stale = seed({ source: "sma_9", threshold: 100, advice: "Support at $60.00 failed." });
    const fine = seed({ source: "sma_9", threshold: 100, advice: "Hold above $100.00." });
    expect(clearStaleAdvice(db)).toBe(1);
    expect(stored(stale)).toBeNull();
    expect(stored(fine)).toBe("Hold above $100.00.");
    expect(clearStaleAdvice(db)).toBe(0);
  });
});

describe("acknowledgement", () => {
  it("dry run needs no flag; apply without it is refused", () => {
    expect(() => assertRepairAcknowledged(["n", "s"], false)).not.toThrow();
    expect(() => assertRepairAcknowledged(["n", "s", "--apply"], true)).toThrow(/--acknowledge-repair/);
    expect(() =>
      assertRepairAcknowledged(["n", "s", "--apply", "--acknowledge-repair"], true),
    ).not.toThrow();
  });
});
