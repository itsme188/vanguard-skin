import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  preflightTypeRepairs,
  applyTypeRepairs,
  loadRepairConfig,
  type KnownTypeRepair,
  type RepairConfig,
} from "@/scripts/repair-security-type-corruption";

function createTestDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const FAKE_TREASURY_NAME = "S TREASURY NOTE 0 CPN 9.999% DUE 01/15/40 DTD 01/15/25";

const REPAIR: KnownTypeRepair = {
  id: 900, symbol: "AAA", expectType: "Bond", setType: "Stock",
  setName: "EXAMPLE CORP", expectNameLike: "TREASURY", clearBondFields: true,
};

function seedCorrupted(db: Database.Database) {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, asset_class, maturity_date, coupon_rate)
     VALUES (900, 'AAA', ?, 'Bond', 'equity', '2040-01-15', 9.999)`
  ).run(FAKE_TREASURY_NAME);
}

describe("preflightTypeRepairs / applyTypeRepairs", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("preflight reports would_repair and writes nothing", () => {
    seedCorrupted(db);
    const out = preflightTypeRepairs(db, [REPAIR]);
    expect(out).toEqual([{ symbol: "AAA", action: "would_repair", previousType: "Bond" }]);
    const row = db.prepare(`SELECT security_type, maturity_date FROM securities WHERE id = 900`).get() as any;
    expect(row.security_type).toBe("Bond");
    expect(row.maturity_date).toBe("2040-01-15");
  });

  it("apply retypes, restores the name, and clears bond fields", () => {
    seedCorrupted(db);
    applyTypeRepairs(db, [REPAIR]);
    const row = db
      .prepare(`SELECT security_type, name, maturity_date, coupon_rate FROM securities WHERE id = 900`)
      .get() as any;
    expect(row.security_type).toBe("Stock");
    expect(row.name).toBe("EXAMPLE CORP");
    expect(row.maturity_date).toBeNull();
    expect(row.coupon_rate).toBeNull();
  });

  it("a row already in its target state is skipped_already_correct and apply is a clean no-op", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type) VALUES (900, 'AAA', 'EXAMPLE CORP', 'Stock')`
    ).run();
    expect(preflightTypeRepairs(db, [REPAIR])[0].action).toBe("skipped_already_correct");
    const out = applyTypeRepairs(db, [REPAIR]);       // second-apply idempotence
    expect(out[0].action).toBe("skipped_already_correct");
  });

  it("an unexpected state fails preflight and applyTypeRepairs throws before writing ANYTHING", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type) VALUES (900, 'AAA', 'SOMETHING ELSE', 'ETF')`
    ).run();
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type) VALUES (901, 'CCC', ?, 'Bond')`
    ).run(FAKE_TREASURY_NAME);
    const second: KnownTypeRepair = {
      id: 901, symbol: "CCC", expectType: "Bond", setType: "Stock",
      setName: "OTHER CORP", expectNameLike: "TREASURY",
    };
    expect(preflightTypeRepairs(db, [REPAIR, second])[0].action).toBe("precondition_mismatch");
    expect(() => applyTypeRepairs(db, [REPAIR, second])).toThrow(/precondition/i);
    // the OTHER (clean) row must be untouched — all-or-nothing
    const row = db.prepare(`SELECT security_type FROM securities WHERE id = 901`).get() as any;
    expect(row.security_type).toBe("Bond");
  });

  it("a repair without setName leaves the existing name untouched", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type) VALUES (902, 'DDD', 'REAL STOCK INC.', 'ETF')`
    ).run();
    applyTypeRepairs(db, [{ id: 902, symbol: "DDD", expectType: "ETF", setType: "Stock" }]);
    const row = db.prepare(`SELECT security_type, name FROM securities WHERE id = 902`).get() as any;
    expect(row.security_type).toBe("Stock");
    expect(row.name).toBe("REAL STOCK INC.");
  });

  it("a missing row id is precondition_mismatch, not a throw, at preflight", () => {
    expect(preflightTypeRepairs(db, [REPAIR])[0].action).toBe("precondition_mismatch");
  });
});

describe("loadRepairConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-security-type-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(obj: unknown): string {
    const filePath = path.join(tmpDir, "repair-config.json");
    fs.writeFileSync(filePath, JSON.stringify(obj), "utf-8");
    return filePath;
  }

  const VALID_CONFIG: RepairConfig = {
    knownTypeRepairs: [REPAIR],
    treasuryInterestRehomes: [
      {
        transactionId: 500,
        fromSecurityId: 900,
        toSecurityId: 901,
        expectTradeDate: "2026-01-15",
        expectFees: 0,
        setAmount: 12.34,
        newSourceKey: "synthetic:interest-rehome:900:2026-01-15",
      },
    ],
    neverUndoImportBatches: [42],
    csvCorrections: [
      { file: "example-statement.csv", approxLine: 17, fix: "correct the transcribed ticker column" },
    ],
  };

  it("parses a valid config shape", () => {
    const filePath = writeConfig(VALID_CONFIG);
    const config = loadRepairConfig(filePath);
    expect(config).toEqual(VALID_CONFIG);
  });

  it("throws when the file is missing", () => {
    expect(() => loadRepairConfig(path.join(tmpDir, "does-not-exist.json"))).toThrow();
  });

  it("throws when knownTypeRepairs is missing", () => {
    const { knownTypeRepairs: _omit, ...rest } = VALID_CONFIG;
    const filePath = writeConfig(rest);
    expect(() => loadRepairConfig(filePath)).toThrow(/knownTypeRepairs/);
  });

  it("throws when treasuryInterestRehomes is missing", () => {
    const { treasuryInterestRehomes: _omit, ...rest } = VALID_CONFIG;
    const filePath = writeConfig(rest);
    expect(() => loadRepairConfig(filePath)).toThrow(/treasuryInterestRehomes/);
  });

  it("throws when a knownTypeRepairs entry has setName but no expectNameLike", () => {
    const filePath = writeConfig({
      ...VALID_CONFIG,
      knownTypeRepairs: [{ id: 900, symbol: "AAA", expectType: "Bond", setType: "Stock", setName: "EXAMPLE CORP" }],
    });
    expect(() => loadRepairConfig(filePath)).toThrow(/expectNameLike/);
  });

  it("throws when the file is not valid JSON", () => {
    const filePath = path.join(tmpDir, "broken.json");
    fs.writeFileSync(filePath, "{ not json", "utf-8");
    expect(() => loadRepairConfig(filePath)).toThrow();
  });
});
