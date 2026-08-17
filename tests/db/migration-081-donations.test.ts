import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

function cols(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);
}

describe("migration 081 — donations", () => {
  it("creates donations, donation_leg_links, donation_lots with constraints and indexes", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    expect(cols(db, "donations")).toEqual(
      expect.arrayContaining([
        "id", "source_key", "import_batch_id", "kind", "security_id", "symbol_raw",
        "quantity", "fmv_usd", "unit_valuation", "created_date", "received_date",
        "completed_date", "reversed_date", "notes",
      ])
    );
    expect(cols(db, "donation_leg_links")).toEqual(
      expect.arrayContaining(["id", "donation_id", "transaction_id", "role", "created_at"])
    );
    expect(cols(db, "donation_lots")).toEqual(
      expect.arrayContaining(["id", "donation_id", "acquisition_transaction_id", "quantity", "created_at"])
    );

    // CHECK constraints reject bad rows
    const insertDonation = db.prepare(
      `INSERT INTO donations (source_key, kind, fmv_usd, received_date) VALUES (?, ?, ?, ?)`
    );
    expect(() => insertDonation.run("k1", "stock", -5, "2026-01-01")).toThrow(); // fmv_usd > 0
    expect(() => insertDonation.run("k2", "weird", 5, "2026-01-01")).toThrow(); // kind check
    insertDonation.run("k3", "cash", 5, "2026-01-01"); // valid

    // partial unique indexes: one 'out' + one 'routing_artifact' link per donation
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["idx_donation_out_link", "idx_donation_artifact_link", "idx_donations_received", "idx_donations_security"]));

    // FK integrity clean
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("upgrades a POPULATED database cleanly (081 is additive)", () => {
    // Codex plan-review #9: simulate an existing live DB — full migrations, then seed
    // realistic rows in the tables 081 references, then assert coexistence + FK health.
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('FAKE','Fake Corp','Stock')").run();
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, is_external_flow, source_key)
       VALUES (1, 1, '2026-01-05', 'BUY', 10, -1000, 0, 'seed:1')`
    ).run();
    db.prepare("INSERT INTO donations (source_key, kind, security_id, quantity, fmv_usd, received_date) VALUES ('d1','stock',1,10,1200,'2026-02-01')").run();
    db.prepare("INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (1, 1, 'out')").run();
    db.prepare("INSERT INTO donation_lots (donation_id, acquisition_transaction_id, quantity) VALUES (1, 1, 5)").run();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
