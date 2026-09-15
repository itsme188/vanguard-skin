import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildOCCSymbol } from "@/lib/import/occ-symbol";
import {
  callPrice,
  computePortfolioGreeks,
  isExpiredAsOf,
  putPrice,
  sameDayTheta,
  theta,
  yearsToExpiry,
} from "@/lib/compute/options-greeks";

// ─── Fixed calendar so tests never depend on the machine's clock/timezone ──
// 2026-09-14 is a Monday; EDT (UTC-4) is in effect in September.
const TODAY = "2026-09-14";
const YESTERDAY = "2026-09-13";
const TOMORROW = "2026-09-15";

// Build explicit ISO-with-offset instants — never rely on local time zone.
const AT_10_30_ET = new Date(`${TODAY}T10:30:00-04:00`);
const AT_16_00_ET = new Date(`${TODAY}T16:00:00-04:00`);
const AT_16_30_ET = new Date(`${TODAY}T16:30:00-04:00`);
const ONE_MIN_BEFORE_CLOSE_ET = new Date(`${TODAY}T15:59:00-04:00`);

// ─── Pure helpers ────────────────────────────────────────────────

describe("isExpiredAsOf", () => {
  it("is expired when expiration is before today, regardless of the clock", () => {
    expect(isExpiredAsOf(YESTERDAY, TODAY, AT_10_30_ET)).toBe(true);
    expect(isExpiredAsOf(YESTERDAY, TODAY, AT_16_30_ET)).toBe(true);
  });

  it("is NOT expired on expiry day mid-session (10:30 ET)", () => {
    expect(isExpiredAsOf(TODAY, TODAY, AT_10_30_ET)).toBe(false);
  });

  it("is expired on expiry day exactly at the 16:00 ET close", () => {
    expect(isExpiredAsOf(TODAY, TODAY, AT_16_00_ET)).toBe(true);
  });

  it("is expired on expiry day after the close (16:30 ET)", () => {
    expect(isExpiredAsOf(TODAY, TODAY, AT_16_30_ET)).toBe(true);
  });

  it("is NOT expired when expiration is tomorrow", () => {
    expect(isExpiredAsOf(TOMORROW, TODAY, AT_10_30_ET)).toBe(false);
  });
});

describe("yearsToExpiry", () => {
  it("on expiry day mid-session, is positive and less than one full day (1/365)", () => {
    const t = yearsToExpiry(TODAY, TODAY, AT_10_30_ET);
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThan(1 / 365);
  });

  it("for a same-day contract, is proportional to hours left until the 16:00 ET close", () => {
    // 5.5 hours remain at 10:30 ET.
    const t = yearsToExpiry(TODAY, TODAY, AT_10_30_ET);
    expect(t).toBeCloseTo(5.5 / (365 * 24), 8);
  });

  it("floors same-day time-to-expiry at the fifteen-minute epsilon near the close", () => {
    // One minute of real time remains — far below the 15-minute floor.
    const t = yearsToExpiry(TODAY, TODAY, ONE_MIN_BEFORE_CLOSE_ET);
    const epsilon = 1 / (365 * 24 * 4);
    expect(Number.isFinite(t)).toBe(true);
    // Pin the floor itself, not just "at least the floor": one minute of real
    // time must be lifted TO the epsilon, never merely past it.
    expect(t).toBeCloseTo(epsilon, 10);
  });

  it("for expiration tomorrow, is approximately 1/365", () => {
    const t = yearsToExpiry(TOMORROW, TODAY, AT_10_30_ET);
    expect(t).toBeCloseTo(1 / 365, 6);
  });
});

// ─── Full compute: a same-day contract must stay live until the close ──────

