/**
 * upsertFxRate source-precedence guard.
 *
 * `ibkr_ledger` is the authoritative rate source (the broker's own
 * per-currency exchangerate, lib/ibkr/refresh.ts). `manual` is the
 * human-repair source (scripts/repair-fx-rate.ts). Nothing writes a
 * `*_derived` source anymore (the TWS sync's derive was removed 2026-09-14
 * after it produced a bogus JPY=1.0 from native-currency marketValue), but
 * the value-based guard in upsertFxRate still defends against one: any
 * `*_derived` write within 1% of 1.0 for a non-USD currency is skipped
 * outright, never written, regardless of precedence.
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
  it("a derived write of ~1.0 is skipped by the value guard (no row / row unchanged)", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0006531, asOf: "2026-07-03", source: "ibkr_ledger" });
    // This is the JPY=1.0 corruption shape: a *_derived source landing at
    // ~1.0 for a non-USD currency. The value guard skips it outright — it
    // never reaches the precedence SQL at all.
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 1.0, asOf: "2026-07-05", source: "tws_derived" });

    const row = krwRow()!;
    expect(row.usd_per_unit).toBeCloseTo(0.0006531, 7);
    expect(row.source).toBe("ibkr_ledger");
    expect(row.as_of).toBe("2026-07-03");
  });

  it("a derived write of ~1.0 with no existing row still writes nothing", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 1.0, asOf: "2026-07-05", source: "tws_derived" });
    expect(krwRow()).toBeUndefined();
  });

  it("a derived 0.99 non-USD rate is skipped (within 1% of 1.0)", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.99, asOf: "2026-07-05", source: "tws_derived" });
    expect(krwRow()).toBeUndefined();
  });

  it("a derived 0.0068 rate still writes (not near 1.0)", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0068, asOf: "2026-07-05", source: "tws_derived" });
    const row = krwRow()!;
    expect(row.usd_per_unit).toBeCloseTo(0.0068, 7);
    expect(row.source).toBe("tws_derived");
  });

  it("a derived write DOES replace a ledger rate stale by more than 7 days", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0006531, asOf: "2026-06-01", source: "ibkr_ledger" });
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.00071, asOf: "2026-07-03", source: "tws_derived" });

    const row = krwRow()!;
    expect(row.usd_per_unit).toBeCloseTo(0.00071, 7);
    expect(row.source).toBe("tws_derived");
  });

  it("a ledger write always overwrites (ledger or derived)", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0007, asOf: "2026-07-01", source: "ibkr_derived" });
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

  it("manual source writes over a tws_derived row", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0007, asOf: "2026-07-01", source: "tws_derived" });
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.00069, asOf: "2026-07-05", source: "manual" });

    const row = krwRow()!;
    expect(row.usd_per_unit).toBeCloseTo(0.00069, 7);
    expect(row.source).toBe("manual");
  });

  it("ibkr_ledger still writes over manual", () => {
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.00069, asOf: "2026-07-05", source: "manual" });
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0006531, asOf: "2026-07-06", source: "ibkr_ledger" });

    const row = krwRow()!;
    expect(row.usd_per_unit).toBeCloseTo(0.0006531, 7);
    expect(row.source).toBe("ibkr_ledger");
  });

  it("still rejects implausible rates and no-ops USD", () => {
    expect(() =>
      upsertFxRate(db, { currency: "KRW", usdPerUnit: 0, asOf: "2026-07-03", source: "ibkr_ledger" }),
    ).toThrow(/implausible/i);
    upsertFxRate(db, { currency: "USD", usdPerUnit: 2, asOf: "2026-07-03", source: "ibkr_ledger" });
    expect(db.prepare("SELECT COUNT(*) c FROM fx_rates").get()).toEqual({ c: 0 });
  });
});
