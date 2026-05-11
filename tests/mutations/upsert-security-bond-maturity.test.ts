import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";

describe("upsertSecurity bond maturity_date extraction", () => {
  function fresh() {
    const db = new Database(":memory:");
    runMigrations(db);
    return db;
  }

  it("auto-populates maturity_date from name when bond is inserted without one", () => {
    const db = fresh();
    upsertSecurity(db, {
      symbol: "912828YZ7",
      securityType: "bond",
      name: "TREAS 4.5% DUE 11/15/29",
    });
    const row = db
      .prepare("SELECT maturity_date FROM securities WHERE symbol=?")
      .get("912828YZ7") as { maturity_date: string };
    expect(row.maturity_date).toBe("2029-11-15");
  });

  it("does not overwrite an explicit maturityDate passed to upsertSecurity", () => {
    const db = fresh();
    upsertSecurity(db, {
      symbol: "912828YZ7",
      securityType: "bond",
      name: "TREAS 4.5% DUE 11/15/29",
      maturityDate: "2029-12-31",
    });
    const row = db
      .prepare("SELECT maturity_date FROM securities WHERE symbol=?")
      .get("912828YZ7") as { maturity_date: string };
    expect(row.maturity_date).toBe("2029-12-31");
  });

  it("does not attempt extraction for non-bond securities", () => {
    const db = fresh();
    upsertSecurity(db, {
      symbol: "VTI",
      securityType: "etf",
      name: "VANG MTD 2027-08-15 Total Market",
    });
    const row = db
      .prepare("SELECT maturity_date FROM securities WHERE symbol=?")
      .get("VTI") as { maturity_date: string | null };
    // Should NOT extract a maturity date for an ETF even if the name contains "MTD YYYY-MM-DD"
    expect(row.maturity_date).toBeNull();
  });

  it("handles MTD ISO format in bond name", () => {
    const db = fresh();
    upsertSecurity(db, {
      symbol: "US912797XX5",
      securityType: "bond",
      name: "U S TREASURY BILL CPN 0.00000  MTD 2027-03-15 DTD 2026-09-15",
    });
    const row = db
      .prepare("SELECT maturity_date FROM securities WHERE symbol=?")
      .get("US912797XX5") as { maturity_date: string };
    expect(row.maturity_date).toBe("2027-03-15");
  });
});
