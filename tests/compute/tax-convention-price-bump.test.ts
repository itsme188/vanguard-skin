import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  bumpIfPricesAffectSyntheticCloses,
  getTaxInputGeneration,
} from "@/lib/compute/tax-convention";

let db: Database.Database;
let acctId: number;
let heldId: number;
let closedId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  acctId = (db.prepare(`INSERT INTO accounts (name) VALUES ('T') RETURNING id`).get() as { id: number }).id;
  heldId = (db.prepare(`INSERT INTO securities (symbol, security_type) VALUES ('HELD', 'stock') RETURNING id`).get() as { id: number }).id;
  closedId = (db.prepare(`INSERT INTO securities (symbol, security_type) VALUES ('GONE', 'stock') RETURNING id`).get() as { id: number }).id;
  const ins = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?,?,?,?,?)`,
  );
  ins.run(acctId, heldId, 10, "2026-08-01", "canonical:hold:h1");
  ins.run(acctId, closedId, 5, "2026-07-01", "canonical:hold:c1");
  ins.run(acctId, closedId, 0, "2026-08-01", "recon:closed-equity:t:stmt"); // tombstone state
});

const gen = () => getTaxInputGeneration(db);

describe("bumpIfPricesAffectSyntheticCloses", () => {
  it("bumps for a price at-or-before a tombstoned security's zero date", () => {
    const before = gen();
    expect(bumpIfPricesAffectSyntheticCloses(db, [{ securityId: closedId, date: "2026-07-15" }])).toBe(true);
    expect(gen()).toBe(before + 1);
  });
  it("bumps exactly once for many relevant pairs", () => {
    const before = gen();
    bumpIfPricesAffectSyntheticCloses(db, [
      { securityId: closedId, date: "2026-07-15" },
      { securityId: closedId, date: "2026-08-01" },
    ]);
    expect(gen()).toBe(before + 1);
  });
  it("does NOT bump for held securities (daily sync path)", () => {
    const before = gen();
    expect(bumpIfPricesAffectSyntheticCloses(db, [{ securityId: heldId, date: "2026-08-30" }])).toBe(false);
    expect(gen()).toBe(before);
  });
  it("does NOT bump for a price AFTER the zero date", () => {
    const before = gen();
    expect(bumpIfPricesAffectSyntheticCloses(db, [{ securityId: closedId, date: "2026-08-15" }])).toBe(false);
    expect(gen()).toBe(before);
  });
  it("no-ops on an empty pair list", () => {
    const before = gen();
    expect(bumpIfPricesAffectSyntheticCloses(db, [])).toBe(false);
    expect(gen()).toBe(before);
  });
});
