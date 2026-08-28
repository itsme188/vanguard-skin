import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { refreshVanguardBetas } from "@/scripts/refresh-vanguard-betas";
import { getCachedBeta } from "@/lib/queries/security-betas";
import { upsertBeta } from "@/lib/mutations/security-betas";
import * as securityBetaMutations from "@/lib/mutations/security-betas";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // runMigrations seeds accounts: 'Vanguard Taxable', 'Vanguard Roth IRA', 'IBKR'
  runMigrations(db);
  return db;
}

function getAccountId(db: Database.Database, name: string): number {
  return (
    db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }
  ).id;
}

/**
 * Generate synthetic prices that produce a non-trivial, deterministic beta.
 * Pattern: price[i] = base + i * trend + sin(i) * amplitude
 */
function seedPrices(
  db: Database.Database,
  securityId: number,
  days: number,
  base: number = 100,
  trend: number = 0.1,
  amplitude: number = 5
): void {
  const startDate = new Date("2025-01-01");
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const price = base + i * trend + Math.sin(i) * amplitude;
    db.prepare(
      "INSERT OR IGNORE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')"
    ).run(securityId, dateStr, price);
  }
}

/** Same shape as seedPrices but starting from an arbitrary date. */
function seedPricesFrom(
  db: Database.Database,
  securityId: number,
  startDate: string,
  days: number,
  base: number = 100,
  trend: number = 0.1,
  amplitude: number = 5
): void {
  const start = new Date(startDate + "T12:00:00Z");
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const dateStr = d.toISOString().slice(0, 10);
    db.prepare(
      "INSERT OR IGNORE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')"
    ).run(securityId, dateStr, base + i * trend + Math.sin(i) * amplitude);
  }
}

/**
 * Prices driven by a deterministic pseudo-random walk that is INDEPENDENT of
 * the sin() series `seedPrices` uses — i.e. a security whose 60-day regression
 * against the benchmark has essentially zero explanatory power.
 */
function seedIndependentPrices(
  db: Database.Database,
  securityId: number,
  days: number,
  base: number = 100
): void {
  const startDate = new Date("2025-01-01T12:00:00Z");
  let price = base;
  for (let i = 0; i < days; i++) {
    const x = Math.sin((i + 1) * 12.9898 + 78.233) * 43758.5453;
    const shock = 2 * (x - Math.floor(x)) - 1; // deterministic, in [-1, 1)
    price *= Math.exp(0.02 * shock);
    const d = new Date(startDate.getTime() + i * 86_400_000);
    db.prepare(
      "INSERT OR IGNORE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')"
    ).run(securityId, d.toISOString().slice(0, 10), price);
  }
}

