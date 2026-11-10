import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  explainMissingTradingDayPair,
  formatMissingPairReason,
  resolveTradingDayPair,
} from "@/lib/digest/anomalies";

let db: Database.Database;
let spyId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  spyId = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('SPY', 'SPY Fund', 'ETF', 'equity', 1)"
    )
    .run().lastInsertRowid as number;
});

function seedSpy(date: string, close: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')"
  ).run(spyId, date, close);
}

// 2026-05-07 Thu, 05-08 Fri, 05-09 Sat, 05-11 Mon: no holiday in the run.
describe("explainMissingTradingDayPair", () => {
  it("names the session with no stored close when the two newest days are not consecutive", () => {
    seedSpy("2026-05-11", 101);
    seedSpy("2026-05-07", 100);
    expect(resolveTradingDayPair(db)).toBeNull();
    expect(explainMissingTradingDayPair(db)).toEqual({
      kind: "gap",
      latest: "2026-05-11",
      missing: "2026-05-08",
    });
  });

  it("does not count a weekend-stamped phantom row as a session", () => {
    seedSpy("2026-05-11", 101);
    seedSpy("2026-05-09", 100); // Saturday phantom
    seedSpy("2026-05-07", 100);
    expect(explainMissingTradingDayPair(db)).toEqual({
      kind: "gap",
      latest: "2026-05-11",
      missing: "2026-05-08",
    });
  });

  it("returns null when the pair resolves", () => {
    seedSpy("2026-05-11", 101);
    seedSpy("2026-05-08", 100);
    seedSpy("2026-05-09", 100); // phantom ignored
    expect(resolveTradingDayPair(db)).toEqual({ latest: "2026-05-11", prior: "2026-05-08" });
    expect(explainMissingTradingDayPair(db)).toBeNull();
  });

  it("reports too-few with fewer than two usable days", () => {
    expect(explainMissingTradingDayPair(db)).toEqual({ kind: "too-few" });
    seedSpy("2026-05-09", 100); // phantom only
    seedSpy("2026-05-08", 100);
    expect(resolveTradingDayPair(db)).toBeNull();
    expect(explainMissingTradingDayPair(db)).toEqual({ kind: "too-few" });
  });

  it("agrees with the pair under completedOnly", () => {
    seedSpy("2026-05-11", 101);
    seedSpy("2026-05-08", 100);
    const now = new Date("2026-05-11T15:00:00Z"); // 11:00 ET Monday, session open
    expect(resolveTradingDayPair(db, { completedOnly: true, now })).toBeNull();
    expect(explainMissingTradingDayPair(db, { completedOnly: true, now })).toEqual({
      kind: "too-few",
    });
  });
});

describe("formatMissingPairReason", () => {
  it("prints the dates without timezone drift", () => {
    expect(
      formatMissingPairReason({ kind: "gap", latest: "2026-05-11", missing: "2026-05-08" })
    ).toBe(
      "Could not evaluate significant moves: no SPY close is stored for May 8, 2026 (the session before May 11, 2026), so there is no one-day move to measure."
    );
  });

  it("falls back to the generic sentence", () => {
    const generic =
      "Could not evaluate significant moves because the latest SPY trading-day pair is unavailable.";
    expect(formatMissingPairReason({ kind: "too-few" })).toBe(generic);
    expect(formatMissingPairReason(null)).toBe(generic);
  });
});
