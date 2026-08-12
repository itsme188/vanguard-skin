import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Migrations seed default accounts, including one named 'IBKR' — reuse it
  // rather than inserting a duplicate (accounts.name is UNIQUE). 'Roth' is
  // distinct from the seeded 'Vanguard Roth IRA', so it's inserted fresh.
  db.prepare("INSERT INTO accounts (name) VALUES ('Roth')").run();
  db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
  const ibkr = (db.prepare("SELECT id FROM accounts WHERE name='IBKR'").get() as { id: number }).id;
  const roth = (db.prepare("SELECT id FROM accounts WHERE name='Roth'").get() as { id: number }).id;
  const sec = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
  return { db, ibkr, roth, sec };
}

function insertTxn(db: Database.Database, accountId: number, secId: number,
  date: string, type: string, qty: number, price: number, key: string) {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(accountId, secId, date, type, qty, price, qty * price, key);
}

function insertSplit(db: Database.Database, secId: number, accountId: number | null,
  date: string, num: number, den: number, delta: number | null, source = "import") {
  db.prepare(
    `INSERT INTO corporate_actions
       (security_id, account_id, action_type, effective_date, ratio_numerator, ratio_denominator,
        applied, source, source_key, quantity_delta)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(secId, accountId, num >= den ? "SPLIT" : "REVERSE_SPLIT", date, num, den, source,
        source === "import" ? `ibkr:ca:split:${date}:AAAA:${num}:${den}` : null, delta);
}

describe("computeTaxLots: import-sourced split replay", () => {
  it("adjusts an open lot: qty ×4, per-share ÷4, total basis and date unchanged; clean delta → NULL", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    computeTaxLots(db);
    const lot = db.prepare("SELECT * FROM tax_lots").get() as Record<string, number | string>;
    expect(lot.quantity_acquired).toBeCloseTo(400);
    expect(lot.quantity_remaining).toBeCloseTo(400);
    expect(lot.acquisition_price).toBeCloseTo(100);
    expect(lot.cost_basis).toBeCloseTo(40000);
    expect(lot.acquisition_date).toBe("2026-06-01");
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeNull();   // 100 × (4−1) = 300 = statement delta
  });

  it("post-split sell consumes post-split units with correct realized P&L", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");   // $40,000 basis
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    insertTxn(db, ibkr, sec, "2026-07-10", "SELL", 400, 110, "k2");
    computeTaxLots(db);
    const sale = db.prepare("SELECT * FROM tax_lot_sales").get() as Record<string, number>;
    expect(sale.quantity_sold).toBeCloseTo(400);
    expect(sale.cost_basis_allocated).toBeCloseTo(40000);
    expect(sale.proceeds).toBeCloseTo(44000);
    expect(sale.realized_gain_loss).toBeCloseTo(4000);
  });

  it("same-date sell processes BEFORE the split (end-of-day rule)", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    insertTxn(db, ibkr, sec, "2026-07-01", "SELL", 40, 420, "k2");   // split-day sell, pre-split units
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 180);             // 60 open × 3 = 180
    computeTaxLots(db);
    const sale = db.prepare("SELECT quantity_sold, cost_basis_allocated FROM tax_lot_sales").get() as Record<string, number>;
    expect(sale.quantity_sold).toBeCloseTo(40);                      // NOT 160
    expect(sale.cost_basis_allocated).toBeCloseTo(16000);
    const lot = db.prepare("SELECT quantity_remaining, acquisition_price FROM tax_lots").get() as Record<string, number>;
    expect(lot.quantity_remaining).toBeCloseTo(240);                 // (100−40) × 4
    expect(lot.acquisition_price).toBeCloseTo(100);
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeNull();
  });

  it("fully-closed pre-split sales keep their original recorded units", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-05-01", "BUY", 50, 380, "k1");
    insertTxn(db, ibkr, sec, "2026-06-01", "SELL", 50, 420, "k2");
    insertTxn(db, ibkr, sec, "2026-06-15", "BUY", 100, 400, "k3");
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    computeTaxLots(db);
    const closedSale = db.prepare("SELECT quantity_sold, realized_gain_loss FROM tax_lot_sales").get() as Record<string, number>;
    expect(closedSale.quantity_sold).toBeCloseTo(50);
    expect(closedSale.realized_gain_loss).toBeCloseTo(50 * (420 - 380));
  });

  it("sequential splits compose; reverse split divides", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-05-01", "BUY", 100, 400, "k1");
    insertSplit(db, sec, ibkr, "2026-06-01", 2, 1, 100);
    insertSplit(db, sec, ibkr, "2026-07-01", 1, 10, -180);           // 200 → 20
    computeTaxLots(db);
    const lot = db.prepare("SELECT quantity_remaining, acquisition_price, cost_basis FROM tax_lots").get() as Record<string, number>;
    expect(lot.quantity_remaining).toBeCloseTo(20);
    expect(lot.acquisition_price).toBeCloseTo(2000);
    expect(lot.cost_basis).toBeCloseTo(40000);
  });

  it("fractional reverse-split result + cash-in-lieu delta → mismatch persisted (tripwire)", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-05-01", "BUY", 75, 100, "k1");
    // pure ratio: 75 × (0.1 − 1) = −67.5; broker cashed the 0.5 fraction → statement says −68
    insertSplit(db, sec, ibkr, "2026-07-01", 1, 10, -68);
    const result = computeTaxLots(db);
    const lot = db.prepare("SELECT quantity_remaining FROM tax_lots").get() as { quantity_remaining: number };
    expect(lot.quantity_remaining).toBeCloseTo(7.5);                 // fractional retained (disclosed)
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeCloseTo(0.5);                     // −67.5 − (−68)
    expect(result.replayWarnings.length).toBeGreaterThan(0);
  });

  it("manual-source rows are EXCLUDED from the replay (double-apply guard)", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 400, 100, "k1");   // already post-split basis (manual rewrite ran)
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, null, "manual");
    computeTaxLots(db);
    const lot = db.prepare("SELECT quantity_remaining, acquisition_price FROM tax_lots").get() as Record<string, number>;
    expect(lot.quantity_remaining).toBeCloseTo(400);                 // NOT 1600
    expect(lot.acquisition_price).toBeCloseTo(100);
  });

  it("split applies to ALL accounts' lots but cross-checks only the importing account", () => {
    const { db, ibkr, roth, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    insertTxn(db, roth, sec, "2026-06-01", "BUY", 10, 400, "k2");
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);             // matches IBKR's 100 × 3 only
    computeTaxLots(db);
    const rothLot = db.prepare("SELECT quantity_remaining FROM tax_lots WHERE account_id = ?").get(roth) as { quantity_remaining: number };
    expect(rothLot.quantity_remaining).toBeCloseTo(40);
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeNull();                           // Roth's 30 not double-counted
  });

  it("no open lots → delta mismatch persisted + warning returned", () => {
    const { db, ibkr, sec } = setup();
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    const result = computeTaxLots(db);
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeCloseTo(-300);                    // implied 0 − stated 300
    expect(result.replayWarnings.join("\n")).toContain("AAAA");
  });

  it("same-date BUY is split-adjusted (acquisition_date <= effective_date, end-of-day)", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-07-01", "BUY", 100, 400, "k1");   // bought ON split day, pre-split units
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    computeTaxLots(db);
    const lot = db.prepare("SELECT quantity_remaining, acquisition_price FROM tax_lots").get() as Record<string, number>;
    expect(lot.quantity_remaining).toBeCloseTo(400);
    expect(lot.acquisition_price).toBeCloseTo(100);
  });

  it("a previously persisted mismatch refreshes back to NULL once the missing data lands", () => {
    const { db, ibkr, sec } = setup();
    insertSplit(db, sec, ibkr, "2026-07-01", 4, 1, 300);
    computeTaxLots(db);                                              // no lots → mismatch persisted
    let ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).not.toBeNull();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");   // the missing history arrives
    computeTaxLots(db);
    ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeNull();                           // each recompute refreshes it
  });
});
