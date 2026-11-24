import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  formatTriggeredAlertsSection,
  triggeredAlertsHeading,
} from "@/lib/digest/daily-digest";
import { upsertLevel, triggerLevel } from "@/lib/mutations/security-levels";
import { todayET, addDays } from "@/lib/calendar/date-utils";

describe("triggeredAlertsHeading", () => {
  it("a full timestamp is the since-last window", () => {
    expect(triggeredAlertsHeading("2026-11-20T14:30:00.000Z", "2026-11-22")).toBe(
      "## Price Levels Triggered Since Last Digest"
    );
  });
  it("today's Eastern date reads Today", () => {
    expect(triggeredAlertsHeading("2026-11-22", "2026-11-22")).toBe(
      "## Price Levels Triggered Today"
    );
  });
  it("another date names the day, no leading zero, no year", () => {
    expect(triggeredAlertsHeading("2026-10-30", "2026-11-22")).toBe(
      "## Price Levels Triggered Since Oct 30"
    );
    expect(triggeredAlertsHeading("2026-11-05", "2026-11-22")).toBe(
      "## Price Levels Triggered Since Nov 5"
    );
  });
  it("a date in another year still names only month and day", () => {
    expect(triggeredAlertsHeading("2025-12-03", "2026-01-02")).toBe(
      "## Price Levels Triggered Since Dec 3"
    );
  });
});

describe("formatTriggeredAlertsSection heading", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function fireAlert() {
    const sec = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('AAA', 'AAA Corp', 'stock', 'equity', 1)"
      )
      .run().lastInsertRowid as number;
    const levelId = upsertLevel(db, { security_id: sec, level_type: "support", price: 100 });
    triggerLevel(db, { levelId, securityId: sec, triggeredPrice: 95 });
  }

  it("since-last (timestamp) keeps the old heading", () => {
    fireAlert();
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    expect(formatTriggeredAlertsSection(db, since).split("\n")[0]).toBe(
      "## Price Levels Triggered Since Last Digest"
    );
  });
  it("today mode says Today", () => {
    fireAlert();
    expect(formatTriggeredAlertsSection(db, todayET()).split("\n")[0]).toBe(
      "## Price Levels Triggered Today"
    );
  });
  it("an earlier date names it", () => {
    fireAlert();
    const out = formatTriggeredAlertsSection(db, "2020-03-07", todayET());
    expect(out.split("\n")[0]).toBe("## Price Levels Triggered Since Mar 7");
    expect(addDays(todayET(), 0)).toBe(todayET());
  });
  it("no alerts returns an empty string", () => {
    expect(formatTriggeredAlertsSection(db, "2099-01-01")).toBe("");
  });
});
