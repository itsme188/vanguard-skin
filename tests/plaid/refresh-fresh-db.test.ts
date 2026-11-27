/**
 * The first Plaid write on a database that never held old-format (run-day
 * dated) Plaid rows settles the dating version to "2" in the same
 * transaction (plan v4 section B, `settleFreshDatingVersion`): there is
 * nothing to repair. A database WITH legacy rows keeps the version absent
 * and records the first new-format session per account and security.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import type { PlaidHoldingsResponse } from "@/lib/plaid/client";
import { setPlaidItem, setPlaidAccountMap } from "@/lib/queries/plaid-settings";
import { setSyncError } from "@/lib/tws/sync-state";
import { getDatingSettingsRaw, getDatingState, getDatingBoundary } from "@/lib/plaid/session-dating";
import { refreshVanguardHoldingsFromPlaid } from "@/lib/plaid/refresh";

// Tue 2026-07-14 07:35 ET; the session is Mon 07-13.
const AT_0735 = new Date("2026-07-14T11:35:00.000Z");
const S = "2026-07-13";

let db: Database.Database;
let acct: number;

beforeEach(() => {
  setSyncError("test reset");
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  acct = Number(db.prepare(`INSERT INTO accounts (name) VALUES ('Synthetic A')`).run().lastInsertRowid);
  setPlaidItem(db, "access-1", "item-1");
  setPlaidAccountMap(db, { pA: acct });
});

const ANSWER: PlaidHoldingsResponse = {
  accounts: [{ account_id: "pA", name: "A", mask: "0000", subtype: "brokerage", balances: { current: 10000, available: null } }],
  holdings: [
    { account_id: "pA", security_id: "s1", quantity: 100, institution_price: 10, institution_value: 1000, institution_price_as_of: null },
  ],
  securities: [
    { security_id: "s1", ticker_symbol: "FAKE1", cusip: null, name: "Fake One", type: "equity", is_cash_equivalent: false },
  ],
};
const fetchHoldings = async () => ANSWER;

describe("first write on a fresh database", () => {
  it("an empty database reads Fresh before the write and Repaired (version 2, no map) after it", async () => {
    expect(getDatingState(db)).toBe("fresh");
    expect(getDatingSettingsRaw(db)).toEqual({ version: null, firstSession: null });

    const r = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings });
    expect(r!.session).toBe(S);
    expect(r!.datingState).toBe("repaired");
    expect(getDatingSettingsRaw(db)).toEqual({ version: "2", firstSession: null });
  });

  it("statement history alone does not stop a database from settling as fresh", async () => {
    const sec = upsertSecurity(db, { symbol: "FAKE1", securityType: "Stock" });
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 100, 900, '2026-06-30', ?)`,
    ).run(acct, sec, `vanguard-pdf:holding:${acct}:${sec}:2026-06-30`);
    await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings });
    expect(getDatingSettingsRaw(db).version).toBe("2");
  });

  it("a database with a legacy Plaid row keeps the version absent and records S0", async () => {
    const sec = upsertSecurity(db, { symbol: "FAKE1", securityType: "Stock" });
    // A legacy (run-day dated) book from an earlier day, before S.
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 100, NULL, '2026-07-10', ?)`,
    ).run(acct, sec, `plaid:${acct}:${sec}:2026-07-10`);
    const r = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings });
    expect(r!.datingState).toBe("mixed");
    expect(getDatingSettingsRaw(db).version).toBeNull();
    const boundary = getDatingBoundary(db);
    expect(boundary.accounts.get(acct)).toBe(S);
    expect(boundary.securities.get(sec)).toBe(S);
  });

  it("a failure later in the account's transaction rolls the map entry back with the rows", async () => {
    const sec = upsertSecurity(db, { symbol: "FAKE1", securityType: "Stock" });
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 100, NULL, '2026-07-10', ?)`,
    ).run(acct, sec, `plaid:${acct}:${sec}:2026-07-10`);
    // The price upsert runs after the book and its map entry are written.
    db.exec(`CREATE TRIGGER fail_price BEFORE INSERT ON prices BEGIN SELECT RAISE(ABORT, 'synthetic price failure'); END`);
    await expect(refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings })).rejects.toThrow(
      "synthetic price failure",
    );
    expect(getDatingSettingsRaw(db)).toEqual({ version: null, firstSession: null });
    const newRows = db.prepare(`SELECT COUNT(*) AS c FROM holdings WHERE source_key LIKE 'plaid:s:%'`).get() as { c: number };
    expect(newRows.c).toBe(0);
    const snaps = db.prepare(`SELECT COUNT(*) AS c FROM monthly_snapshots`).get() as { c: number };
    expect(snaps.c).toBe(0);
  });
});
