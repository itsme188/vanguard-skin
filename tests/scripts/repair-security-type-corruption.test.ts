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
  preflightRehomes,
  applyRehomes,
  findTypeContradictions,
  type KnownTypeRepair,
  type RepairConfig,
  type InterestRehome,
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

describe("preflightRehomes / applyRehomes", () => {
  let db: Database.Database;
  const REHOME: InterestRehome = {
    transactionId: 5001, fromSecurityId: 900, toSecurityId: 901,
    expectTradeDate: "2025-01-15", expectFees: 123.45, setAmount: 123.45,
    newSourceKey: "canonical:txn:Acct:FAKECUSIP1:2025-01-15:INTEREST:12345",
  };
  beforeEach(() => {
    db = createTestDb();
    // account id 1 ("Vanguard Taxable") is pre-seeded by migration 002_seed_accounts.sql
    seedCorrupted(db); // id 900 from Task 2's helper
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, maturity_date)
       VALUES (901, 'FAKECUSIP1', 'U S TREASURY NOTE CPN 9.999% DUE 01/15/40', 'Bond', '2040-01-15')`
    ).run();
    db.prepare(
      `INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount, fees, source_key)
       VALUES (5001, 1, 900, '2025-01-15', 'INTEREST', NULL, NULL, 123.45,
               'canonical:txn:Acct:AAA:2025-01-15:INTEREST:0')`
    ).run();
  });

  it("preflight reports would_repair and leaves the row untouched", () => {
    expect(preflightRehomes(db, [REHOME])[0].action).toBe("would_repair");
    const row = db.prepare(`SELECT security_id, amount FROM transactions WHERE id = 5001`).get() as any;
    expect(row.security_id).toBe(900);
    expect(row.amount).toBeNull();
  });

  it("apply repoints, moves the coupon to amount, zeroes fees, rewrites source_key", () => {
    applyRehomes(db, [REHOME]);
    const row = db
      .prepare(`SELECT security_id, amount, fees, source_key FROM transactions WHERE id = 5001`)
      .get() as any;
    expect(row.security_id).toBe(901);
    expect(row.amount).toBe(123.45);
    expect(row.fees).toBe(0);
    expect(row.source_key).toBe(REHOME.newSourceKey);
  });

  it("second apply is skipped_already_correct (idempotent)", () => {
    applyRehomes(db, [REHOME]);
    expect(applyRehomes(db, [REHOME])[0].action).toBe("skipped_already_correct");
  });

  it("refuses when amount is already populated (row was hand-fixed)", () => {
    db.prepare(`UPDATE transactions SET amount = 123.45 WHERE id = 5001`).run();
    expect(preflightRehomes(db, [REHOME])[0].action).toBe("precondition_mismatch");
    expect(() => applyRehomes(db, [REHOME])).toThrow(/precondition/i);
  });

  it("refuses when the corrected source_key already exists (corrected CSV already re-imported)", () => {
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, source_key)
       VALUES (1, 901, '2025-01-15', 'INTEREST', 123.45, ?)`
    ).run(REHOME.newSourceKey);
    const out = preflightRehomes(db, [REHOME]);
    expect(out[0].action).toBe("precondition_mismatch");
    expect(out[0].detail).toContain("source_key");
  });
});

describe("findTypeContradictions", () => {
  it("flags a bond-typed security with many equity fills + equity fund_category; excludes known ids; ignores ETFs and low-fill funds", () => {
    const db = createTestDb();
    // account id 1 ("Vanguard Taxable") is pre-seeded by migration 002_seed_accounts.sql
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, fund_category)
       VALUES (910, 'ZZZ', 'Bond', 'US Sector Equity (Technology)')`
    ).run();
    const buy = db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
       VALUES (1, 910, '2026-01-05', 'BUY', 10, -100)`
    );
    for (let i = 0; i < 12; i++) buy.run();
    // genuine fund below the floor — not flagged
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (911, 'REALFUND', 'Mutual Fund')`).run();
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
       VALUES (1, 911, '2026-01-05', 'BUY', 10, -100)`
    ).run();
    // genuine sector ETF — must NOT be flagged by predicate 2
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, fund_category)
       VALUES (912, 'XLZ', 'ETF', 'US Sector Equity (Energy)')`
    ).run();
    const rows = findTypeContradictions(db, []);
    expect(rows.map((r) => r.symbol)).toEqual(["ZZZ"]);
    // and the exclude list removes known repairs
    expect(findTypeContradictions(db, [910])).toEqual([]);
  });
});
