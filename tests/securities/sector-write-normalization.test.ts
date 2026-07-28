// tests/securities/sector-write-normalization.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { normalizeSector } from "@/lib/securities/normalize-sector";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT, sector TEXT, industry TEXT);`);
  return db;
}
describe("sector write normalization contract", () => {
  it("stores GICS, preserves raw only when industry empty", () => {
    const db = makeDb();
    db.prepare("INSERT INTO securities (symbol, sector, industry) VALUES ('META', NULL, NULL)").run();
    // NOTE: "Communications" (the Bloomberg bucket) was demoted 2026-07-28 —
    // it's no longer a safe 1:1 GICS alias, so this mechanics test uses the
    // canonical GICS label directly instead of routing through that alias.
    db.prepare(`UPDATE securities SET sector = COALESCE(?, sector), industry = COALESCE(NULLIF(industry,''), ?) WHERE symbol='META'`)
      .run(normalizeSector("Communication Services"), "Communication Services");
    const row = db.prepare("SELECT sector, industry FROM securities WHERE symbol='META'").get() as { sector: string; industry: string };
    expect(row.sector).toBe("Communication Services");
    expect(row.industry).toBe("Communication Services");
  });
  it("does not clobber an existing industry value", () => {
    const db = makeDb();
    db.prepare("INSERT INTO securities (symbol, sector, industry) VALUES ('NVDA', NULL, 'Semiconductors')").run();
    db.prepare(`UPDATE securities SET sector = COALESCE(?, sector), industry = COALESCE(NULLIF(industry,''), ?) WHERE symbol='NVDA'`)
      .run(normalizeSector("Technology"), "Technology");
    const row = db.prepare("SELECT sector, industry FROM securities WHERE symbol='NVDA'").get() as { sector: string; industry: string };
    expect(row.sector).toBe("Technology");
    expect(row.industry).toBe("Semiconductors");
  });
});
