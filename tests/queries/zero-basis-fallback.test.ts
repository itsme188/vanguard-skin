import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllHoldings } from "@/lib/queries/holdings";
import { getHoldingsBySecurity, getSecurityDetail } from "@/lib/queries/security-detail";

/**
 * scaledCostBasisFallbackSQL (lib/valuation.ts) treats a stored cost_basis
 * of exactly 0 the same way it treats NULL: unknown.
 *
 * The convention lives in lib/queries/holdings.ts, whose unrealized_gain
 * gate reads NULLIF(costBasisExpr, 0) IS NOT NULL, and is mirrored by
 * hasKnownBasis in AllHoldingsTable.tsx. Before this fix the helper read a
 * 0 as a KNOWN basis, so:
 *   - a live row carrying 0 BLOCKED the statement-row rescue a NULL row got
 *     (COALESCE stopped at the 0), and
 *   - even with the outer COALESCE fixed, the rescue subquery's own
 *     "cost_basis IS NOT NULL" filter would have picked that same zero row
 *     straight back up, because the zero row is normally the LATEST row for
 *     its (account, security) pair.
 * Both sides therefore carry the NULLIF. A position with no known basis
 * anywhere resolves to NULL — never to a fabricated $0 cost.
 *
 * Figures here are deliberately round synthetic ones.
 */
function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, `${symbol} Corp`);
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  costBasis: number | null,
  sourceKey: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, costBasis, asOfDate, sourceKey);
}

