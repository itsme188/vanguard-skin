import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  repairSplitBasis,
  TARGETS,
} from "@/scripts/repair-split-basis-2024-year-end";

const STATEMENT_DATE = "2024-12-31";
const ACCOUNT_ID = 3;

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO accounts (id, name) VALUES (?, 'IBKR')").run(ACCOUNT_ID);
  return db;
}

function seedTarget(
  db: Database.Database,
  symbol: string,
  price: number,
  qty: number,
): number {
  const secId = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')",
    )
    .run(symbol, symbol).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'ibkr-activity')",
  ).run(secId, STATEMENT_DATE, price);
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(ACCOUNT_ID, secId, qty, STATEMENT_DATE, `test:${symbol}:${STATEMENT_DATE}`);
  return secId;
}

function readRow(db: Database.Database, secId: number) {
  const p = db
    .prepare("SELECT close_price FROM prices WHERE security_id = ? AND date = ?")
    .get(secId, STATEMENT_DATE) as { close_price: number };
  const h = db
    .prepare(
      "SELECT quantity FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?",
    )
    .get(ACCOUNT_ID, secId, STATEMENT_DATE) as { quantity: number };
  return { price: p.close_price, qty: h.quantity };
}

describe("repairSplitBasis", () => {
  let db: Database.Database;
  const secIds = new Map<string, number>();

  beforeEach(() => {
    db = createTestDb();
    secIds.clear();
    for (const t of TARGETS) {
      secIds.set(t.symbol, seedTarget(db, t.symbol, t.preSplitPrice, t.preSplitQty));
    }
  });

  it("normalizes all three targets to post-split basis, preserving every qty x price product", () => {
    const before = new Map(
      TARGETS.map((t) => {
        const r = readRow(db, secIds.get(t.symbol)!);
        return [t.symbol, r.price * r.qty] as const;
      }),
    );

    const reports = repairSplitBasis(db, { apply: true });
    expect(reports).toHaveLength(3);
    for (const r of reports) {
      expect(r.priceChanged).toBe(true);
      expect(r.qtyChanged).toBe(true);
    }

    for (const t of TARGETS) {
      const after = readRow(db, secIds.get(t.symbol)!);
      expect(after.price).toBeCloseTo(t.preSplitPrice / t.ratio, 6);
      expect(after.qty).toBeCloseTo(t.preSplitQty * t.ratio, 6);
      // The invariant the whole repair exists to preserve:
      expect(after.price * after.qty).toBeCloseTo(before.get(t.symbol)!, 6);
    }

    // Concrete pin on the CDLX reverse split (the 10x short over-count):
    const cdlx = readRow(db, secIds.get("CDLX")!);
    expect(cdlx.price).toBeCloseTo(37.1, 6);
    expect(cdlx.qty).toBeCloseTo(-300, 6);
  });

  it("dry-run (apply:false) reports the plan but writes nothing", () => {
    const reports = repairSplitBasis(db, { apply: false });
    expect(reports.every((r) => r.priceChanged && r.qtyChanged)).toBe(true);
    for (const t of TARGETS) {
      const row = readRow(db, secIds.get(t.symbol)!);
      expect(row.price).toBeCloseTo(t.preSplitPrice, 6);
      expect(row.qty).toBeCloseTo(t.preSplitQty, 6);
    }
  });

  it("is idempotent — a second apply run reports already-normalized and changes nothing", () => {
    repairSplitBasis(db, { apply: true });
    const snapshot = TARGETS.map((t) => readRow(db, secIds.get(t.symbol)!));

    const second = repairSplitBasis(db, { apply: true });
    for (const r of second) {
      expect(r.priceChanged).toBe(false);
      expect(r.qtyChanged).toBe(false);
      expect(r.priceAction).toContain("already normalized");
      expect(r.qtyAction).toContain("already normalized");
    }
    const after = TARGETS.map((t) => readRow(db, secIds.get(t.symbol)!));
    expect(after).toEqual(snapshot);
  });

  it("refuses to touch a row whose value matches neither the pre-split guard nor the normalized value", () => {
    const tqqqId = secIds.get("TQQQ")!;
    db.prepare("UPDATE prices SET close_price = 55.55 WHERE security_id = ?").run(tqqqId);
    db.prepare("UPDATE holdings SET quantity = 123 WHERE security_id = ?").run(tqqqId);

    const reports = repairSplitBasis(db, { apply: true });
    const tqqq = reports.find((r) => r.symbol === "TQQQ")!;
    expect(tqqq.priceChanged).toBe(false);
    expect(tqqq.qtyChanged).toBe(false);
    expect(tqqq.priceAction).toContain("UNEXPECTED");
    expect(tqqq.qtyAction).toContain("UNEXPECTED");

    const row = readRow(db, tqqqId);
    expect(row.price).toBeCloseTo(55.55, 6);
    expect(row.qty).toBeCloseTo(123, 6);

    // The other two targets still repair normally.
    const others = reports.filter((r) => r.symbol !== "TQQQ");
    expect(others.every((r) => r.priceChanged && r.qtyChanged)).toBe(true);
  });

  it("reports missing rows as skipped without throwing", () => {
    const fresh = createTestDb(); // no securities seeded at all
    const reports = repairSplitBasis(fresh, { apply: true });
    expect(reports).toHaveLength(3);
    for (const r of reports) {
      expect(r.securityId).toBeNull();
      expect(r.priceAction).toContain("skipped");
    }
  });
});
