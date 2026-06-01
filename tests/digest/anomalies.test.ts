import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeAnomalies, formatVanguardAnomaliesBlock } from "@/lib/digest/anomalies";
import { upsertBeta } from "@/lib/mutations/security-betas";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ─── Seed helpers ─────────────────────────────────────────────────────────────

function seedSecurity(symbol: string, name?: string): number {
  const res = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, name ?? `${symbol} Corp`);
  return res.lastInsertRowid as number;
}

function seedAccount(name: string): number {
  // Migration 002 pre-seeds "Vanguard Taxable" and "Vanguard Roth IRA" — use
  // INSERT OR IGNORE so we don't collide, then read back the actual row id.
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  const row = db
    .prepare("SELECT id FROM accounts WHERE name = ?")
    .get(name) as { id: number };
  return row.id;
}

function seedHolding(accountId: number, securityId: number, date = "2026-05-08"): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, ?, ?)`
  ).run(accountId, securityId, date, `test:${accountId}:${securityId}:${date}`);
}

function seedPrice(securityId: number, date: string, closePrice: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'vanguard')"
  ).run(securityId, date, closePrice);
}

function seedBeta(securityId: number, beta: number, residualStd?: number): void {
  upsertBeta(db, { securityId, lookbackDays: 60, beta, residualStd });
}

// ─── SPY setup helper ─────────────────────────────────────────────────────────

/** Seed SPY with a prior+today price pair. Returns the SPY security ID. */
function seedSpy(priorClose: number, todayClose: number): number {
  const spyId = seedSecurity("SPY", "SPDR S&P 500 ETF");
  seedPrice(spyId, "2026-05-07", priorClose);
  seedPrice(spyId, "2026-05-08", todayClose);
  return spyId;
}

// ─── computeAnomalies tests ────────────────────────────────────────────────────

describe("computeAnomalies", () => {
  it("returns [] when SPY has fewer than 2 prices", () => {
    const spyId = seedSecurity("SPY", "SPDR S&P 500 ETF");
    seedPrice(spyId, "2026-05-08", 530);

    const acctId = seedAccount("Vanguard Taxable");
    const googId = seedSecurity("GOOG");
    seedHolding(acctId, googId);
    seedPrice(googId, "2026-05-07", 170);
    seedPrice(googId, "2026-05-08", 164.22); // -3.4%
    seedBeta(googId, 1.6);

    expect(computeAnomalies(db)).toEqual([]);
  });

  it("does NOT flag an ordinary 1% wiggle on a flat market day", () => {
    seedSpy(530, 530 * 1.001); // SPY +0.1% (flat)
    const acctId = seedAccount("Vanguard Brokerage");

    const id = seedSecurity("ACME");
    seedHolding(acctId, id);
    seedPrice(id, "2026-05-07", 100);
    seedPrice(id, "2026-05-08", 101.0); // +1.0%
    seedBeta(id, 1.2, 1.5);

    expect(computeAnomalies(db).map((f) => f.symbol)).not.toContain("ACME");
  });

  it("flags a quiet fund that jumps 3% on a flat day (large z for a low-vol name)", () => {
    seedSpy(530, 530 * 1.001);
    const acctId = seedAccount("Vanguard Brokerage");

    const id = seedSecurity("QFND");
    seedHolding(acctId, id);
    seedPrice(id, "2026-05-07", 100);
    seedPrice(id, "2026-05-08", 103.2); // +3.2%
    seedBeta(id, 0.3, 0.5);

    expect(computeAnomalies(db).map((f) => f.symbol)).toContain("QFND");
  });

  it("does NOT flag a volatile name moving 3% (within its own normal noise)", () => {
    seedSpy(530, 530 * 1.001);
    const acctId = seedAccount("Vanguard Brokerage");

    const id = seedSecurity("VOLA");
    seedHolding(acctId, id);
    seedPrice(id, "2026-05-07", 100);
    seedPrice(id, "2026-05-08", 103.1); // +3.1%
    seedBeta(id, 1.5, 2.5);

    expect(computeAnomalies(db).map((f) => f.symbol)).not.toContain("VOLA");
  });

  it("degraded mode: with null residual_std, enforces only the 3% floor", () => {
    seedSpy(530, 530 * 1.001);
    const acctId = seedAccount("Vanguard Brokerage");

    const big = seedSecurity("BIG");
    seedHolding(acctId, big);
    seedPrice(big, "2026-05-07", 100);
    seedPrice(big, "2026-05-08", 103.5); // +3.5%
    seedBeta(big, 1.0); // residualStd omitted → NULL

    const small = seedSecurity("SML");
    seedHolding(acctId, small);
    seedPrice(small, "2026-05-07", 100);
    seedPrice(small, "2026-05-08", 102.0); // +2.0%
    seedBeta(small, 1.0); // residualStd omitted → NULL

    const symbols = computeAnomalies(db).map((f) => f.symbol);
    expect(symbols).toContain("BIG");
    expect(symbols).not.toContain("SML");
  });

  it("exposes zScore and sorts by it descending", () => {
    seedSpy(530, 530 * 1.001);
    const acctId = seedAccount("Vanguard Brokerage");

    const hi = seedSecurity("HIGHZ");
    seedHolding(acctId, hi);
    seedPrice(hi, "2026-05-07", 100);
    seedPrice(hi, "2026-05-08", 104.0);
    seedBeta(hi, 0.5, 0.5);

    const lo = seedSecurity("LOWZ");
    seedHolding(acctId, lo);
    seedPrice(lo, "2026-05-07", 100);
    seedPrice(lo, "2026-05-08", 103.1);
    seedBeta(lo, 0.5, 1.2);

    const flags = computeAnomalies(db);
    expect(flags[0].symbol).toBe("HIGHZ");
    expect(flags[0].zScore).not.toBeNull();
    expect(flags[0].zScore! > flags[1].zScore!).toBe(true);
  });

  it("skips BRK.B when no cached beta exists", () => {
    seedSpy(530, 530 * 1.0075);
    const acctId = seedAccount("Vanguard Taxable");

    // BRK.B moves 5% but has no beta in the cache → should not appear
    const brkId = seedSecurity("BRK.B");
    seedHolding(acctId, brkId);
    seedPrice(brkId, "2026-05-07", 400);
    seedPrice(brkId, "2026-05-08", 420); // +5%
    // NO seedBeta call

    const flags = computeAnomalies(db);
    expect(flags.map((f) => f.symbol)).not.toContain("BRK.B");
  });

  it("sorts by z-score desc — HIGHZ (low residualStd) ranks above TER (higher residualStd)", () => {
    // SPY +0.75% — both names clear the 3% floor, but HIGHZ has a much larger z
    seedSpy(530, 530 * 1.0075);
    const acctId = seedAccount("Vanguard Brokerage");

    // GOOG: -3.4%, beta 1.6, residualStd 0.5 → z = |(-3.4 - 1.2)| / 0.5 = 11.2
    const googId = seedSecurity("GOOG");
    seedHolding(acctId, googId);
    seedPrice(googId, "2026-05-07", 170);
    seedPrice(googId, "2026-05-08", 170 * 0.966); // -3.4%
    seedBeta(googId, 1.6, 0.5); // tight residual → high z

    // TER: +5.1%, beta 2.0, residualStd 2.0 → z = |(5.1 - 1.5)| / 2.0 = 1.8 ... below 2.0
    // Use residualStd 1.0 so z = |(5.1 - 1.5)| / 1.0 = 3.6 — still flags, but lower z than GOOG
    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1); // +5.1%
    seedBeta(terId, 2.0, 1.0);

    const flags = computeAnomalies(db);
    expect(flags.length).toBeGreaterThanOrEqual(2);
    expect(flags[0].symbol).toBe("GOOG"); // higher z first (z ≈ 11.2 vs 3.6)
    expect(flags[1].symbol).toBe("TER");
  });

  it("applies 3% absolute floor: a stock with +0.5% move is NOT flagged regardless of beta", () => {
    // SPY +0.1%
    seedSpy(530, 530 * 1.001);
    const acctId = seedAccount("Vanguard Brokerage");

    // AAPL: +0.5% — well below 3% floor → NOT flagged
    const aaplId = seedSecurity("AAPL");
    seedHolding(acctId, aaplId);
    seedPrice(aaplId, "2026-05-07", 200);
    seedPrice(aaplId, "2026-05-08", 201); // +0.5%
    seedBeta(aaplId, 1.0, 0.5);

    const flags = computeAnomalies(db);
    expect(flags.map((f) => f.symbol)).not.toContain("AAPL");
  });

  it("sets directionFlipped=true when actual and expected have opposite signs AND |expected| > 0.1%", () => {
    // SPY +0.75%
    seedSpy(530, 530 * 1.0075);
    const acctId = seedAccount("Vanguard Brokerage");

    // MSFT: -4.0%, beta 1.2 → expectedPct = +0.9% → flipped; -4% clears 3% floor
    // residualStd 0.8 → z = |(-4.0 - 0.9)| / 0.8 = 6.125 → flags
    const msftId = seedSecurity("MSFT");
    seedHolding(acctId, msftId);
    seedPrice(msftId, "2026-05-07", 400);
    seedPrice(msftId, "2026-05-08", 384); // -4.0%
    seedBeta(msftId, 1.2, 0.8);

    const flags = computeAnomalies(db);
    const msftFlag = flags.find((f) => f.symbol === "MSFT");
    expect(msftFlag).toBeDefined();
    expect(msftFlag!.directionFlipped).toBe(true);
  });

  it("does NOT set directionFlipped when |expectedPct| <= 0.1% (near-zero expected)", () => {
    // SPY +0.05% (tiny move)
    seedSpy(530, 530 * 1.0005);
    const acctId = seedAccount("Vanguard Brokerage");

    // AMZN: -3.5%, beta 1.0 → expectedPct = 0.05% (very small) → flipped should be false
    // residualStd 0.8 → z = |(-3.5 - 0.05)| / 0.8 = 4.44 → flags
    const amznId = seedSecurity("AMZN");
    seedHolding(acctId, amznId);
    seedPrice(amznId, "2026-05-07", 200);
    seedPrice(amznId, "2026-05-08", 193); // -3.5%
    seedBeta(amznId, 1.0, 0.8);

    const flags = computeAnomalies(db);
    const amznFlag = flags.find((f) => f.symbol === "AMZN");
    expect(amznFlag).toBeDefined();
    expect(amznFlag!.directionFlipped).toBe(false);
  });

  it("excludes non-Vanguard accounts and Roth accounts", () => {
    seedSpy(530, 530 * 1.0075);

    // Roth account — should be excluded
    const rothId = seedAccount("Vanguard Roth IRA");
    const googId = seedSecurity("GOOG");
    seedHolding(rothId, googId);
    seedPrice(googId, "2026-05-07", 170);
    seedPrice(googId, "2026-05-08", 170 * 0.966); // -3.4%
    seedBeta(googId, 1.6, 0.5);

    // IBKR account — should be excluded
    const ibkrId = seedAccount("IBKR Pro");
    const aaaplId = seedSecurity("AAPL");
    seedHolding(ibkrId, aaaplId);
    seedPrice(aaaplId, "2026-05-07", 200);
    seedPrice(aaaplId, "2026-05-08", 200 * 0.96); // -4%
    seedBeta(aaaplId, 1.2, 0.8);

    const flags = computeAnomalies(db);
    expect(flags).toHaveLength(0);
  });

  it("computes correct spyPct, actualPct, expectedPct, residualPct, zScore on a known scenario", () => {
    // SPY: prior=400, today=397 → spyPct = (397-400)/400 * 100 = -0.75%
    seedSpy(400, 397);
    const acctId = seedAccount("Vanguard Taxable");

    // GOOG: prior=100, today=96.6 → actualPct = -3.4%
    // beta=1.6, expectedPct = -0.75 * 1.6 = -1.2%
    // residualPct = -3.4 - (-1.2) = -2.2%
    // residualStd=0.5 → zScore = |-2.2| / 0.5 = 4.4
    const googId = seedSecurity("GOOG");
    seedHolding(acctId, googId);
    seedPrice(googId, "2026-05-07", 100);
    seedPrice(googId, "2026-05-08", 96.6); // -3.4%
    seedBeta(googId, 1.6, 0.5);

    const flags = computeAnomalies(db);
    const goog = flags.find((f) => f.symbol === "GOOG");
    expect(goog).toBeDefined();

    expect(goog!.spyPct).toBeCloseTo(-0.75, 4);
    expect(goog!.actualPct).toBeCloseTo(-3.4, 4);
    expect(goog!.beta).toBeCloseTo(1.6, 4);
    expect(goog!.expectedPct).toBeCloseTo(-1.2, 4);
    expect(goog!.residualPct).toBeCloseTo(-2.2, 4);
    expect(goog!.zScore).toBeCloseTo(4.4, 2);
    expect(goog!.directionFlipped).toBe(false); // both negative, same direction
  });

  // ─── Trading-day pinning guards (2026-05-31 fix) ────────────────────────────

  it("ignores a weekend-stamped phantom price row and uses the latest TRADING day", () => {
    // SPY real pair 5/07 (Thu) → 5/08 (Fri), +0.75%. Plus a phantom Sunday 5/10
    // row (a TWS snapshot written by a closed-market sync). It must be ignored.
    const spyId = seedSecurity("SPY", "SPDR S&P 500 ETF");
    seedPrice(spyId, "2026-05-07", 530);
    seedPrice(spyId, "2026-05-08", 530 * 1.0075);
    seedPrice(spyId, "2026-05-10", 999); // phantom Sunday — must be ignored
    const acctId = seedAccount("Vanguard Brokerage");

    const googId = seedSecurity("GOOG");
    seedHolding(acctId, googId);
    seedPrice(googId, "2026-05-07", 170);
    seedPrice(googId, "2026-05-08", 170 * (1 - 0.034)); // real -3.4%
    seedPrice(googId, "2026-05-10", 100); // phantom Sunday — must NOT be used
    seedBeta(googId, 1.6, 0.5); // residualStd so z-gate passes

    const goog = computeAnomalies(db).find((f) => f.symbol === "GOOG");
    expect(goog).toBeDefined();
    // Move reflects 5/07→5/08 (-3.4%), NOT anything involving the 5/10 phantom.
    expect(goog!.actualPct).toBeCloseTo(-3.4, 4);
  });

  it("skips a security with no price on the latest trading day (stale fund)", () => {
    seedSpy(530, 530 * 1.0075); // 5/07 → 5/08
    const acctId = seedAccount("Vanguard Brokerage");

    // FRESH name on the pinned pair → flagged (3% floor + z-gate pass with residualStd=0.5).
    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1); // +5.1%
    seedBeta(terId, 2.0, 0.5); // residualStd provided so z-gate applies

    // STALE name: latest close is weeks old, no 5/08 close → must be omitted,
    // not reported as a +30% "today" move.
    const vmfId = seedSecurity("VMFXX");
    seedHolding(acctId, vmfId);
    seedPrice(vmfId, "2026-04-29", 100);
    seedPrice(vmfId, "2026-04-30", 130);
    seedBeta(vmfId, 1.0, 0.5);

    const symbols = computeAnomalies(db).map((f) => f.symbol);
    expect(symbols).toContain("TER");
    expect(symbols).not.toContain("VMFXX");
  });

  it("returns [] when SPY's two most recent trading days are not consecutive (gap)", () => {
    // SPY has 5/06 (Wed) and 5/08 (Fri) but is MISSING 5/07 (Thu) — a gap. We
    // must not report a 2-day move as "today".
    const spyId = seedSecurity("SPY", "SPDR S&P 500 ETF");
    seedPrice(spyId, "2026-05-06", 525);
    seedPrice(spyId, "2026-05-08", 535);
    const acctId = seedAccount("Vanguard Brokerage");

    const googId = seedSecurity("GOOG");
    seedHolding(acctId, googId);
    seedPrice(googId, "2026-05-06", 170);
    seedPrice(googId, "2026-05-08", 150);
    seedBeta(googId, 1.6, 0.5);

    expect(computeAnomalies(db)).toEqual([]);
  });
});

// ─── formatVanguardAnomaliesBlock tests ───────────────────────────────────────

describe("formatVanguardAnomaliesBlock", () => {
  it("returns empty string when no anomalies", () => {
    // No SPY → computeAnomalies returns []
    expect(formatVanguardAnomaliesBlock(db)).toBe("");
  });

  it("returns empty string when all securities are within the 3% floor", () => {
    seedSpy(530, 530 * 1.001); // SPY +0.1%
    const acctId = seedAccount("Vanguard Brokerage");

    // AAPL +0.3% — well below 3% floor → NOT flagged
    const aaplId = seedSecurity("AAPL");
    seedHolding(acctId, aaplId);
    seedPrice(aaplId, "2026-05-07", 200);
    seedPrice(aaplId, "2026-05-08", 200.6);
    seedBeta(aaplId, 1.0, 0.5);

    expect(formatVanguardAnomaliesBlock(db)).toBe("");
  });

  it("formats a single anomaly with correct structure and signed percentages", () => {
    // SPY -0.75%
    seedSpy(400, 397);
    const acctId = seedAccount("Vanguard Taxable");

    // GOOG: -3.4%, beta 1.6, residualStd 0.5
    // expectedPct = -1.2%, residualPct = -2.2, z = 4.4
    const googId = seedSecurity("GOOG");
    seedHolding(acctId, googId);
    seedPrice(googId, "2026-05-07", 100);
    seedPrice(googId, "2026-05-08", 96.6);
    seedBeta(googId, 1.6, 0.5);

    const md = formatVanguardAnomaliesBlock(db);
    expect(md).toContain("## Significant Moves in Vanguard Holdings (vs. expected)");
    expect(md).toContain("**GOOG**");
    expect(md).toContain("-3.4%");
    // SPY was -0.75%, rounds to -0.8% at 1 decimal — check for the negative sign
    expect(md).toMatch(/SPY -0\.\d+%/);
    // z-score line (e.g. "4.4σ move.")
    expect(md).toMatch(/\d+\.\d+σ move\./);
  });

  it("uses + sign for positive percentages", () => {
    // SPY +1.0% (clean round number — 530 → 535.3)
    seedSpy(530, 535.3); // (535.3 - 530) / 530 * 100 = 1.0%
    const acctId = seedAccount("Vanguard Brokerage");

    // TER: +5.1%, beta 2.0, residualStd 0.5
    // expectedPct = 1.0 * 2.0 = 2.0%, residualPct = 3.1, z = 3.1/0.5 = 6.2 → flags
    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1); // +5.1%
    seedBeta(terId, 2.0, 0.5);

    const md = formatVanguardAnomaliesBlock(db);
    // Positive actual — explicit + sign
    expect(md).toMatch(/\+5\.\d+%/);
    // Positive expected — explicit + sign
    expect(md).toMatch(/expected \+\d+\.\d+%/);
    // SPY positive — explicit + sign
    expect(md).toMatch(/SPY \+1\.\d+%/);
  });

  it("renders 'Direction flipped.' when directionFlipped is true", () => {
    // SPY +0.75%
    seedSpy(530, 530 * 1.0075);
    const acctId = seedAccount("Vanguard Brokerage");

    // MSFT: -4.0%, beta 1.2 → flipped (expected positive, actual negative)
    // residualStd 0.8 → z = |(-4.0 - 0.9)| / 0.8 = 6.125 → flags
    const msftId = seedSecurity("MSFT");
    seedHolding(acctId, msftId);
    seedPrice(msftId, "2026-05-07", 400);
    seedPrice(msftId, "2026-05-08", 384); // -4.0%
    seedBeta(msftId, 1.2, 0.8);

    const md = formatVanguardAnomaliesBlock(db);
    expect(md).toContain("Direction flipped.");
  });

  it("shows all flagged securities (no cap)", () => {
    // SPY -0.1% (tiny) — 8 securities each moving -5% with residualStd 0.5
    // All clear 3% floor; z = |(−5 − (−0.1)) | / 0.5 = 9.8 → all flag
    seedSpy(530, 530 * 0.999);
    const acctId = seedAccount("Vanguard Brokerage");

    const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"];
    for (let i = 0; i < symbols.length; i++) {
      const secId = seedSecurity(symbols[i]);
      seedHolding(acctId, secId);
      const move = 1 - (0.05 + i * 0.001); // -5.0%, -5.1%, ... -5.7%
      seedPrice(secId, "2026-05-07", 100);
      seedPrice(secId, "2026-05-08", 100 * move);
      seedBeta(secId, 1.0, 0.5);
    }

    const md = formatVanguardAnomaliesBlock(db);

    // ALL 8 should appear — no cap in the new implementation
    const bulletCount = (md.match(/^- \*\*/gm) ?? []).length;
    expect(bulletCount).toBe(8);

    // No "N more flagged" footer
    expect(md).not.toContain("more flagged");
  });

  it("degraded mode: null residual_std renders the signed-actual fallback reason", () => {
    seedSpy(530, 530 * 0.999); // SPY -0.1%
    const acctId = seedAccount("Vanguard Brokerage");

    const secId = seedSecurity("NODV");
    seedHolding(acctId, secId);
    seedPrice(secId, "2026-05-07", 100);
    seedPrice(secId, "2026-05-08", 96.5); // -3.5%
    seedBeta(secId, 1.0); // residualStd omitted → NULL

    const md = formatVanguardAnomaliesBlock(db);
    expect(md).toContain("**NODV**");
    // In degraded mode the reason is the signed actual, e.g. "-3.5% move."
    expect(md).toMatch(/-3\.5% move\./);
  });

  it("does NOT contain dollar amounts", () => {
    seedSpy(530, 530 * 1.0075);
    const acctId = seedAccount("Vanguard Brokerage");

    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1);
    seedBeta(terId, 2.0, 0.5);

    const md = formatVanguardAnomaliesBlock(db);
    expect(/\$\d/.test(md)).toBe(false);
  });

  it("does NOT contain share counts", () => {
    seedSpy(530, 530 * 1.0075);
    const acctId = seedAccount("Vanguard Brokerage");

    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1);
    seedBeta(terId, 2.0, 0.5);

    const md = formatVanguardAnomaliesBlock(db);
    expect(/\d+ shares/.test(md)).toBe(false);
  });

  it("does NOT contain portfolio percentage language", () => {
    seedSpy(530, 530 * 1.0075);
    const acctId = seedAccount("Vanguard Brokerage");

    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1);
    seedBeta(terId, 2.0, 0.5);

    const md = formatVanguardAnomaliesBlock(db);
    expect(/% of (?:portfolio|account)/i.test(md)).toBe(false);
  });

  it("ends with a trailing newline", () => {
    seedSpy(530, 530 * 1.0075);
    const acctId = seedAccount("Vanguard Brokerage");

    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1);
    seedBeta(terId, 2.0, 0.5);

    const md = formatVanguardAnomaliesBlock(db);
    expect(md.endsWith("\n")).toBe(true);
  });
});