function seedPrice(
  db: Database.Database,
  securityId: number,
  date: string,
  closePrice: number
): void {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`
  ).run(securityId, date, closePrice);
}

const STATEMENT_DATE = "2026-06-30";
const LIVE_DATE = "2026-07-10";

describe("zero cost_basis and the statement-row rescue (getAllHoldings)", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable (seeded by migration 002)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("(a) rescues a live row's zero basis to the statement sibling's basis, covering its own shares", () => {
    const sym = "ZRESQ";
    const security = seedSecurity(db, sym);
    // Statement row: 100 shares cost $1,000 => $10/share.
    seedHolding(db, ACCOUNT_ID, security, 100, STATEMENT_DATE, 1000, `canonical:hold:${sym}`);
    // Live row (the one displayed): 105 shares, basis written as 0.
    seedHolding(db, ACCOUNT_ID, security, 105, LIVE_DATE, 0, `tws:hold:${sym}`);
    seedPrice(db, security, LIVE_DATE, 20);

    const row = getAllHoldings(db).find((r) => r.symbol === sym);

    expect(row).toBeTruthy();
    expect(row!.quantity).toBe(105);
    expect(row!.as_of_date).toBe(LIVE_DATE);
    // Same rescue a NULL basis receives. The position grew since the
    // statement, so the basis covers the statement's 100 shares only
    // (owner decision 2026-11-01): the 5 added shares inherit no cost.
    expect(row!.cost_basis).toBeCloseTo(1000, 6);
    expect(row!.basis_covered_quantity).toBe(100);
    // The gain is on the covered 100 shares: 2100 x 100/105 - 1000.
    expect(row!.current_value).toBe(2100);
    expect(row!.unrealized_gain).toBeCloseTo(2000 - 1000, 6);
  });

  it("(a2) keeps the short sign convention when rescuing a zero basis", () => {
    const sym = "ZSHRT";
    const security = seedSecurity(db, sym);
    // Older short: -80 shares, proceeds stored negative => $10/share.
    seedHolding(db, ACCOUNT_ID, security, -80, STATEMENT_DATE, -800, `canonical:hold:${sym}`);
    // Live short row carries 0.
    seedHolding(db, ACCOUNT_ID, security, -50, LIVE_DATE, 0, `tws:hold:${sym}`);
    seedPrice(db, security, LIVE_DATE, 20);

    const row = getAllHoldings(db).find((r) => r.symbol === sym);

    expect(row).toBeTruthy();
    // Magnitude scaled to the CURRENT share count, signed like the position.
    expect(row!.cost_basis).toBeCloseTo(-500, 6);
    expect(row!.current_value).toBe(-1000);
    expect(row!.unrealized_gain).toBeCloseTo(-1000 - -500, 6);
  });

  it("(b) resolves to NULL when the zero row has no known-basis sibling", () => {
    const sym = "ZONLY";
    const security = seedSecurity(db, sym);
    seedHolding(db, ACCOUNT_ID, security, 10, LIVE_DATE, 0, `tws:hold:${sym}`);
    seedPrice(db, security, LIVE_DATE, 50);

    const row = getAllHoldings(db).find((r) => r.symbol === sym);

    expect(row).toBeTruthy();
    expect(row!.cost_basis).toBeNull();
    expect(row!.unrealized_gain).toBeNull();
    // Market value is real regardless of basis.
    expect(row!.current_value).toBe(500);
  });

  it("(b2) does not rescue one zero from another zero — the subquery skips zero-basis rows", () => {
    const sym = "ZZERO";
    const security = seedSecurity(db, sym);
    seedHolding(db, ACCOUNT_ID, security, 100, STATEMENT_DATE, 0, `canonical:hold:${sym}`);
    seedHolding(db, ACCOUNT_ID, security, 100, LIVE_DATE, 0, `tws:hold:${sym}`);
    seedPrice(db, security, LIVE_DATE, 50);

    const row = getAllHoldings(db).find((r) => r.symbol === sym);

    expect(row!.cost_basis).toBeNull();
    expect(row!.unrealized_gain).toBeNull();
  });

  it("(c) leaves the NULL-basis rescue path unchanged", () => {
    const sym = "ZNULL";
    const security = seedSecurity(db, sym);
    seedHolding(db, ACCOUNT_ID, security, 100, STATEMENT_DATE, 1000, `canonical:hold:${sym}`);
    seedHolding(db, ACCOUNT_ID, security, 105, LIVE_DATE, null, `plaid:hold:${sym}`);
    seedPrice(db, security, LIVE_DATE, 20);

    const row = getAllHoldings(db).find((r) => r.symbol === sym);

    // Grown since the statement: the statement basis, unscaled, on its 100 shares.
    expect(row!.cost_basis).toBeCloseTo(1000, 6);
    expect(row!.basis_covered_quantity).toBe(100);
    expect(row!.unrealized_gain).toBeCloseTo(2000 - 1000, 6);
  });

  it("(c2) a NULL row whose only sibling basis is zero stays unknown", () => {
    const sym = "ZNSIB";
    const security = seedSecurity(db, sym);
    seedHolding(db, ACCOUNT_ID, security, 100, STATEMENT_DATE, 0, `canonical:hold:${sym}`);
    seedHolding(db, ACCOUNT_ID, security, 100, LIVE_DATE, null, `plaid:hold:${sym}`);
    seedPrice(db, security, LIVE_DATE, 20);

    const row = getAllHoldings(db).find((r) => r.symbol === sym);

    // Previously the NULL was "rescued" to the sibling's 0 and the Cost
    // column printed a confident $0.00 next to an em-dash Gain.
    expect(row!.cost_basis).toBeNull();
    expect(row!.unrealized_gain).toBeNull();
  });

  it("(d) leaves a non-zero stored basis untouched", () => {
    const sym = "ZKEEP";
    const security = seedSecurity(db, sym);
    seedHolding(db, ACCOUNT_ID, security, 100, STATEMENT_DATE, 1000, `canonical:hold:${sym}`);
    seedPrice(db, security, STATEMENT_DATE, 20);

    const row = getAllHoldings(db).find((r) => r.symbol === sym);

    expect(row!.cost_basis).toBeCloseTo(1000, 6);
    expect(row!.unrealized_gain).toBeCloseTo(2000 - 1000, 6);
  });
});

describe("zero cost_basis on the security detail page", () => {
  let db: Database.Database;
  const VANGUARD = 1; // seeded by migration 002
  const ROTH = 2;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("getHoldingsBySecurity reports a zero-basis-only position as unknown", () => {
    const sym = "ZDET";
    const security = seedSecurity(db, sym);
    seedHolding(db, VANGUARD, security, 100, LIVE_DATE, 0, `tws:hold:${sym}:v`);
    seedPrice(db, security, LIVE_DATE, 20);

    const positions = getHoldingsBySecurity(db, security);

    expect(positions).toHaveLength(1);
    expect(positions[0].cost_basis).toBeNull();
    expect(positions[0].unrealized_gain).toBeNull();
    expect(positions[0].current_value).toBe(2000);
  });

  it("getSecurityDetail totals stay unknown when the only basis on record is zero", () => {
    const sym = "ZTOT";
    const security = seedSecurity(db, sym);
    seedHolding(db, VANGUARD, security, 100, LIVE_DATE, 0, `tws:hold:${sym}:v`);
    seedHolding(db, ROTH, security, 50, LIVE_DATE, 0, `tws:hold:${sym}:r`);
    seedPrice(db, security, LIVE_DATE, 20);

    const detail = getSecurityDetail(db, security);

    expect(detail).toBeTruthy();
    // A $3,000 position that "cost $0" is a lie — unknown stays unknown.
    expect(detail!.totalCostBasis).toBeNull();
    expect(detail!.totalUnrealizedGain).toBeNull();
    expect(detail!.totalValue).toBe(3000);
  });

  it("getSecurityDetail totals sum only the known constituents when one position's basis is zero", () => {
    const sym = "ZMIX";
    const security = seedSecurity(db, sym);
    seedHolding(db, VANGUARD, security, 100, LIVE_DATE, 1000, `canonical:hold:${sym}:v`);
    seedHolding(db, ROTH, security, 50, LIVE_DATE, 0, `tws:hold:${sym}:r`);
    seedPrice(db, security, LIVE_DATE, 20);

    const detail = getSecurityDetail(db, security);

    // Partial total: the zero-basis leg contributes nothing and is disclosed
    // as unknown in its own row, exactly like a NULL leg.
    expect(detail!.totalCostBasis).toBeCloseTo(1000, 6);
    expect(detail!.totalUnrealizedGain).toBeCloseTo(2000 - 1000, 6);
    expect(detail!.totalValue).toBe(3000);
  });
});

// ─── Shares added since the statement (owner decision 2026-11-01, option A) ──
// A live row with no basis borrows the latest same-side statement basis. When
// the position has GROWN past that row, the basis is served unscaled and
// covers the statement's shares only; the gain is on those shares alone. A
// position that SHRANK keeps the per-share scale-down.
import { getHoldingsByAccount, getValuedHoldingsByAccount } from "@/lib/queries/holdings";

describe("basis coverage: grown, shrunk, own basis, short", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("grown: the basis covers the statement's shares, the gain leaves the new shares out", () => {
    const security = seedSecurity(db, "AAA");
    seedHolding(db, ACCOUNT_ID, security, 100, STATEMENT_DATE, 1000, "canonical:hold:AAA");
    seedHolding(db, ACCOUNT_ID, security, 110, LIVE_DATE, null, "plaid:hold:AAA");
    seedPrice(db, security, LIVE_DATE, 20);

    for (const row of [
      getAllHoldings(db).find((r) => r.symbol === "AAA")!,
      getValuedHoldingsByAccount(db, ACCOUNT_ID).find((r) => r.symbol === "AAA")!,
      getHoldingsBySecurity(db, security)[0],
    ]) {
      expect(row.quantity).toBe(110);
      expect(row.cost_basis).toBeCloseTo(1000, 6);
      expect(row.basis_covered_quantity).toBe(100);
      expect(row.current_value).toBe(2200);
      // 2200 x 100/110 - 1000
      expect(row.unrealized_gain).toBeCloseTo(1000, 6);
    }
    const byAccount = getHoldingsByAccount(db, ACCOUNT_ID).find((r) => r.symbol === "AAA")!;
    expect(byAccount.cost_basis).toBeCloseTo(1000, 6);
    expect(byAccount.basis_covered_quantity).toBe(100);
  });

  it("shrunk: the per-share basis is scaled down to today's shares, all of them covered", () => {
    const security = seedSecurity(db, "BBB");
    seedHolding(db, ACCOUNT_ID, security, 100, STATEMENT_DATE, 1000, "canonical:hold:BBB");
    seedHolding(db, ACCOUNT_ID, security, 80, LIVE_DATE, null, "plaid:hold:BBB");
    seedPrice(db, security, LIVE_DATE, 20);

    const row = getHoldingsBySecurity(db, security)[0];
    expect(row.cost_basis).toBeCloseTo(800, 6);
    expect(row.basis_covered_quantity).toBe(80);
    expect(row.unrealized_gain).toBeCloseTo(1600 - 800, 6);
  });

  it("own basis: unchanged, and it covers every share", () => {
    const security = seedSecurity(db, "CCC");
    seedHolding(db, ACCOUNT_ID, security, 100, STATEMENT_DATE, 1000, "canonical:hold:CCC");
    seedHolding(db, ACCOUNT_ID, security, 120, LIVE_DATE, 1500, "tws:hold:CCC");
    seedPrice(db, security, LIVE_DATE, 20);

    const row = getAllHoldings(db).find((r) => r.symbol === "CCC")!;
    expect(row.cost_basis).toBeCloseTo(1500, 6);
    expect(row.basis_covered_quantity).toBe(120);
    expect(row.unrealized_gain).toBeCloseTo(2400 - 1500, 6);
  });

  it("no known basis anywhere: no covered quantity", () => {
    const security = seedSecurity(db, "DDD");
    seedHolding(db, ACCOUNT_ID, security, 10, LIVE_DATE, null, "plaid:hold:DDD");
    seedPrice(db, security, LIVE_DATE, 20);

    const row = getAllHoldings(db).find((r) => r.symbol === "DDD")!;
    expect(row.cost_basis).toBeNull();
    expect(row.basis_covered_quantity).toBeNull();
    expect(row.unrealized_gain).toBeNull();
  });

  it("short grown: the statement proceeds, unscaled, cover the statement's shares only", () => {
    const security = seedSecurity(db, "ZZS");
    // Short 50 for proceeds of 500 (stored negative), now short 80.
    seedHolding(db, ACCOUNT_ID, security, -50, STATEMENT_DATE, -500, "canonical:hold:ZZS");
    seedHolding(db, ACCOUNT_ID, security, -80, LIVE_DATE, null, "tws:hold:ZZS");
    seedPrice(db, security, LIVE_DATE, 20);

    const row = getHoldingsBySecurity(db, security)[0];
    expect(row.cost_basis).toBeCloseTo(-500, 6);
    expect(row.basis_covered_quantity).toBe(-50);
    expect(row.current_value).toBe(-1600);
    // -1600 x 50/80 - (-500) = -1000 + 500
    expect(row.unrealized_gain).toBeCloseTo(-500, 6);
  });

  it("short shrunk: keeps the scale-down (the existing a2 case)", () => {
    const security = seedSecurity(db, "ZZT");
    seedHolding(db, ACCOUNT_ID, security, -80, STATEMENT_DATE, -800, "canonical:hold:ZZT");
    seedHolding(db, ACCOUNT_ID, security, -50, LIVE_DATE, null, "tws:hold:ZZT");
    seedPrice(db, security, LIVE_DATE, 20);

    const row = getHoldingsBySecurity(db, security)[0];
    expect(row.cost_basis).toBeCloseTo(-500, 6);
    expect(row.basis_covered_quantity).toBe(-50);
    expect(row.unrealized_gain).toBeCloseTo(-1000 - -500, 6);
  });

  it("the hub totals use the covered figures and name the partly covered row", () => {
    const security = seedSecurity(db, "EEE");
    // Account 1: grown 100 -> 110, no live basis. Account 2: own basis.
    seedHolding(db, 1, security, 100, STATEMENT_DATE, 1000, "canonical:hold:EEE:1");
    seedHolding(db, 1, security, 110, LIVE_DATE, null, "plaid:hold:EEE:1");
    seedHolding(db, 2, security, 50, LIVE_DATE, 600, "canonical:hold:EEE:2");
    seedPrice(db, security, LIVE_DATE, 20);

    const detail = getSecurityDetail(db, security)!;
    expect(detail.totalValue).toBe(3200);
    expect(detail.totalCostBasis).toBeCloseTo(1600, 6);
    // (2000 - 1000) + (1000 - 600)
    expect(detail.totalUnrealizedGain).toBeCloseTo(1400, 6);
    // Value the gain covers: 2200 x 100/110 + 1000.
    expect(detail.gainCoveredValue).toBeCloseTo(3000, 6);
    expect(detail.positionsPartlyCovered).toEqual([
      { account_id: 1, account_name: expect.any(String), quantity: 110, covered_quantity: 100 },
    ]);
  });
});
