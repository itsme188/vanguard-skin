import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

describe("migration 061 — foreign currency", () => {
  it("adds securities.currency defaulting to USD and creates fx_rates", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const cols = db.prepare("SELECT name FROM pragma_table_info('securities')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("currency");

    // existing-style insert without currency → defaults to USD
    db.prepare(
      "INSERT INTO securities (symbol, security_type, source_key) VALUES ('AAPL','Stock','k1')",
    ).run();
    const row = db.prepare("SELECT currency FROM securities WHERE symbol='AAPL'").get() as { currency: string };
    expect(row.currency).toBe("USD");

    const fxCols = db.prepare("SELECT name FROM pragma_table_info('fx_rates')").all() as { name: string }[];
    expect(fxCols.map((c) => c.name).sort()).toEqual(["as_of", "currency", "source", "usd_per_unit"]);
  });
});
