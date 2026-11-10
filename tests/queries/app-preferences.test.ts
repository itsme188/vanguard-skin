import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAppPreferences, readCaps, constructionCapsKey, COVERAGE_IGNORED_KEY } from "@/lib/queries/app-preferences";

function mk() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

describe("app-preferences readers", () => {
  it("reads the migration-seeded per-scope caps", () => {
    const p = getAppPreferences(mk());
    expect(p.constructionCaps.roth.top3Max).toBe(0.25);
    expect(p.constructionCaps.ibkr.betaMax).toBe(1.5);
  });
  it("falls back per field when a stored row is malformed or partial", () => {
    const db = mk();
    db.prepare("UPDATE settings SET value = ? WHERE key = ?").run('{"top1_max":0.05}', constructionCapsKey("all"));
    expect(readCaps(db, "all")).toEqual({ top1Max: 0.05, top3Max: 0.25, sectorMax: 0.35, betaMin: 0.7, betaMax: 1.2 });
    db.prepare("UPDATE settings SET value = 'garbage' WHERE key = ?").run(constructionCapsKey("all"));
    expect(readCaps(db, "all").top1Max).toBe(0.1);
  });
  it("tolerates malformed ignored-symbols JSON", () => {
    const db = mk();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, 'not json')").run(COVERAGE_IGNORED_KEY);
    expect(getAppPreferences(db).coverageGuardIgnoredSymbols).toEqual([]);
  });
});
