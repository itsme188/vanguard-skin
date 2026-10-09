/**
 * Readers that compared an option's stored expiration by hand.
 *
 * The stored expiration has two spellings: dashed `YYYY-MM-DD` and the legacy
 * compact `YYYYMMDD` (stored rows are not normalised). As text the compact
 * form sorts after every dashed day of its year, SQLite's `date()` and
 * `julianday()` read it as NULL, and `new Date("20260619T00:00:00Z")` is
 * invalid. Each reader below went wrong on a compact row in its own way:
 *
 *   - getExpiringOptions: the day count was NULL, so a LIVE compact contract
 *     never appeared in the expirations list.
 *   - isExpiredAsOf / yearsToExpiry: on expiration day a compact contract was
 *     never "expired" after the close, and its time to expiry was NaN.
 *   - scripts/purge-expired-options-once.ts: the preview listed no compact
 *     row, and with only compact rows it exited before the purge ran.
 *
 * Synthetic symbols and invented prices only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getExpiringOptions } from "@/lib/compute/options-expirations";
import { isExpiredAsOf, yearsToExpiry } from "@/lib/compute/options-greeks";
import {
  liveOptionExpirationSql,
  optionExpirationDashedSql,
  optionExpirationDaySql,
} from "@/lib/compute/option-expiry";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TODAY = "2026-06-10";
// 09:30 and 16:30 Eastern on 2026-06-10 (EDT, UTC-4).
const BEFORE_CLOSE = new Date("2026-06-10T13:30:00Z");
const AFTER_CLOSE = new Date("2026-06-10T20:30:00Z");

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedOption(id: number, symbol: string, expiration: string, qty = 1): void {
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
     VALUES (?, ?, 'Option', 'CALL', 50, ?, 'ZZA', 100)`,
  ).run(id, symbol, expiration);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
     VALUES (1, ?, '2026-06-01', ?, ?)`,
  ).run(id, qty, `k-${id}`);
}

describe("getExpiringOptions reads both spellings", () => {
  it("lists a live compact contract with its day count and the dashed date; drops an expired one", () => {
    seedOption(100, "ZZA DASHED LIVE", "2026-06-19");
    seedOption(101, "ZZA COMPACT LIVE", "20260626");
    seedOption(102, "ZZA COMPACT EXPIRED", "20260605");
    seedOption(103, "ZZA DASHED EXPIRED", "2026-06-05");
    seedOption(104, "ZZA COMPACT TODAY", "20260610");
    seedOption(105, "ZZA COMPACT FAR", "20270115");

    const rows = getExpiringOptions(db, { today: TODAY, daysWindow: 90 });
    expect(rows.map((r) => [r.symbol, r.expiration, r.daysToExpiry])).toEqual([
      ["ZZA COMPACT TODAY", "2026-06-10", 0],
      ["ZZA DASHED LIVE", "2026-06-19", 9],
      ["ZZA COMPACT LIVE", "2026-06-26", 16],
    ]);
  });
});

describe("isExpiredAsOf / yearsToExpiry read both spellings", () => {
  it("a compact contract on its expiration day is live before the close and expired after it", () => {
    expect(isExpiredAsOf("20260610", TODAY, BEFORE_CLOSE)).toBe(false);
    expect(isExpiredAsOf("20260610", TODAY, AFTER_CLOSE)).toBe(true);
    // Same answers as the dashed spelling.
    expect(isExpiredAsOf("2026-06-10", TODAY, BEFORE_CLOSE)).toBe(false);
    expect(isExpiredAsOf("2026-06-10", TODAY, AFTER_CLOSE)).toBe(true);
  });

  it("a compact contract before or after its expiration day", () => {
    expect(isExpiredAsOf("20260605", TODAY, BEFORE_CLOSE)).toBe(true);
    expect(isExpiredAsOf("20260619", TODAY, AFTER_CLOSE)).toBe(false);
  });

  it("time to expiry of a compact contract equals the dashed one, never NaN", () => {
    expect(yearsToExpiry("20260619", TODAY, BEFORE_CLOSE)).toBe(yearsToExpiry("2026-06-19", TODAY, BEFORE_CLOSE));
    expect(yearsToExpiry("20260619", TODAY, BEFORE_CLOSE)).toBeCloseTo(9 / 365, 10);
    expect(yearsToExpiry("20260610", TODAY, BEFORE_CLOSE)).toBe(yearsToExpiry("2026-06-10", TODAY, BEFORE_CLOSE));
    expect(Number.isFinite(yearsToExpiry("20260610", TODAY, BEFORE_CLOSE))).toBe(true);
  });
});

describe("the shared SQL fragments", () => {
  it("optionExpirationDaySql rebuilds the compact form; date() alone reads it as NULL", () => {
    const day = (v: string) =>
      db.prepare(`SELECT ${optionExpirationDaySql("expiration_date")} AS d FROM (SELECT ? AS expiration_date)`).pluck().get(v);
    expect(day("20260605")).toBe("2026-06-05");
    expect(day("2026-06-05")).toBe("2026-06-05");
    expect(day("not a date")).toBeNull();
    expect(db.prepare(`SELECT date('20260605')`).pluck().get()).toBeNull();
  });

  it("the default column is the bare name, and an alias-qualified column is accepted", () => {
    expect(optionExpirationDaySql()).toBe(
      "date(CASE WHEN expiration_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' THEN substr(expiration_date,1,4) || '-' || substr(expiration_date,5,2) || '-' || substr(expiration_date,7,2) ELSE expiration_date END)",
    );
    expect(optionExpirationDashedSql("s.expiration_date")).toBe(
      "CASE WHEN s.expiration_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' THEN substr(s.expiration_date,1,4) || '-' || substr(s.expiration_date,5,2) || '-' || substr(s.expiration_date,7,2) ELSE s.expiration_date END",
    );
    expect(() => optionExpirationDashedSql("s.expiration_date; DROP TABLE x")).toThrow();
  });

  it("liveOptionExpirationSql is unchanged by the shared fragment", () => {
    expect(liveOptionExpirationSql("s", TODAY)).toBe(
      "(s.expiration_date IS NULL OR (CASE WHEN s.expiration_date GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' THEN substr(s.expiration_date,1,4) || '-' || substr(s.expiration_date,5,2) || '-' || substr(s.expiration_date,7,2) ELSE s.expiration_date END) >= '2026-06-10')",
    );
  });
});

describe("scripts/purge-expired-options-once.ts previews what the purge deletes", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "scripts/purge-expired-options-once.ts"), "utf8");

  it("the preview query uses the shared normalising fragment, never a bare date()", () => {
    expect(source).toContain('optionExpirationDaySql("s.expiration_date")');
    expect(source).not.toMatch(/date\(\s*s\.expiration_date\s*\)/);
  });

  it("the preview predicate selects an expired compact row", () => {
    seedOption(200, "ZZA COMPACT EXPIRED", "20260605");
    seedOption(201, "ZZA DASHED EXPIRED", "2026-06-05");
    seedOption(202, "ZZA COMPACT LIVE", "20260626");
    seedOption(203, "ZZA COMPACT GRACE", "20260609"); // yesterday: inside the one-day grace
    const select = (dayExpr: string) =>
      (
        db
          .prepare(
            `SELECT s.symbol FROM holdings h JOIN securities s ON s.id = h.security_id
              WHERE LOWER(s.security_type) = 'option' AND s.expiration_date IS NOT NULL
                AND ${dayExpr} < date(?, '-1 day') ORDER BY s.id`,
          )
          .all(TODAY) as Array<{ symbol: string }>
      ).map((r) => r.symbol);
    // The old expression: the compact row is invisible.
    expect(select("date(s.expiration_date)")).toEqual(["ZZA DASHED EXPIRED"]);
    expect(select(optionExpirationDaySql("s.expiration_date"))).toEqual([
      "ZZA COMPACT EXPIRED",
      "ZZA DASHED EXPIRED",
    ]);
  });
});
