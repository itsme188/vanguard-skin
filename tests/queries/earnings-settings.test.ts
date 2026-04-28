import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getEarningsSettings,
  setEarningsEmailsEnabled,
  setMutedEarningsSymbols,
  shouldSendEarningsEmail,
} from "@/lib/queries/earnings-settings";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("earnings-settings", () => {
  it("defaults to enabled=true with empty muted list", () => {
    const s = getEarningsSettings(db);
    expect(s.enabled).toBe(true);
    expect(s.mutedSymbols).toEqual([]);
  });

  it("persists enabled toggle through reads", () => {
    setEarningsEmailsEnabled(db, false);
    expect(getEarningsSettings(db).enabled).toBe(false);
    setEarningsEmailsEnabled(db, true);
    expect(getEarningsSettings(db).enabled).toBe(true);
  });

  it("upper-cases + dedups muted symbols on write", () => {
    setMutedEarningsSymbols(db, ["glw", "TER", "glw", "  KO  ", ""]);
    expect(getEarningsSettings(db).mutedSymbols).toEqual(["GLW", "TER", "KO"]);
  });

  it("reads muted list back as uppercase array", () => {
    setMutedEarningsSymbols(db, ["aapl", "msft"]);
    expect(getEarningsSettings(db).mutedSymbols).toEqual(["AAPL", "MSFT"]);
  });

  it("supports clearing the muted list (empty array)", () => {
    setMutedEarningsSymbols(db, ["GLW"]);
    expect(getEarningsSettings(db).mutedSymbols).toEqual(["GLW"]);
    setMutedEarningsSymbols(db, []);
    expect(getEarningsSettings(db).mutedSymbols).toEqual([]);
  });

  describe("shouldSendEarningsEmail", () => {
    it("returns false when feature is disabled (regardless of mute list)", () => {
      const settings = { enabled: false, mutedSymbols: [] };
      expect(shouldSendEarningsEmail(settings, "GLW")).toBe(false);
    });

    it("returns false when symbol is muted", () => {
      const settings = { enabled: true, mutedSymbols: ["GLW", "TER"] };
      expect(shouldSendEarningsEmail(settings, "GLW")).toBe(false);
      expect(shouldSendEarningsEmail(settings, "TER")).toBe(false);
    });

    it("returns true when feature is enabled and symbol is not muted", () => {
      const settings = { enabled: true, mutedSymbols: ["GLW"] };
      expect(shouldSendEarningsEmail(settings, "TER")).toBe(true);
    });

    it("is case-insensitive on the input symbol", () => {
      const settings = { enabled: true, mutedSymbols: ["GLW"] };
      expect(shouldSendEarningsEmail(settings, "glw")).toBe(false);
      expect(shouldSendEarningsEmail(settings, "Glw")).toBe(false);
    });
  });
});
