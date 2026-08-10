import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  retypeSecuritiesAsEtf,
  type RetypeCandidate,
} from "@/scripts/repair-etf-types";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertSecurity(
  db: Database.Database,
  symbol: string,
  securityType: string | null,
  name?: string,
): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)")
    .run(symbol, name ?? `${symbol} name`, securityType);
  return result.lastInsertRowid as number;
}

function readType(db: Database.Database, id: number): string | null {
  return (
    db.prepare("SELECT security_type FROM securities WHERE id = ?").get(id) as {
      security_type: string | null;
    }
  ).security_type;
}

function candidateFor(
  db: Database.Database,
  id: number,
  symbol: string,
  securityType: string | null,
): RetypeCandidate {
  return { id, symbol, name: `${symbol} name`, securityType, fundCategory: null };
}

describe("retypeSecuritiesAsEtf", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("dry-run: reports would_retype for a 'Stock' row and writes nothing", () => {
    const id = insertSecurity(db, "ARKK", "Stock");
    const outcomes = retypeSecuritiesAsEtf(db, [candidateFor(db, id, "ARKK", "Stock")], {
      apply: false,
    });

    expect(outcomes).toEqual([
      { symbol: "ARKK", action: "would_retype", previousType: "Stock" },
    ]);
    expect(readType(db, id)).toBe("Stock"); // unchanged
  });

  it("apply: retypes a 'Stock' row to 'ETF'", () => {
    const id = insertSecurity(db, "ARKK", "Stock");
    const outcomes = retypeSecuritiesAsEtf(db, [candidateFor(db, id, "ARKK", "Stock")], {
      apply: true,
    });

    expect(outcomes).toEqual([{ symbol: "ARKK", action: "retyped", previousType: "Stock" }]);
    expect(readType(db, id)).toBe("ETF");
  });

  it("apply: retypes a NULL security_type row to 'ETF'", () => {
    const id = insertSecurity(db, "SOXX", null);
    const outcomes = retypeSecuritiesAsEtf(db, [candidateFor(db, id, "SOXX", null)], {
      apply: true,
    });

    expect(outcomes).toEqual([{ symbol: "SOXX", action: "retyped", previousType: null }]);
    expect(readType(db, id)).toBe("ETF");
  });

  it("refuses to retype a row whose current type is not 'Stock'/NULL", () => {
    const id = insertSecurity(db, "AGG", "Bond");
    const outcomes = retypeSecuritiesAsEtf(db, [candidateFor(db, id, "AGG", "Bond")], {
      apply: true,
    });

    expect(outcomes).toEqual([
      { symbol: "AGG", action: "skipped_not_stock", previousType: "Bond" },
    ]);
    expect(readType(db, id)).toBe("Bond"); // never downgraded/overwritten
  });

  it("never downgrades an already-'ETF'-typed row", () => {
    const id = insertSecurity(db, "SPY", "ETF");
    const outcomes = retypeSecuritiesAsEtf(db, [candidateFor(db, id, "SPY", "ETF")], {
      apply: true,
    });

    expect(outcomes[0].action).toBe("skipped_not_stock");
    expect(readType(db, id)).toBe("ETF");
  });

  it("never overwrites a statement-sourced 'Mutual Fund' type", () => {
    const id = insertSecurity(db, "VTSAX", "Mutual Fund");
    const outcomes = retypeSecuritiesAsEtf(db, [candidateFor(db, id, "VTSAX", "Mutual Fund")], {
      apply: true,
    });

    expect(outcomes[0].action).toBe("skipped_not_stock");
    expect(readType(db, id)).toBe("Mutual Fund");
  });

  it("refuses PSUS (closed-end fund) even though its current type is 'Stock'", () => {
    const id = insertSecurity(db, "PSUS", "Stock");
    const outcomes = retypeSecuritiesAsEtf(db, [candidateFor(db, id, "PSUS", "Stock")], {
      apply: true,
    });

    expect(outcomes).toEqual([
      { symbol: "PSUS", action: "skipped_closed_end_fund", previousType: "Stock" },
    ]);
    expect(readType(db, id)).toBe("Stock"); // untouched
  });

  it("refuses PSUS case-insensitively regardless of symbol casing", () => {
    const id = insertSecurity(db, "psus", "Stock");
    const outcomes = retypeSecuritiesAsEtf(db, [candidateFor(db, id, "psus", "Stock")], {
      apply: true,
    });

    expect(outcomes[0].action).toBe("skipped_closed_end_fund");
    expect(readType(db, id)).toBe("Stock");
  });

  it("handles a mixed batch: eligible rows retyped, ineligible rows refused, in one call", () => {
    const arkk = insertSecurity(db, "ARKK", "Stock");
    const agg = insertSecurity(db, "AGG", "Bond");
    const psus = insertSecurity(db, "PSUS", "Stock");
    const soxx = insertSecurity(db, "SOXX", null);

    const outcomes = retypeSecuritiesAsEtf(
      db,
      [
        candidateFor(db, arkk, "ARKK", "Stock"),
        candidateFor(db, agg, "AGG", "Bond"),
        candidateFor(db, psus, "PSUS", "Stock"),
        candidateFor(db, soxx, "SOXX", null),
      ],
      { apply: true },
    );

    expect(outcomes.map((o) => o.action)).toEqual([
      "retyped",
      "skipped_not_stock",
      "skipped_closed_end_fund",
      "retyped",
    ]);
    expect(readType(db, arkk)).toBe("ETF");
    expect(readType(db, agg)).toBe("Bond");
    expect(readType(db, psus)).toBe("Stock");
    expect(readType(db, soxx)).toBe("ETF");
  });

  it("dry-run never writes even for a mixed batch", () => {
    const arkk = insertSecurity(db, "ARKK", "Stock");
    const agg = insertSecurity(db, "AGG", "Bond");

    retypeSecuritiesAsEtf(
      db,
      [candidateFor(db, arkk, "ARKK", "Stock"), candidateFor(db, agg, "AGG", "Bond")],
      { apply: false },
    );

    expect(readType(db, arkk)).toBe("Stock");
    expect(readType(db, agg)).toBe("Bond");
  });
});
