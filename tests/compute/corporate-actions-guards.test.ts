import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  validateCorporateActionInput,
  undoCorporateAction,
  ImportedActionError,
} from "@/lib/compute/corporate-actions";

describe("corporate-actions guards", () => {
  it("validateCorporateActionInput rejects bad ratios, bad dates, bad types", () => {
    const base = { actionType: "SPLIT", effectiveDate: "2026-07-01", ratioNumerator: 4, ratioDenominator: 1 };
    expect(validateCorporateActionInput(base)).toBeNull();
    expect(validateCorporateActionInput({ ...base, ratioNumerator: 0 })).toMatch(/ratio/i);
    expect(validateCorporateActionInput({ ...base, ratioDenominator: 0 })).toMatch(/ratio/i);
    expect(validateCorporateActionInput({ ...base, ratioNumerator: NaN })).toMatch(/ratio/i);
    expect(validateCorporateActionInput({ ...base, ratioNumerator: Infinity })).toMatch(/ratio/i);
    expect(validateCorporateActionInput({ ...base, effectiveDate: "07/01/2026" })).toMatch(/date/i);
    expect(validateCorporateActionInput({ ...base, effectiveDate: "2026-02-30" })).toMatch(/date/i);  // calendar-invalid
    expect(validateCorporateActionInput({ ...base, actionType: "MERGER" })).toMatch(/actionType/);
  });

  describe("undoCorporateAction import guard", () => {
    let db: Database.Database;
    let actionId: number;
    beforeEach(() => {
      db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      runMigrations(db);
      db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
      const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
      const r = db.prepare(
        `INSERT INTO corporate_actions
           (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source, source_key)
         VALUES (?, 'SPLIT', '2026-07-01', 4, 1, 0, 'import', 'ibkr:ca:split:2026-07-01:AAAA:4:1')`,
      ).run(secId);
      actionId = Number(r.lastInsertRowid);
    });

    it("throws ImportedActionError and leaves the row in place", () => {
      expect(() => undoCorporateAction(db, actionId)).toThrow(ImportedActionError);
      const still = db.prepare("SELECT COUNT(*) AS c FROM corporate_actions WHERE id = ?").get(actionId) as { c: number };
      expect(still.c).toBe(1);
    });
  });
});
