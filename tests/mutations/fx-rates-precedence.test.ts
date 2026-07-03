/**
 * upsertFxRate source-precedence guard.
 *
 * `ibkr_ledger` is the authoritative rate source (the broker's own
 * per-currency exchangerate). Derived sources (`tws_derived` /
 * `ibkr_derived`) are heuristics computed from position fields whose
 * currency-base is path-dependent — live-verified 2026-07-03 that the Web
 * API's mktValue is NATIVE currency (derive yields a bogus ~1.0). A derived
 * write must therefore never clobber a fresh ledger-sourced rate; it may
 * replace one only when the ledger rate has gone stale (>7 days).
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function krwRow() {
  return db
    .prepare("SELECT usd_per_unit, as_of, source FROM fx_rates WHERE currency = 'KRW'")
    .get() as { usd_per_unit: number; as_of: string; source: string } | undefined;
}

describe("upsertFxRate source precedence", () => {
  it("a derived write does NOT overwrite a ledger rate fresher than 7 days", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0006531, asOf: "2026-07-03", source: "ibkr_ledger" });
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 1.0, asOf: "2026-07-05", source: "tws_derived" });

    const row = krwRow()!;
    expect(row.usd_per_unit).toBeCloseTo(0.0006531, 7);
    expect(row.source).toBe("ibkr_ledger");
    expect(row.as_of).toBe("2026-07-03");
  });

  it("a derived write DOES replace a ledger rate stale by more than 7 days", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0006531, asOf: "2026-06-01", source: "ibkr_ledger" });
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.00071, asOf: "2026-07-03", source: "tws_derived" });

    const row = krwRow()!;
    expect(row.usd_per_unit).toBeCloseTo(0.00071, 7);
    expect(row.source).toBe("tws_derived");
  });

  it("a ledger write always overwrites (ledger or derived)", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 1.0, asOf: "2026-07-01", source: "ibkr_derived" });
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0006531, asOf: "2026-07-03", source: "ibkr_ledger" });
    expect(krwRow()!.usd_per_unit).toBeCloseTo(0.0006531, 7);

    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.00066, asOf: "2026-07-04", source: "ibkr_ledger" });
    expect(krwRow()!.usd_per_unit).toBeCloseTo(0.00066, 7);
  });

  it("a derived write still overwrites another derived rate", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0007, asOf: "2026-07-01", source: "ibkr_derived" });
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.00071, asOf: "2026-07-02", source: "tws_derived" });

    const row = krwRow()!;
    expect(row.usd_per_unit).toBeCloseTo(0.00071, 7);
    expect(row.source).toBe("tws_derived");
  });

  it("still rejects implausible rates and no-ops USD", () => {
    expect(() =>
      upsertFxRate(db, { currency: "KRW", usdPerUnit: 0, asOf: "2026-07-03", source: "ibkr_ledger" }),
    ).toThrow(/implausible/i);
    upsertFxRate(db, { currency: "USD", usdPerUnit: 2, asOf: "2026-07-03", source: "ibkr_ledger" });
    expect(db.prepare("SELECT COUNT(*) c FROM fx_rates").get()).toEqual({ c: 0 });
  });
});
