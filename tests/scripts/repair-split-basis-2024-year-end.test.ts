import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  repairSplitBasis,
  parseTargetsConfig,
  type SplitBasisTarget,
} from "@/scripts/repair-split-basis-2024-year-end";

const STATEMENT_DATE = "2024-12-31";
const ACCOUNT_ID = 3;

// Synthetic targets — real guard values live in the gitignored
// data/repair-configs/split-basis-2024-year-end.json, injected at the CLI.
// Shapes mirror the real repair: two forward 2:1 splits + one 1:10 reverse
// on a short position (negative quantity).
const TARGETS: SplitBasisTarget[] = [
  { symbol: "AAAA", ratio: 2, preSplitPrice: 50.0, preSplitQty: 10 },
  { symbol: "BBBB", ratio: 2, preSplitPrice: 80.0, preSplitQty: 40 },
  { symbol: "CCCC", ratio: 0.1, preSplitPrice: 4.0, preSplitQty: -500 },
];

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

    const reports = repairSplitBasis(db, TARGETS, { apply: true });
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

    // Concrete pin on the reverse split (a 10x-overcounted short):
    const rev = readRow(db, secIds.get("CCCC")!);
    expect(rev.price).toBeCloseTo(40.0, 6);
    expect(rev.qty).toBeCloseTo(-50, 6);
  });

  it("dry-run (apply:false) reports the plan but writes nothing", () => {
    const reports = repairSplitBasis(db, TARGETS, { apply: false });
    expect(reports.every((r) => r.priceChanged && r.qtyChanged)).toBe(true);
    for (const t of TARGETS) {
      const row = readRow(db, secIds.get(t.symbol)!);
      expect(row.price).toBeCloseTo(t.preSplitPrice, 6);
      expect(row.qty).toBeCloseTo(t.preSplitQty, 6);
    }
  });

  it("is idempotent — a second apply run reports already-normalized and changes nothing", () => {
    repairSplitBasis(db, TARGETS, { apply: true });
    const snapshot = TARGETS.map((t) => readRow(db, secIds.get(t.symbol)!));

    const second = repairSplitBasis(db, TARGETS, { apply: true });
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
    const firstId = secIds.get("AAAA")!;
    db.prepare("UPDATE prices SET close_price = 55.55 WHERE security_id = ?").run(firstId);
    db.prepare("UPDATE holdings SET quantity = 123 WHERE security_id = ?").run(firstId);

    const reports = repairSplitBasis(db, TARGETS, { apply: true });
    const first = reports.find((r) => r.symbol === "AAAA")!;
    expect(first.priceChanged).toBe(false);
    expect(first.qtyChanged).toBe(false);
    expect(first.priceAction).toContain("UNEXPECTED");
    expect(first.qtyAction).toContain("UNEXPECTED");

    const row = readRow(db, firstId);
    expect(row.price).toBeCloseTo(55.55, 6);
    expect(row.qty).toBeCloseTo(123, 6);

    // The other two targets still repair normally.
    const others = reports.filter((r) => r.symbol !== "AAAA");
    expect(others.every((r) => r.priceChanged && r.qtyChanged)).toBe(true);
  });

  it("reports missing rows as skipped without throwing", () => {
    const fresh = createTestDb(); // no securities seeded at all
    const reports = repairSplitBasis(fresh, TARGETS, { apply: true });
    expect(reports).toHaveLength(3);
    for (const r of reports) {
      expect(r.securityId).toBeNull();
      expect(r.priceAction).toContain("skipped");
    }
  });
});

describe("parseTargetsConfig", () => {
  it("accepts a well-formed array and returns typed targets", () => {
    const parsed = parseTargetsConfig(
      JSON.parse(
        '[{"symbol":"AAAA","ratio":2,"preSplitPrice":50,"preSplitQty":10}]',
      ),
    );
    expect(parsed).toEqual([
      { symbol: "AAAA", ratio: 2, preSplitPrice: 50, preSplitQty: 10 },
    ]);
  });

  it("rejects non-arrays, empty arrays, and malformed entries", () => {
    expect(() => parseTargetsConfig({})).toThrow("non-empty JSON array");
    expect(() => parseTargetsConfig([])).toThrow("non-empty JSON array");
    expect(() =>
      parseTargetsConfig([{ symbol: "AAAA", ratio: 0, preSplitPrice: 1, preSplitQty: 1 }]),
    ).toThrow("malformed");
    expect(() =>
      parseTargetsConfig([{ symbol: "AAAA", ratio: 2, preSplitPrice: "x", preSplitQty: 1 }]),
    ).toThrow("malformed");
  });
});
