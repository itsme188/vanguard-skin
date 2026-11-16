/**
 * Cash deploy review findings of 2026-11-15 (wave S). Synthetic symbols and
 * round figures only. Vanguard scope = account 1, benchmark VTI.
 *  S-5: when nothing can be placed, the reason names the underweight sectors
 *       with room and says what blocked each kind of candidate. No figure.
 *  S-6: a zero, negative or non-finite amount places nothing, leaves
 *       nothing "unallocated", and says why; the route answers 400.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { suggestAllocation } from "@/lib/compute/cash-deploy";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const DATE = "2026-10-07";
let db: Database.Database;
let nextId = 1;

function add(symbol: string, type: string, sector: string | null, price: number, qty: number | null): number {
  const id = nextId++;
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (?, ?, ?, ?)`).run(
    id,
    symbol,
    type,
    sector,
  );
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`).run(
    id,
    DATE,
    price,
  );
  if (qty !== null) {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, ?, ?)`,
    ).run(id, DATE, qty, `sw-${symbol}`);
  }
  return id;
}

function watch(id: number) {
  db.prepare(
    `INSERT INTO watchlist (security_id, group_name, thesis, is_active, added_date) VALUES (?, 'default', 't', 1, ?)`,
  ).run(id, DATE);
}

function weights(symbol: string, w: Array<[string, number]>) {
  const ins = db.prepare(
    `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, ?, 'manual')`,
  );
  for (const [s, p] of w) ins.run(symbol, s, p, DATE);
}

beforeEach(() => {
  nextId = 1;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("DELETE FROM watchlist").run();
  hoisted.db = db;
});

describe("S-5: a specific reason when nothing is placed", () => {
  it("names the underweight sectors and the overweight sector the funds also add to", () => {
    add("ZZT", "Stock", "Technology", 100, 1000); // 100,000, far past Technology's weight
    const fund = add("ZZIX", "ETF", "Diversified", 100, null);
    weights("ZZIX", [["Technology", 50], ["Healthcare", 50]]);
    watch(fund);
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    expect(r.picks).toEqual([]);
    const reason = r.unallocatedReason ?? "";
    // The largest underweight sectors with room are named.
    expect(reason).toContain("Healthcare");
    // Single names: none on the watchlist or held in those sectors.
    expect(reason).toMatch(/no single name on the watchlist or held/i);
    // Funds: they also add to Technology, already at or past its weight.
    expect(reason).toMatch(/funds considered also add to Technology/);
    // Figure-free, and short.
    expect(reason).not.toMatch(/\d/);
    expect(reason.split(/[.;]\s/).length).toBeLessThanOrEqual(3);
  });

  it("without any fund candidate it says no fund covers them either", () => {
    add("ZZT", "Stock", "Technology", 100, 1000);
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    expect(r.picks).toEqual([]);
    expect(r.unallocatedReason).toMatch(/no single name on the watchlist or held/i);
    expect(r.unallocatedReason).toMatch(/no fund/i);
    expect(r.unallocatedReason).not.toMatch(/\d/);
  });
});

describe("S-6: a non-positive or non-finite amount", () => {
  for (const cash of [0, -500, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`places nothing and reports no unallocated cash for ${cash}`, () => {
      add("ZZT", "Stock", "Technology", 100, 10);
      const r = suggestAllocation(db, "vanguard", [1], cash);
      expect(r.picks).toEqual([]);
      expect(r.totalAllocated).toBe(0);
      expect(r.cashRemaining).toBe(0);
      expect(r.unallocatedReason).toMatch(/above zero/i);
    });
  }

  for (const param of ["0", "-500", "abc", "Infinity", ""]) {
    it(`the route answers 400 with a plain message for cash=${JSON.stringify(param)}`, async () => {
      const { GET } = await import("@/app/api/analysis/cash-deploy/route");
      const res = await GET(new Request(`http://localhost/api/analysis/cash-deploy?scope=vanguard&cash=${param}`) as never);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/above zero/i);
    });
  }

  it("the route still answers a positive amount", async () => {
    add("ZZT", "Stock", "Technology", 100, 10);
    const { GET } = await import("@/app/api/analysis/cash-deploy/route");
    const res = await GET(new Request("http://localhost/api/analysis/cash-deploy?scope=vanguard&cash=1000") as never);
    expect(res.status).toBe(200);
  });
});
