import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getSectorDisagreements, getSectorCheckMissingSector } from "@/lib/queries/data-health";

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
    holdAll();
  });

  // The check covers held or watched stocks only (2026-10-07, QA finding
  // data-health-sector-disagreements--all-rows-unheld-and-untagged-regression-3),
  // so every fixture row is put in the book; the cases below are about the
  // tag comparison, not the portfolio scope.
  function holdAll() {
    db.prepare(
      `INSERT OR IGNORE INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
       SELECT 1, id, '2026-04-30', 10, 't:hold:' || id FROM securities`,
    ).run();
  }

  it("flags only unverified sector-shape disagreements", () => {
    const rows = getSectorDisagreements(db);
    expect(rows.map((r) => r.symbol)).toEqual(["VRTX"]);
    expect(rows[0].impliedSector).toBe("Healthcare");
  });

  it("a null sector is MISSING, not a disagreement — it leaves this list and lands in the missing-sector list", () => {
    // Changed 2026-10-07 (QA finding
    // data-health-sector-disagreements--null-sectors-listed-as-disagreements):
    // this case used to expect KO in the disagreements list. A stock with no
    // sector tag has nothing to disagree with, and the panel's remedy does
    // not apply to it.
    db.prepare("UPDATE securities SET sector = NULL WHERE symbol='KO'").run();
    expect(getSectorDisagreements(db).map((r) => r.symbol)).toEqual(["VRTX"]);
    expect(getSectorCheckMissingSector(db).map((r) => r.symbol)).toEqual(["KO"]);
  });

  it("a REIT with sector 'Financials' and fund_category '(Real Estate)' flags", () => {
    // Already-covered pattern (sanity check that the panel-local alias map
    // didn't break the plain normalizeSector path).
    db.prepare(
      "INSERT INTO securities (symbol, security_type, sector, fund_category, industry, source_key) VALUES ('KRC', 'Stock', 'Financials', 'US Sector Equity (Real Estate)', 'REITS', 't:krc')"
    ).run();
    holdAll();
    const rows = getSectorDisagreements(db);
    const krc = rows.find((r) => r.symbol === "KRC");
    expect(krc).toBeDefined();
    expect(krc!.impliedSector).toBe("Real Estate");
  });

  it("fund_category '(Financial)' — the demoted Bloomberg bucket — still flags via the panel-local alias map", () => {
    // normalizeSector demotes "Financial" to null for SECURITY sector tags
    // (ambiguous), but a fund_category label "(Financial)" is a theme name
    // and unambiguously implies Financials — this row must still surface.
    db.prepare(
      "INSERT INTO securities (symbol, security_type, sector, fund_category, industry, source_key) VALUES ('LAND', 'Stock', 'Real Estate', 'US Sector Equity (Financial)', 'REITS', 't:land')"
    ).run();
    holdAll();
    const rows = getSectorDisagreements(db);
    const land = rows.find((r) => r.symbol === "LAND");
    expect(land).toBeDefined();
    expect(land!.impliedSector).toBe("Financials");
  });
});
