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

function seedBeta(securityId: number, beta: number): void {
  upsertBeta(db, { securityId, lookbackDays: 60, beta });
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

  it("flags GOOG (-3.4%) and TER (+5.1%) but NOT NVDA (+1.0%) against SPY +0.75%", () => {
    // SPY: +0.75%
    seedSpy(530, 530 * 1.0075); // prior=530, today=533.975
    const acctId = seedAccount("Vanguard Brokerage");

    // GOOG: -3.4%, beta 1.6 → expectedPct = 0.75 * 1.6 = 1.2%, threshold = max(2.4%, 1%) = 2.4%
    // |actualPct| = 3.4% > 2.4% ✓ flagged
    const googId = seedSecurity("GOOG");
    seedHolding(acctId, googId);
    seedPrice(googId, "2026-05-07", 170);
    seedPrice(googId, "2026-05-08", 170 * (1 - 0.034)); // -3.4%
    seedBeta(googId, 1.6);

    // TER: +5.1%, beta 2.0 → expectedPct = 0.75 * 2.0 = 1.5%, threshold = max(3.0%, 1%) = 3.0%
    // |actualPct| = 5.1% > 3.0% ✓ flagged
    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1); // +5.1%
    seedBeta(terId, 2.0);

    // NVDA: +1.0%, beta 1.1 → expectedPct = 0.75 * 1.1 = 0.825%, threshold = max(1.65%, 1%) = 1.65%
    // |actualPct| = 1.0% < 1.65% ✗ NOT flagged
    const nvdaId = seedSecurity("NVDA");
    seedHolding(acctId, nvdaId);
    seedPrice(nvdaId, "2026-05-07", 100);
    seedPrice(nvdaId, "2026-05-08", 101.0); // +1.0%
    seedBeta(nvdaId, 1.1);

    const flags = computeAnomalies(db);

    const symbols = flags.map((f) => f.symbol);
    expect(symbols).toContain("GOOG");
    expect(symbols).toContain("TER");
    expect(symbols).not.toContain("NVDA");
    expect(symbols).not.toContain("SPY");

    // securityId is exposed so the Today-tab SignificantMovesCard can link each
    // flag to its Security Detail page via <SymbolLink>.
    const goog = flags.find((f) => f.symbol === "GOOG");
    expect(goog?.securityId).toBe(googId);
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

  it("sorts by ratio desc — TER (higher ratio) comes before GOOG", () => {
    // SPY +0.75%
    seedSpy(530, 530 * 1.0075);
    const acctId = seedAccount("Vanguard Brokerage");

    // GOOG: -3.4%, beta 1.6 → threshold = max(2*1.2%, 1%) = 2.4% → ratio = 3.4/2.4 ≈ 1.417
    const googId = seedSecurity("GOOG");
    seedHolding(acctId, googId);
    seedPrice(googId, "2026-05-07", 170);
    seedPrice(googId, "2026-05-08", 170 * 0.966); // -3.4%
    seedBeta(googId, 1.6);

    // TER: +5.1%, beta 2.0 → threshold = max(2*1.5%, 1%) = 3.0% → ratio = 5.1/3.0 = 1.7
    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1); // +5.1%
    seedBeta(terId, 2.0);

    const flags = computeAnomalies(db);
    expect(flags.length).toBeGreaterThanOrEqual(2);
    expect(flags[0].symbol).toBe("TER"); // higher ratio first
    expect(flags[1].symbol).toBe("GOOG");
  });

  it("applies 1% absolute floor: flat market (SPY +0.1%), beta-1 stock +0.5% is NOT flagged", () => {
    // SPY +0.1%
    seedSpy(530, 530 * 1.001);
    const acctId = seedAccount("Vanguard Brokerage");

    // AAPL: +0.5%, beta 1.0 → expectedPct = 0.1 * 1.0 = 0.1%
    // threshold = max(2 * 0.1%, 1%) = max(0.2%, 1%) = 1.0%
    // |actualPct| = 0.5% < 1.0% ✗ NOT flagged
    const aaplId = seedSecurity("AAPL");
    seedHolding(acctId, aaplId);
    seedPrice(aaplId, "2026-05-07", 200);
    seedPrice(aaplId, "2026-05-08", 201); // +0.5%
    seedBeta(aaplId, 1.0);

    const flags = computeAnomalies(db);
    expect(flags.map((f) => f.symbol)).not.toContain("AAPL");
  });

  it("sets directionFlipped=true when actual and expected have opposite signs AND |expected| > 0.1%", () => {
    // SPY +0.75%
    seedSpy(530, 530 * 1.0075);
    const acctId = seedAccount("Vanguard Brokerage");

    // MSFT: -2.0%, beta 1.2 → expectedPct = +0.9%, threshold = max(1.8%, 1%) = 1.8%
    // |actual| = 2.0% > 1.8% ✓ flagged; actual is negative but expected is positive → flipped
    const msftId = seedSecurity("MSFT");
    seedHolding(acctId, msftId);
    seedPrice(msftId, "2026-05-07", 400);
    seedPrice(msftId, "2026-05-08", 392); // -2.0%
    seedBeta(msftId, 1.2);

    const flags = computeAnomalies(db);
    const msftFlag = flags.find((f) => f.symbol === "MSFT");
    expect(msftFlag).toBeDefined();
    expect(msftFlag!.directionFlipped).toBe(true);
  });

  it("does NOT set directionFlipped when |expectedPct| <= 0.1% (near-zero expected)", () => {
    // SPY +0.05% (tiny move)
    seedSpy(530, 530 * 1.0005);
    const acctId = seedAccount("Vanguard Brokerage");

    // AMZN: -1.5%, beta 1.0 → expectedPct = 0.05%, threshold = max(0.1%, 1%) = 1.0%
    // |actual| = 1.5% > 1.0% ✓ flagged; expected is +0.05% (very small) so flipped should be false
    const amznId = seedSecurity("AMZN");
    seedHolding(acctId, amznId);
    seedPrice(amznId, "2026-05-07", 200);
    seedPrice(amznId, "2026-05-08", 197); // -1.5%
    seedBeta(amznId, 1.0);

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
    seedBeta(googId, 1.6);

    // IBKR account — should be excluded
    const ibkrId = seedAccount("IBKR Pro");
    const aaaplId = seedSecurity("AAPL");
    seedHolding(ibkrId, aaaplId);
    seedPrice(aaaplId, "2026-05-07", 200);
    seedPrice(aaaplId, "2026-05-08", 200 * 0.96); // -4%
    seedBeta(aaaplId, 1.2);

    const flags = computeAnomalies(db);
    expect(flags).toHaveLength(0);
  });

  it("computes correct spyPct, actualPct, expectedPct, thresholdPct, ratio on a known scenario", () => {
    // SPY: prior=400, today=397 → spyPct = (397-400)/400 * 100 = -0.75%
    seedSpy(400, 397);
    const acctId = seedAccount("Vanguard Taxable");

    // GOOG: prior=100, today=96.6 → actualPct = -3.4%
    // beta=1.6, expectedPct = -0.75 * 1.6 = -1.2%, threshold = max(2.4%, 1%) = 2.4%
    // ratio = 3.4 / 2.4 ≈ 1.4167
    const googId = seedSecurity("GOOG");
    seedHolding(acctId, googId);
    seedPrice(googId, "2026-05-07", 100);
    seedPrice(googId, "2026-05-08", 96.6); // -3.4%
    seedBeta(googId, 1.6);

    const flags = computeAnomalies(db);
    const goog = flags.find((f) => f.symbol === "GOOG");
    expect(goog).toBeDefined();

    expect(goog!.spyPct).toBeCloseTo(-0.75, 4);
    expect(goog!.actualPct).toBeCloseTo(-3.4, 4);
    expect(goog!.beta).toBeCloseTo(1.6, 4);
    expect(goog!.expectedPct).toBeCloseTo(-1.2, 4);
    expect(goog!.thresholdPct).toBeCloseTo(2.4, 4);
    expect(goog!.ratio).toBeCloseTo(3.4 / 2.4, 4);
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
    seedBeta(googId, 1.6);

    const goog = computeAnomalies(db).find((f) => f.symbol === "GOOG");
    expect(goog).toBeDefined();
    // Move reflects 5/07→5/08 (-3.4%), NOT anything involving the 5/10 phantom.
    expect(goog!.actualPct).toBeCloseTo(-3.4, 4);
  });

  it("skips a security with no price on the latest trading day (stale fund)", () => {
    seedSpy(530, 530 * 1.0075); // 5/07 → 5/08
    const acctId = seedAccount("Vanguard Brokerage");

    // FRESH name on the pinned pair → flagged.
    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1); // +5.1%
    seedBeta(terId, 2.0);

    // STALE name: latest close is weeks old, no 5/08 close → must be omitted,
    // not reported as a +30% "today" move.
    const vmfId = seedSecurity("VMFXX");
    seedHolding(acctId, vmfId);
    seedPrice(vmfId, "2026-04-29", 100);
    seedPrice(vmfId, "2026-04-30", 130);
    seedBeta(vmfId, 1.0);

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
    seedBeta(googId, 1.6);

    expect(computeAnomalies(db)).toEqual([]);
  });
});

