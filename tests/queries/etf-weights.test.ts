import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { getEtfSectorWeights } from "@/lib/queries/etf-weights";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE etf_sector_weights (etf_symbol TEXT, sector TEXT, weight_pct REAL, as_of_date TEXT, source TEXT, PRIMARY KEY(etf_symbol,sector));`);
  db.prepare("INSERT INTO etf_sector_weights VALUES ('VTI','Technology',30,'2026-06-08','manual')").run();
  db.prepare("INSERT INTO etf_sector_weights VALUES ('VTI','Financials',70,'2026-06-08','manual')").run();
  return db;
}
describe("getEtfSectorWeights", () => {
  it("groups weights by ETF symbol", () => {
    const m = getEtfSectorWeights(makeDb());
    expect(m.get("VTI")).toHaveLength(2);
    expect(m.get("VTI")!.find((w) => w.sector === "Technology")?.weight_pct).toBe(30);
  });
});