describe("computePortfolioGreeks — expiry-day liveness", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedOption(
    id: number,
    underlyingSymbol: string,
    expirationDate: string,
    strike: number,
    optionPrice = 1.5, // small real market price so the IV solver has something to work with
  ): string {
    const symbol = buildOCCSymbol(underlyingSymbol, expirationDate, "CALL", strike);
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type) VALUES (?, ?, 'Stock')`,
    ).run(id, underlyingSymbol);
    db.prepare(
      `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-09-01', ?, 'tws')`,
    ).run(id, strike); // ATM underlying price
    const optId = id + 1000;
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
       VALUES (?, ?, 'Option', 'CALL', ?, ?, ?, 100)`,
    ).run(optId, symbol, strike, expirationDate, underlyingSymbol);
    db.prepare(
      `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-09-01', ?, 'tws')`,
    ).run(optId, optionPrice);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
       VALUES (1, ?, '2026-09-01', 1, ?)`,
    ).run(optId, `${underlyingSymbol.toLowerCase()}-1`);
    return symbol;
  }

  it("prices a contract expiring TODAY as live mid-session (10:30 ET) — not expired", () => {
    const symbol = seedOption(40, "QFFF", TODAY, 100);

    const result = computePortfolioGreeks(db, { today: TODAY, now: AT_10_30_ET });

    const position = result.positions.find((p) => p.symbol === symbol);
    expect(position).toBeDefined();
    expect(position!.daysToExpiry).toBe(0);
    expect(position!.expired).toBe(false);
    expect(position!.greeks).not.toBeNull();
    // The core assertion under test: a live same-day contract must never be
    // diagnosed "expired" just because daysToExpiry is 0.
    expect(result.diagnostics.find((d) => d.symbol === symbol)?.reason).not.toBe("expired");
  });

  it("marks a contract expiring TODAY as expired exactly at the 16:00 ET close", () => {
    const symbol = seedOption(41, "QGGG", TODAY, 100);

    const result = computePortfolioGreeks(db, { today: TODAY, now: AT_16_00_ET });

    const position = result.positions.find((p) => p.symbol === symbol);
    expect(position).toBeDefined();
    expect(position!.daysToExpiry).toBe(0); // DTE column still reads 0d worth of day-count
    expect(position!.expired).toBe(true);
    expect(position!.greeks).toBeNull();
    expect(result.diagnostics.find((d) => d.symbol === symbol)?.reason).toBe("expired");
  });

  it("marks a contract expiring TODAY as expired after the close (16:30 ET)", () => {
    const symbol = seedOption(42, "QHHH", TODAY, 100);

    const result = computePortfolioGreeks(db, { today: TODAY, now: AT_16_30_ET });

    const position = result.positions.find((p) => p.symbol === symbol);
    expect(position).toBeDefined();
    expect(position!.expired).toBe(true);
    expect(position!.greeks).toBeNull();
    expect(result.diagnostics.find((d) => d.symbol === symbol)?.reason).toBe("expired");
  });

  it("marks a contract that expired YESTERDAY as expired regardless of the clock", () => {
    const symbol = seedOption(43, "QIII", YESTERDAY, 100);

    const result = computePortfolioGreeks(db, { today: TODAY, now: AT_10_30_ET });

    const position = result.positions.find((p) => p.symbol === symbol);
    expect(position).toBeDefined();
    expect(position!.daysToExpiry).toBeLessThan(0);
    expect(position!.expired).toBe(true);
    expect(position!.greeks).toBeNull();
    expect(result.diagnostics.find((d) => d.symbol === symbol)?.reason).toBe("expired");
  });

  it("prices a contract expiring TOMORROW normally (T ≈ 1/365, not expired)", () => {
    const symbol = seedOption(44, "QJJJ", TOMORROW, 100);

    const result = computePortfolioGreeks(db, { today: TODAY, now: AT_10_30_ET });

    const position = result.positions.find((p) => p.symbol === symbol);
    expect(position).toBeDefined();
    expect(position!.daysToExpiry).toBe(1);
    expect(position!.expired).toBe(false);
    expect(position!.greeks).not.toBeNull();
    expect(result.diagnostics.find((d) => d.symbol === symbol)?.reason).not.toBe("expired");
  });

  // ── Expiry-day theta must stay inside the contract's own value ───────────

  it("bounds the 0DTE daily theta by the contract's value one minute before the close", () => {
    // Synthetic ATM contract: S = K = 100, seeded at a 0.06 mark so the IV
    // solver lands on a sane vol. With ~15 minutes of T left the RAW
    // Black-Scholes per-day theta is dozens of times the whole contract —
    // a "Daily Theta" that can never be paid.
    const symbol = seedOption(45, "QKKK", TODAY, 100, 0.06);

    const result = computePortfolioGreeks(db, {
      today: TODAY,
      now: ONE_MIN_BEFORE_CLOSE_ET,
      riskFreeRate: 0.045,
    });

    const position = result.positions.find((p) => p.symbol === symbol)!;
    expect(position.expired).toBe(false);
    expect(position.greeks).not.toBeNull();

    const T = yearsToExpiry(TODAY, TODAY, ONE_MIN_BEFORE_CLOSE_ET);
    const sigma = position.greeks!.iv ?? 0.3;
    const valuePerShare = callPrice(100, 100, T, 0.045, sigma);

    // Per share per day: the decay reported can never exceed what is left.
    expect(Math.abs(position.greeks!.theta)).toBeLessThanOrEqual(valuePerShare + 1e-12);
    expect(position.greeks!.theta).toBeLessThan(0); // a long call still decays

    // And the aggregate the UI prints (× multiplier × quantity) is bounded by
    // the book's own value — one contract, 100 multiplier, quantity 1.
    const valuePerContract = valuePerShare * position.multiplier * position.quantity;
    expect(Math.abs(result.totalTheta)).toBeLessThanOrEqual(valuePerContract + 1e-9);

    // The unclamped rate really was the outlier — pin the defect it replaced.
    const rawPerShare = theta(100, 100, T, 0.045, sigma, "CALL");
    expect(Math.abs(rawPerShare)).toBeGreaterThan(valuePerShare * 10);

    // Delta/gamma/vega are untouched by the theta bound.
    expect(position.greeks!.delta).toBeGreaterThan(0);
    expect(position.greeks!.gamma).toBeGreaterThan(0);
  });

  // ── An as-of run must never borrow the live wall clock ───────────────────

  it("derives `now` from an as-of `today` instead of the live clock", () => {
    const symbol = seedOption(46, "QLLL", TODAY, 100, 0.06);

    // Live clock: a LATER date, after the close. If the engine reached for
    // `new Date()` the as-of TODAY contract would read expired.
    vi.useFakeTimers({ now: new Date("2026-09-20T20:00:00-04:00"), toFake: ["Date"] });
    try {
      const derived = computePortfolioGreeks(db, { today: TODAY, riskFreeRate: 0.045 });
      const position = derived.positions.find((p) => p.symbol === symbol)!;
      expect(position.expired).toBe(false);
      expect(position.greeks).not.toBeNull();

      // Pin WHICH instant it derived: midday ET on `today` (16:00 UTC is
      // 12:00 ET under EDT, 11:00 ET under EST — midday either way).
      const explicit = computePortfolioGreeks(db, {
        today: TODAY,
        now: new Date(`${TODAY}T16:00:00Z`),
        riskFreeRate: 0.045,
      });
      expect(position.greeks).toEqual(
        explicit.positions.find((p) => p.symbol === symbol)!.greeks,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("still reads the live clock when neither `today` nor `now` is passed", () => {
    const symbol = seedOption(47, "QMMM", TODAY, 100, 0.06);

    // Production path: both defaults. Freeze the clock mid-session on the
    // expiry date and the contract must be live, exactly as before.
    vi.useFakeTimers({ now: AT_10_30_ET, toFake: ["Date"] });
    try {
      const result = computePortfolioGreeks(db, { riskFreeRate: 0.045 });
      const position = result.positions.find((p) => p.symbol === symbol)!;
      expect(position.expired).toBe(false);
      expect(position.greeks).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }

    // …and after the close on that same day, expired — the live clock still rules.
    vi.useFakeTimers({ now: AT_16_30_ET, toFake: ["Date"] });
    try {
      const result = computePortfolioGreeks(db, { riskFreeRate: 0.045 });
      const position = result.positions.find((p) => p.symbol === symbol)!;
      expect(position.expired).toBe(true);
      expect(position.greeks).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── sameDayTheta: the reported decay can never exceed what is left ────────

describe("sameDayTheta", () => {
  // Synthetic contract only — no real symbol, price or vol anywhere here.
  const S = 100;
  const K = 100;
  const R = 0.045;
  const SIGMA = 0.3;
  const yearsFromHours = (h: number) => Math.max(h / (365 * 24), 1 / (365 * 24 * 4));

  it("clamps an ATM 0DTE call to the time value it still carries", () => {
    const T = yearsFromHours(15 / 60); // the fifteen-minute floor
    const raw = theta(S, K, T, R, SIGMA, "CALL");
    const bounded = sameDayTheta(S, K, T, R, SIGMA, "CALL");
    const value = callPrice(S, K, T, R, SIGMA);

    expect(Math.abs(raw)).toBeGreaterThan(value * 10); // the defect being fixed
    expect(bounded).toBeGreaterThan(raw); // clamped toward zero, not away
    expect(Math.abs(bounded)).toBeLessThanOrEqual(value + 1e-12);
    // ATM: intrinsic is zero, so every cent of the mark is time value.
    expect(bounded).toBeCloseTo(-value, 10);
  });

  it("shrinks toward zero as the close approaches (10:30 → 15:00 → 15:59 ET)", () => {
    const at1030 = sameDayTheta(S, K, yearsFromHours(5.5), R, SIGMA, "CALL");
    const at1500 = sameDayTheta(S, K, yearsFromHours(1), R, SIGMA, "CALL");
    const at1559 = sameDayTheta(S, K, yearsFromHours(15 / 60), R, SIGMA, "CALL");

    expect(Math.abs(at1030)).toBeGreaterThan(Math.abs(at1500));
    expect(Math.abs(at1500)).toBeGreaterThan(Math.abs(at1559));
    for (const [t, th] of [
      [yearsFromHours(5.5), at1030],
      [yearsFromHours(1), at1500],
      [yearsFromHours(15 / 60), at1559],
    ] as const) {
      expect(Math.abs(th)).toBeLessThanOrEqual(callPrice(S, K, t, R, SIGMA) + 1e-12);
    }
  });

  it("leaves a rate already inside the bound alone — the cap only ever caps", () => {
    // Overnight on the expiry date (an as-of run before the open, ~14 hours to
    // the close): the instantaneous rate has not yet accelerated past the day's
    // whole time value, so the cap must return it untouched rather than invent
    // decay of its own.
    const T = yearsFromHours(14);
    const raw = theta(S, K, T, R, SIGMA, "CALL");
    const value = callPrice(S, K, T, R, SIGMA);
    expect(Math.abs(raw)).toBeLessThan(value);
    expect(sameDayTheta(S, K, T, R, SIGMA, "CALL")).toBe(raw);
  });

  it("never flips the sign of a deep-ITM put's positive carry", () => {
    // A deep-ITM European put models BELOW intrinsic (the strike's discount),
    // so "time value" is negative there; that is carry, not decay.
    const T = yearsFromHours(1);
    const value = putPrice(S, 200, T, R, SIGMA);
    const bounded = sameDayTheta(S, 200, T, R, SIGMA, "PUT");
    expect(bounded).toBeGreaterThan(0);
    expect(Math.abs(bounded)).toBeLessThanOrEqual(value + 1e-12);
  });
});
