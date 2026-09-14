/**
 * scripts/repair-fx-rate.ts — one-currency fx_rates repair.
 *
 * All currency codes and rates below are synthetic (ZAR is used as a stand-in
 * non-USD currency; the numbers are invented, not copied from any real
 * account).
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  planFxRateRepair,
  runFxRateRepair,
  validateManualRate,
  latestHoldingsCountForCurrency,
  type RepairFxRateDeps,
} from "@/scripts/repair-fx-rate";
import type { IbkrOAuthConfig } from "@/lib/ibkr/oauth-client";

const TODAY = "2026-09-14";
const CCY = "ZAR";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function fxRow(currency: string) {
  return db
    .prepare("SELECT usd_per_unit, as_of, source FROM fx_rates WHERE currency = ?")
    .get(currency) as { usd_per_unit: number; as_of: string; source: string } | undefined;
}

const fakeCfg = {} as IbkrOAuthConfig;

function ibkrDeps(rates: Record<string, number>, cfg: IbkrOAuthConfig | null = fakeCfg): RepairFxRateDeps {
  return {
    loadIbkrConfig: () => cfg,
    fetchIbkrFxRates: async () => rates,
  };
}

describe("validateManualRate", () => {
  it("accepts a plausible non-USD rate", () => {
    expect(() => validateManualRate(CCY, 0.054)).not.toThrow();
  });

  it("refuses non-finite rates", () => {
    expect(() => validateManualRate(CCY, Number.NaN)).toThrow(/finite/i);
    expect(() => validateManualRate(CCY, Number.POSITIVE_INFINITY)).toThrow(/finite/i);
  });

  it("refuses zero and negative rates", () => {
    expect(() => validateManualRate(CCY, 0)).toThrow(/positive/i);
    expect(() => validateManualRate(CCY, -0.05)).toThrow(/positive/i);
  });

  it("refuses a rate within 1% of 1.0 for a non-USD currency", () => {
    expect(() => validateManualRate(CCY, 1.0)).toThrow(/within 1%/i);
    expect(() => validateManualRate(CCY, 0.995)).toThrow(/within 1%/i);
  });

  it("allows exactly 1.0 for USD itself", () => {
    expect(() => validateManualRate("USD", 1.0)).not.toThrow();
  });
});

describe("planFxRateRepair — dry run", () => {
  it("reports the plan and writes nothing", async () => {
    const { plan, applied } = await runFxRateRepair(db, {
      currency: CCY,
      mode: "manual",
      usdPerUnit: 0.054,
      asOf: TODAY,
      apply: false,
    });

    expect(applied).toBe(false);
    expect(plan.current).toBeNull();
    expect(plan.proposed).toEqual({ usdPerUnit: 0.054, asOf: TODAY, source: "manual" });
    expect(fxRow(CCY)).toBeUndefined();
  });
});

describe("runFxRateRepair — manual mode --apply", () => {
  it("writes a manual row", async () => {
    const { applied } = await runFxRateRepair(db, {
      currency: CCY,
      mode: "manual",
      usdPerUnit: 0.054,
      asOf: TODAY,
      apply: true,
    });

    expect(applied).toBe(true);
    const row = fxRow(CCY)!;
    expect(row.usd_per_unit).toBeCloseTo(0.054, 9);
    expect(row.source).toBe("manual");
    expect(row.as_of).toBe(TODAY);
  });

  it("refuses to apply an implausible manual rate (throws, writes nothing)", async () => {
    await expect(
      runFxRateRepair(db, { currency: CCY, mode: "manual", usdPerUnit: 1.0, asOf: TODAY, apply: true }),
    ).rejects.toThrow(/within 1%/i);
    expect(fxRow(CCY)).toBeUndefined();
  });

  it("replaces an existing tws_derived 1.0 row", async () => {
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES (?, 1.0, ?, 'tws_derived')",
    ).run(CCY, "2026-09-10");

    await runFxRateRepair(db, {
      currency: CCY,
      mode: "manual",
      usdPerUnit: 0.054,
      asOf: TODAY,
      apply: true,
    });

    const row = fxRow(CCY)!;
    expect(row.usd_per_unit).toBeCloseTo(0.054, 9);
    expect(row.source).toBe("manual");
  });
});

describe("runFxRateRepair — from-ibkr mode", () => {
  it("writes an ibkr_ledger row from the injected fetcher", async () => {
    const deps = ibkrDeps({ [CCY]: 0.0531 });
    const { plan, applied } = await runFxRateRepair(
      db,
      { currency: CCY, mode: "from-ibkr", asOf: TODAY, apply: true },
      deps,
    );

    expect(applied).toBe(true);
    expect(plan.proposed.source).toBe("ibkr_ledger");
    const row = fxRow(CCY)!;
    expect(row.usd_per_unit).toBeCloseTo(0.0531, 9);
    expect(row.source).toBe("ibkr_ledger");
  });

  it("replaces an existing tws_derived 1.0 row via from-ibkr", async () => {
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES (?, 1.0, ?, 'tws_derived')",
    ).run(CCY, "2026-09-10");

    await runFxRateRepair(
      db,
      { currency: CCY, mode: "from-ibkr", asOf: TODAY, apply: true },
      ibkrDeps({ [CCY]: 0.0531 }),
    );

    const row = fxRow(CCY)!;
    expect(row.usd_per_unit).toBeCloseTo(0.0531, 9);
    expect(row.source).toBe("ibkr_ledger");
  });

  it("fails without writing when the ledger has no rate for this currency", async () => {
    await expect(
      runFxRateRepair(
        db,
        { currency: CCY, mode: "from-ibkr", asOf: TODAY, apply: true },
        ibkrDeps({ EUR: 1.09 }),
      ),
    ).rejects.toThrow(new RegExp(`no exchange rate for ${CCY}`, "i"));
    expect(fxRow(CCY)).toBeUndefined();
  });

  it("fails without writing when IBKR is not configured", async () => {
    await expect(
      runFxRateRepair(
        db,
        { currency: CCY, mode: "from-ibkr", asOf: TODAY, apply: true },
        ibkrDeps({}, null),
      ),
    ).rejects.toThrow(/not configured/i);
    expect(fxRow(CCY)).toBeUndefined();
  });

  it("dry run with --from-ibkr resolves the rate but writes nothing", async () => {
    const { plan, applied } = await runFxRateRepair(
      db,
      { currency: CCY, mode: "from-ibkr", asOf: TODAY, apply: false },
      ibkrDeps({ [CCY]: 0.0531 }),
    );

    expect(applied).toBe(false);
    expect(plan.proposed.usdPerUnit).toBeCloseTo(0.0531, 9);
    expect(fxRow(CCY)).toBeUndefined();
  });
});

describe("latestHoldingsCountForCurrency", () => {
  it("counts only latest-per-(account,security) holdings in the given currency", () => {
    const ibkrAccountId = db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as {
      id: number;
    };

    const secId = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZARCO', 'ZAR Co', 'Stock', ?)",
      )
      .run(CCY).lastInsertRowid as number;
    const usdSecId = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, currency) VALUES ('USDCO', 'USD Co', 'Stock', 'USD')",
      )
      .run().lastInsertRowid as number;

    // Superseded older row for the ZAR security — must not be double-counted.
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 10, '2026-09-01', 'test:old')",
    ).run(ibkrAccountId.id, secId);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 20, '2026-09-14', 'test:new')",
    ).run(ibkrAccountId.id, secId);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 5, '2026-09-14', 'test:usd')",
    ).run(ibkrAccountId.id, usdSecId);

    expect(latestHoldingsCountForCurrency(db, CCY)).toBe(1);
    expect(latestHoldingsCountForCurrency(db, "USD")).toBe(1);
    expect(latestHoldingsCountForCurrency(db, "EUR")).toBe(0);
  });
});

describe("planFxRateRepair", () => {
  it("surfaces the current row alongside the proposed one when both exist", async () => {
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES (?, 0.05, '2026-09-01', 'manual')",
    ).run(CCY);

    const plan = await planFxRateRepair(db, {
      currency: CCY,
      mode: "manual",
      usdPerUnit: 0.054,
      asOf: TODAY,
    });

    expect(plan.current).toEqual({ usdPerUnit: 0.05, asOf: "2026-09-01", source: "manual" });
    expect(plan.proposed).toEqual({ usdPerUnit: 0.054, asOf: TODAY, source: "manual" });
  });
});