describe("refreshVanguardBetas", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Migration 002 seeds: 'Vanguard Taxable', 'Vanguard Roth IRA', 'IBKR'
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes betas for held Vanguard securities with sufficient history", async () => {
    // Use the pre-seeded 'Vanguard Taxable' account (migration 002)
    const acctId = getAccountId(db, "Vanguard Taxable");

    // Insert VTI security and SPY (benchmark)
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('VTI', 'Vanguard Total Market ETF', 'ETF')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();

    const vtiId = (db.prepare("SELECT id FROM securities WHERE symbol = 'VTI'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    // Hold VTI in the Vanguard Taxable account
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 100)"
    ).run(acctId, vtiId, today);

    // 65 days of prices for both (65 days → 64 return pairs, well above the 30 minimum)
    seedPrices(db, vtiId, 65, 200, 0.15, 8); // VTI: correlated with SPY but with noise
    seedPrices(db, spyId, 65, 400, 0.1, 5);  // SPY: benchmark

    const result = await refreshVanguardBetas(db);

    expect(result.computed).toBe(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    const beta = getCachedBeta(db, vtiId, 60);
    expect(beta).not.toBeNull();
    expect(beta).toBeGreaterThan(0);
  });

  it("ignores a return pair spanning a multi-month price gap (statement anchor → live data)", async () => {
    // Reproduces the NFLX β=−14 bug: the prices table mixes an old month-end
    // statement anchor (2025-06-30) with a dense daily TWS block (2026-04-01+),
    // separated by a ~9-month hole. The anchor→dense-block step is NOT a real
    // daily return — for a split it's even a huge negative one. Without a
    // trading-day-gap guard, that single pair dominates the regression and
    // pushes beta wildly off (here, strongly negative).
    const acctId = getAccountId(db, "Vanguard Taxable");
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('GAPco', 'Gap Co', 'Stock')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();
    const gapId = (db.prepare("SELECT id FROM securities WHERE symbol = 'GAPco'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 100)"
    ).run(acctId, gapId, today);

    const px = db.prepare(
      "INSERT OR IGNORE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, ?)"
    );
    // Old statement anchors (a 9-month gap before the dense block). GAPco anchor
    // is HIGHER than the dense block (a split-style drop → negative gap return);
    // SPY anchor is LOWER (a positive gap return) → opposite signs → β goes negative.
    px.run(gapId, "2025-06-30", 800, "canonical");
    px.run(spyId, "2025-06-30", 350, "canonical");
    // Dense daily block: GAPco tracks SPY 1:1 → the TRUE beta over real days is ~1.
    const start = new Date("2026-04-01");
    for (let i = 0; i < 40; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const p = 400 + i + Math.sin(i) * 3; // shared series → beta ≈ 1, var > 0
      px.run(gapId, ds, p, "tws");
      px.run(spyId, ds, p, "tws");
    }

    const result = await refreshVanguardBetas(db);
    expect(result.errors).toHaveLength(0);
    const beta = getCachedBeta(db, gapId, 60);
    expect(beta).not.toBeNull();
    // With the gap guard the regression uses only the dense block → β ≈ 1.
    // Without it, the gap pair drags β far negative (~−5). Assert the sane band.
    expect(beta!).toBeGreaterThan(0.5);
    expect(beta!).toBeLessThan(1.5);
  });

  it("skips securities with fewer than 30 days of price history", async () => {
    const acctId = getAccountId(db, "Vanguard Taxable");

    // NEW security — will only get 20 days of prices (below 30 minimum)
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('NEW', 'New Security', 'Stock')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();

    const newId = (db.prepare("SELECT id FROM securities WHERE symbol = 'NEW'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 50)"
    ).run(acctId, newId, today);

    // 65 days SPY but only 20 days for NEW — far below the 30 minimum
    seedPrices(db, spyId, 65, 400, 0.1, 5);
    seedPrices(db, newId, 20, 50, 0.05, 2);

    const result = await refreshVanguardBetas(db);

    expect(result.computed).toBe(0);
    expect(result.skipped).toContain("NEW");
    expect(result.errors).toHaveLength(0);

    const beta = getCachedBeta(db, newId, 60);
    expect(beta).toBeNull();
  });

  it("invalidates (deletes) a cached beta when the new regression has no explanatory power", async () => {
    // qa: today-significant-moves--negative-noise-betas-published-as-fact.
    // A 60-day window where the name moves independently of SPY produces a
    // beta whose SIGN is noise (the live DB had 21/68 negative, incl. XLV).
    // Publishing it mints false "direction flipped" badges — so the cached row
    // must be DELETED, which is exactly what consumers already read as
    // "no beta" (anomalies.ts LEFT JOIN → beta == null → skip).
    const acctId = getAccountId(db, "Vanguard Taxable");
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('NOISY', 'Noisy Co', 'Stock')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();
    const noisyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'NOISY'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 100)"
    ).run(acctId, noisyId, today);

    seedPrices(db, spyId, 65, 400, 0.1, 5); // sin-driven benchmark
    seedIndependentPrices(db, noisyId, 65, 100); // independent of the benchmark

    // A previously cached (now unsupported) beta — the exact stale-row class.
    upsertBeta(db, { securityId: noisyId, lookbackDays: 60, beta: -0.83, residualStd: 2.1 });
    expect(getCachedBeta(db, noisyId, 60)).toBe(-0.83);

    const result = await refreshVanguardBetas(db);

    expect(result.errors).toHaveLength(0);
    expect(result.computed).toBe(0);
    expect(result.invalidated).toHaveLength(1);
    expect(result.invalidated[0].symbol).toBe("NOISY");
    expect(result.invalidated[0].reason).toBe("low_r2");
    expect(result.invalidated[0].rSquared).toBeLessThan(0.1);
    expect(result.invalidated[0].pairs).toBeGreaterThanOrEqual(30);
    // `invalidated` is counted separately from `skipped`.
    expect(result.skipped).not.toContain("NOISY");
    // The stale row is GONE — a missing row is what consumers treat as "no beta".
    expect(getCachedBeta(db, noisyId, 60)).toBeNull();
  });

  it("invalidates a stale cached beta when too few dates align with SPY", async () => {
    // The live XOM case: the nightly run SKIPPED it (24 aligned pairs < 30) but
    // its 7-day-old β=−0.68 row kept publishing. Too few pairs must delete.
    const acctId = getAccountId(db, "Vanguard Taxable");
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('THIN', 'Thin Co', 'Stock')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();
    const thinId = (db.prepare("SELECT id FROM securities WHERE symbol = 'THIN'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 100)"
    ).run(acctId, thinId, today);

    // SPY: 2025-01-01 .. 2025-03-06. THIN has 40 rows (clears the raw-row floor)
    // but only the first 20 dates overlap SPY → 19 aligned pairs.
    seedPrices(db, spyId, 65, 400, 0.1, 5);
    seedPrices(db, thinId, 20, 100, 0.1, 4);
    seedPricesFrom(db, thinId, "2025-06-01", 20, 100, 0.1, 4);

    upsertBeta(db, { securityId: thinId, lookbackDays: 60, beta: -0.68, residualStd: 1.7 });

    const result = await refreshVanguardBetas(db);

    expect(result.errors).toHaveLength(0);
    expect(result.computed).toBe(0);
    expect(result.invalidated).toHaveLength(1);
    expect(result.invalidated[0].symbol).toBe("THIN");
    expect(result.invalidated[0].reason).toBe("few_pairs");
    expect(result.invalidated[0].pairs).toBeLessThan(30);
    expect(getCachedBeta(db, thinId, 60)).toBeNull();
  });

  it("deletes a stale cached beta when the security no longer has enough price history", async () => {
    const acctId = getAccountId(db, "Vanguard Taxable");
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SHORT', 'Short Co', 'Stock')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();
    const shortId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SHORT'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 10)"
    ).run(acctId, shortId, today);

    seedPrices(db, spyId, 65, 400, 0.1, 5);
    seedPrices(db, shortId, 20, 50, 0.05, 2); // below the raw-row floor

    upsertBeta(db, { securityId: shortId, lookbackDays: 60, beta: 1.42 });

    const result = await refreshVanguardBetas(db);

    expect(result.skipped).toContain("SHORT");
    expect(result.computed).toBe(0);
    // No evidence left → the row must not keep publishing.
    expect(getCachedBeta(db, shortId, 60)).toBeNull();
  });

  it("keeps a high-r² beta and reports zero invalidations", async () => {
    const acctId = getAccountId(db, "Vanguard Taxable");
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('VTI', 'Vanguard Total Market ETF', 'ETF')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();
    const vtiId = (db.prepare("SELECT id FROM securities WHERE symbol = 'VTI'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 100)"
    ).run(acctId, vtiId, today);

    seedPrices(db, vtiId, 65, 200, 0.15, 8);
    seedPrices(db, spyId, 65, 400, 0.1, 5);

    const result = await refreshVanguardBetas(db);

    expect(result.computed).toBe(1);
    expect(result.invalidated).toHaveLength(0);
    expect(getCachedBeta(db, vtiId, 60)).not.toBeNull();
  });

  it("[atomic apply] rolls back ALL writes when a later security's write throws mid-transaction", async () => {
    // Reproduces the progressive-write bug: without a single wrapping
    // transaction, a crash on the SECOND security's write would leave the
    // FIRST security's write already committed while later stale rows stay
    // published. The fix computes every decision first, then applies them
    // all inside one better-sqlite3 transaction — so a failure anywhere in
    // the apply phase must roll back EVERYTHING, including writes for
    // securities decided earlier in this same run.
    const acctId = getAccountId(db, "Vanguard Taxable");
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('FIRSTCO', 'First Co', 'Stock')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SECONDCO', 'Second Co', 'Stock')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();
    const firstId = (db.prepare("SELECT id FROM securities WHERE symbol = 'FIRSTCO'").get() as { id: number }).id;
    const secondId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SECONDCO'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 100)"
    ).run(acctId, firstId, today);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 100)"
    ).run(acctId, secondId, today);

    // Both securities regress cleanly against SPY — both decide "upsert",
    // and `securities` is queried ORDER BY symbol, so FIRSTCO's write is
    // the 1st upsertBeta call and SECONDCO's is the 2nd.
    seedPrices(db, spyId, 65, 400, 0.1, 5);
    seedPrices(db, firstId, 65, 200, 0.15, 8);
    seedPrices(db, secondId, 65, 210, 0.12, 7);

    // Pre-existing stale row for FIRSTCO — must be untouched if the run
    // aborts, i.e. its write must NOT land even though it was decided (and
    // would normally be applied) before SECONDCO's failing write.
    upsertBeta(db, { securityId: firstId, lookbackDays: 60, beta: 0.05, residualStd: 9.9 });

    const originalUpsertBeta = securityBetaMutations.upsertBeta;
    let callCount = 0;
    vi.spyOn(securityBetaMutations, "upsertBeta").mockImplementation((database, input) => {
      callCount++;
      if (callCount === 2) {
        throw new Error("simulated crash mid-write");
      }
      return originalUpsertBeta(database, input);
    });

    await expect(refreshVanguardBetas(db)).rejects.toThrow("simulated crash mid-write");

    // FIRSTCO's stale pre-existing row is unchanged — the transaction that
    // would have overwritten it with the fresh regression never committed.
    expect(getCachedBeta(db, firstId, 60)).toBe(0.05);
  });

  it("skips IBKR and Roth holdings — only processes Vanguard Taxable", async () => {
    // Use pre-seeded 'IBKR' and 'Vanguard Roth IRA' accounts (migration 002)
    const ibkrId = getAccountId(db, "IBKR");
    const rothId = getAccountId(db, "Vanguard Roth IRA");

    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('TSLA', 'Tesla Inc', 'Stock')").run();
    db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SPY', 'SPDR S&P 500 ETF', 'ETF')").run();

    const tslaId = (db.prepare("SELECT id FROM securities WHERE symbol = 'TSLA'").get() as { id: number }).id;
    const spyId = (db.prepare("SELECT id FROM securities WHERE symbol = 'SPY'").get() as { id: number }).id;

    const today = new Date().toISOString().slice(0, 10);
    // TSLA held in both IBKR and Roth — neither is a Vanguard (non-Roth) account
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 10)"
    ).run(ibkrId, tslaId, today);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, as_of_date, quantity) VALUES (?, ?, ?, 5)"
    ).run(rothId, tslaId, today);

    // 65 days prices for both — sufficient history if the scope were wrong
    seedPrices(db, tslaId, 65, 250, 0.3, 12);
    seedPrices(db, spyId, 65, 400, 0.1, 5);

    const result = await refreshVanguardBetas(db);

    // No Vanguard (non-Roth) account holdings → nothing to process
    expect(result.computed).toBe(0);
    expect(result.errors).toHaveLength(0);

    const beta = getCachedBeta(db, tslaId, 60);
    expect(beta).toBeNull();
  });
});
