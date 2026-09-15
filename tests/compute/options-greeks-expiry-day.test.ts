import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildOCCSymbol } from "@/lib/import/occ-symbol";
import {
  computePortfolioGreeks,
  isExpiredAsOf,
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
    expect(t).toBeGreaterThanOrEqual(epsilon - 1e-12);
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
});
