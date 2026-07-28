import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getSectorDisagreements } from "@/lib/queries/data-health";

describe("getSectorDisagreements", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    const ins = db.prepare(
      "INSERT INTO securities (symbol, security_type, sector, fund_category, industry, source_key) VALUES (?, 'Stock', ?, ?, ?, ?)"
    );
    ins.run("VRTX", "Consumer Staples", "US Sector Equity (Health Care)", "Biotechnology", "t:vrtx"); // unverified disagreement → flags
    ins.run("GOOG", "Communication Services", "US Sector Equity (Technology)", "Internet", "t:goog"); // will be verified below → suppressed
    ins.run("NVDA", "Technology", "US Sector Equity (Semiconductors)", "Semiconductors", "t:nvda");   // X not a GICS sector → never flags
    ins.run("KO", "Consumer Staples", "US Sector Equity (Consumer Staples)", "Beverages", "t:ko");    // agrees → no flag
    ins.run("TSM", "Technology", "International Equity", "Semiconductors", "t:tsm");                  // shape mismatch → no flag
    db.prepare("UPDATE securities SET sector_verified_at = datetime('now'), sector_source='gics_verified' WHERE symbol='GOOG'").run();
  });

  it("flags only unverified sector-shape disagreements", () => {
    const rows = getSectorDisagreements(db);
    expect(rows.map((r) => r.symbol)).toEqual(["VRTX"]);
    expect(rows[0].impliedSector).toBe("Healthcare");
  });

  it("a null sector with a sector-shaped fund_category flags too", () => {
    db.prepare("UPDATE securities SET sector = NULL WHERE symbol='KO'").run();
    expect(getSectorDisagreements(db).map((r) => r.symbol)).toEqual(
      expect.arrayContaining(["KO", "VRTX"])
    );
  });
});
