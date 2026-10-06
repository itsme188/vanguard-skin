/**
 * lib/queries/security-detail.ts — Recent Sales header count.
 *
 * getClosedSalesBySecurity is capped at 20 rows, so the hub's
 * "Recent Sales · N" header must read a separate total that uses the
 * identical predicate (qa: security-detail-recent-sales--header-count-is-20-row-cap-not-total).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  getClosedSalesBySecurity,
  countClosedSalesBySecurity,
  getSecurityDetail,
} from "@/lib/queries/security-detail";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const ACCOUNT_ID = 1; // seeded by migration 002

function seedSecurity(db: Database.Database, symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedTxn(
  db: Database.Database,
  securityId: number,
  date: string,
  type: "BUY" | "SELL",
  qty: number,
  price: number
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ACCOUNT_ID,
    securityId,
    date,
    type,
    qty,
    price,
    type === "BUY" ? -(qty * price) : qty * price,
    `${type}-${securityId}-${date}`
  );
}

describe("countClosedSalesBySecurity", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("counts every sale while the list stays capped at 20", () => {
    const sec = seedSecurity(db, "VTI");
    const other = seedSecurity(db, "BND");
    seedTxn(db, sec, "2024-01-02", "BUY", 100, 10);
    seedTxn(db, other, "2024-01-02", "BUY", 10, 10);
    for (let i = 0; i < 25; i++) {
      const day = String(i + 1).padStart(2, "0");
      seedTxn(db, sec, `2025-03-${day}`, "SELL", 1, 12);
    }
    seedTxn(db, other, "2025-03-01", "SELL", 1, 12);
    computeTaxLots(db);

    expect(getClosedSalesBySecurity(db, sec)).toHaveLength(20);
    expect(countClosedSalesBySecurity(db, sec)).toBe(25);
    expect(countClosedSalesBySecurity(db, other)).toBe(1);

    const detail = getSecurityDetail(db, sec)!;
    expect(detail.closedSales).toHaveLength(20);
    expect(detail.closedSalesTotal).toBe(25);
  });

  it("returns 0 for a security with no sales", () => {
    const sec = seedSecurity(db, "VXUS");
    expect(countClosedSalesBySecurity(db, sec)).toBe(0);
  });
});

describe("security hub page — Recent Sales header", () => {
  const src = readFileSync(
    join(process.cwd(), "app/dashboard/security/[id]/page.tsx"),
    "utf8"
  );

  it("renders the true total beside the shown count and links to the full list", () => {
    const idx = anchorIndex(src, "Recent Sales");
    expect(idx).toBeGreaterThan(-1);
    const section = src.slice(idx, idx + 600);
    expect(section).toContain("closedSalesTotal");
    expect(section).toContain("/dashboard/tax-lots?security=${securityId}");
  });
});