// ─── formatVanguardAnomaliesBlock tests ───────────────────────────────────────

describe("formatVanguardAnomaliesBlock", () => {
  it("returns empty string when no anomalies", () => {
    // No SPY → computeAnomalies returns []
    expect(formatVanguardAnomaliesBlock(db)).toBe("");
  });

  it("returns empty string when all securities are within threshold", () => {
    seedSpy(530, 530 * 1.001); // SPY +0.1%
    const acctId = seedAccount("Vanguard Brokerage");

    // AAPL +0.3%, beta 1.0, threshold = max(0.2%, 1%) = 1.0% — NOT flagged
    const aaplId = seedSecurity("AAPL");
    seedHolding(acctId, aaplId);
    seedPrice(aaplId, "2026-05-07", 200);
    seedPrice(aaplId, "2026-05-08", 200.6);
    seedBeta(aaplId, 1.0);

    expect(formatVanguardAnomaliesBlock(db)).toBe("");
  });

  it("formats a single anomaly with correct structure and signed percentages", () => {
    // SPY -0.75%
    seedSpy(400, 397);
    const acctId = seedAccount("Vanguard Taxable");

    // GOOG: -3.4%, beta 1.6, expectedPct = -1.2%, threshold = 2.4%, ratio ≈ 1.42
    const googId = seedSecurity("GOOG");
    seedHolding(acctId, googId);
    seedPrice(googId, "2026-05-07", 100);
    seedPrice(googId, "2026-05-08", 96.6);
    seedBeta(googId, 1.6);

    const md = formatVanguardAnomaliesBlock(db);
    expect(md).toContain("## Significant Moves in Vanguard Holdings (vs. expected)");
    expect(md).toContain("**GOOG**");
    expect(md).toContain("-3.4%");
    // SPY was -0.75%, rounds to -0.8% at 1 decimal — check for the negative sign
    expect(md).toMatch(/SPY -0\.\d+%/);
    // ratio line
    expect(md).toMatch(/\d+\.\d+× expected/);
  });

  it("uses + sign for positive percentages", () => {
    // SPY +1.0% (clean round number — 530 → 535.3)
    seedSpy(530, 535.3); // (535.3 - 530) / 530 * 100 = 1.0%
    const acctId = seedAccount("Vanguard Brokerage");

    // TER: +5.1%, beta 2.0 → expectedPct = 1.0 * 2.0 = 2.0%, threshold = max(4.0%, 1%) = 4.0%
    // |actual| = 5.1% > 4.0% ✓ flagged
    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1); // +5.1%
    seedBeta(terId, 2.0);

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

    // MSFT: -2.0%, beta 1.2 → flipped (expected positive, actual negative)
    const msftId = seedSecurity("MSFT");
    seedHolding(acctId, msftId);
    seedPrice(msftId, "2026-05-07", 400);
    seedPrice(msftId, "2026-05-08", 392); // -2.0%
    seedBeta(msftId, 1.2);

    const md = formatVanguardAnomaliesBlock(db);
    expect(md).toContain("Direction flipped.");
  });

  it("caps at top 5 and appends '(N more flagged)' footer", () => {
    // SPY -0.1% (tiny, so 1% floor means almost anything flagged)
    seedSpy(530, 530 * 0.999);
    const acctId = seedAccount("Vanguard Brokerage");

    // Seed 8 securities each moving -5% with beta 1.0
    // threshold = max(2*0.1%, 1%) = 1.0%, |actual| = 5% >> 1% → all 8 flagged
    const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"];
    for (let i = 0; i < symbols.length; i++) {
      const secId = seedSecurity(symbols[i]);
      seedHolding(acctId, secId);
      // Vary moves slightly so sort order is deterministic
      const move = 1 - (0.05 + i * 0.001); // -5.0%, -5.1%, ... -5.7%
      seedPrice(secId, "2026-05-07", 100);
      seedPrice(secId, "2026-05-08", 100 * move);
      seedBeta(secId, 1.0);
    }

    const md = formatVanguardAnomaliesBlock(db);

    // Count bullet lines
    const bulletCount = (md.match(/^- \*\*/gm) ?? []).length;
    expect(bulletCount).toBe(5);

    // "3 more flagged" footer
    expect(md).toContain("(3 more flagged");
  });

  it("does NOT contain dollar amounts", () => {
    seedSpy(530, 530 * 1.0075);
    const acctId = seedAccount("Vanguard Brokerage");

    const terId = seedSecurity("TER");
    seedHolding(acctId, terId);
    seedPrice(terId, "2026-05-07", 100);
    seedPrice(terId, "2026-05-08", 105.1);
    seedBeta(terId, 2.0);

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
    seedBeta(terId, 2.0);

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
    seedBeta(terId, 2.0);

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
    seedBeta(terId, 2.0);

    const md = formatVanguardAnomaliesBlock(db);
    expect(md.endsWith("\n")).toBe(true);
  });
});
