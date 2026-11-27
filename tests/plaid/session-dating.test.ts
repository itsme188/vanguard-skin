import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  plaidSessionDate,
  isInStoreWindow,
  storeWindowRunDay,
  expectedPlaidSession,
  getDatingBoundary,
  getDatingSettingsRaw,
  recordFirstNewFormatWrite,
  setDatingRepaired,
  settleFreshDatingVersion,
  newFormatHoldingSourceKey,
  isNewFormatPlaidHoldingKey,
  classifyPlaidHoldingRow,
  classifyPlaidSnapshot,
  classifyPlaidPrice,
  getDatingState,
  hasLegacyRowsAfter,
  hasLegacyPriceAfter,
  earliestFirstSession,
  getPlaidRepeatReads,
} from "@/lib/plaid/session-dating";

// Synthetic fixtures only: invented securities, round numbers, dates in 2027
// (plus the 2026 daylight-saving change days for the store window).

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function accountId(db: Database.Database, name: string): number {
  db.prepare(`INSERT OR IGNORE INTO accounts (name) VALUES (?)`).run(name);
  return (db.prepare(`SELECT id FROM accounts WHERE name = ?`).get(name) as { id: number }).id;
}

function security(
  db: Database.Database,
  symbol: string,
  type = "Stock",
  fundCategory: string | null = null,
): number {
  db.prepare(
    `INSERT INTO securities (symbol, name, security_type, fund_category) VALUES (?, ?, ?, ?)`,
  ).run(symbol, symbol, type, fundCategory);
  return (db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(symbol) as { id: number }).id;
}

function snapshot(
  db: Database.Database,
  acct: number,
  date: string,
  total: number,
  cash: number | null,
  source = "plaid",
): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(acct, date, total, cash, source);
}

function holding(
  db: Database.Database,
  acct: number,
  sec: number,
  qty: number,
  date: string,
  key: string,
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(acct, sec, qty, date, key);
}

function legacyKey(acct: number, sec: number, date: string): string {
  return `plaid:${acct}:${sec}:${date}`;
}

function price(db: Database.Database, sec: number, date: string, close: number, source = "plaid"): void {
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, ?)`).run(
    sec,
    date,
    close,
    source,
  );
}

describe("plaidSessionDate", () => {
  it("is the previous trading day", () => {
    expect(plaidSessionDate("2027-03-03")).toBe("2027-03-02"); // Wednesday
    expect(plaidSessionDate("2027-03-08")).toBe("2027-03-05"); // Monday -> Friday
    expect(plaidSessionDate("2027-11-26")).toBe("2027-11-24"); // after Thanksgiving
  });
});

describe("isInStoreWindow", () => {
  it("accepts a pre-open trading-day read and refuses 09:30 and later", () => {
    // Wednesday 2027-03-03, Eastern Standard Time (UTC-5)
    expect(isInStoreWindow(new Date("2027-03-03T12:30:00Z"))).toBe(true); // 07:30
    expect(isInStoreWindow(new Date("2027-03-03T14:29:59Z"))).toBe(true); // 09:29:59
    expect(isInStoreWindow(new Date("2027-03-03T14:30:00Z"))).toBe(false); // 09:30
    expect(isInStoreWindow(new Date("2027-03-03T15:00:00Z"))).toBe(false); // 10:00
  });

  it("refuses a read before 07:30 (planner ruling 2026-11-26)", () => {
    // Wednesday 2027-03-03, EST (UTC-5)
    expect(isInStoreWindow(new Date("2027-03-03T11:00:00Z"))).toBe(false); // 06:00
    expect(isInStoreWindow(new Date("2027-03-03T12:29:59Z"))).toBe(false); // 07:29:59
    expect(isInStoreWindow(new Date("2027-03-03T12:30:00Z"))).toBe(true); // 07:30
    expect(isInStoreWindow(new Date("2027-03-03T05:00:00Z"))).toBe(false); // 00:00
  });

  it("refuses a Saturday and a holiday", () => {
    expect(isInStoreWindow(new Date("2027-03-06T12:30:00Z"))).toBe(false); // Saturday 07:30
    expect(isInStoreWindow(new Date("2027-11-25T12:30:00Z"))).toBe(false); // Thanksgiving 07:30
  });

  it("is right on the spring daylight-saving change (2026-03-08)", () => {
    // The change day itself is a Sunday: closed.
    expect(isInStoreWindow(new Date("2026-03-08T12:30:00Z"))).toBe(false);
    // Friday before, still EST (UTC-5).
    expect(isInStoreWindow(new Date("2026-03-06T14:29:59Z"))).toBe(true); // 09:29:59 EST
    expect(isInStoreWindow(new Date("2026-03-06T14:30:00Z"))).toBe(false); // 09:30 EST
    // Monday after, EDT (UTC-4). A fixed -5 offset would call 14:00Z 09:00.
    expect(isInStoreWindow(new Date("2026-03-09T11:29:59Z"))).toBe(false); // 07:29:59 EDT
    expect(isInStoreWindow(new Date("2026-03-09T11:30:00Z"))).toBe(true); // 07:30 EDT
    // A fixed -5 offset would call 12:00Z 07:00 and refuse it.
    expect(isInStoreWindow(new Date("2026-03-09T12:00:00Z"))).toBe(true); // 08:00 EDT
    expect(isInStoreWindow(new Date("2026-03-09T13:29:59Z"))).toBe(true); // 09:29:59 EDT
    expect(isInStoreWindow(new Date("2026-03-09T13:30:00Z"))).toBe(false); // 09:30 EDT
    expect(isInStoreWindow(new Date("2026-03-09T14:00:00Z"))).toBe(false); // 10:00 EDT
  });

  it("is right on the fall daylight-saving change (2026-11-01)", () => {
    expect(isInStoreWindow(new Date("2026-11-01T12:30:00Z"))).toBe(false); // Sunday
    // Friday before, EDT (UTC-4).
    expect(isInStoreWindow(new Date("2026-10-30T13:29:59Z"))).toBe(true); // 09:29:59 EDT
    expect(isInStoreWindow(new Date("2026-10-30T13:30:00Z"))).toBe(false); // 09:30 EDT
    // Monday after, EST (UTC-5). A fixed -4 offset would call 13:45Z 09:45
    // and 12:15Z 08:15.
    expect(isInStoreWindow(new Date("2026-11-02T12:15:00Z"))).toBe(false); // 07:15 EST
    expect(isInStoreWindow(new Date("2026-11-02T12:29:59Z"))).toBe(false); // 07:29:59 EST
    expect(isInStoreWindow(new Date("2026-11-02T12:30:00Z"))).toBe(true); // 07:30 EST
    expect(isInStoreWindow(new Date("2026-11-02T13:45:00Z"))).toBe(true); // 08:45 EST
    expect(isInStoreWindow(new Date("2026-11-02T14:29:59Z"))).toBe(true); // 09:29:59 EST
    expect(isInStoreWindow(new Date("2026-11-02T14:30:00Z"))).toBe(false); // 09:30 EST
  });
});

describe("storeWindowRunDay", () => {
  it("returns the run day only when start and arrival are both in the window", () => {
    expect(
      storeWindowRunDay(new Date("2027-03-03T12:30:00Z"), new Date("2027-03-03T12:30:05Z")),
    ).toBe("2027-03-03");
    // Response at 09:30:01
    expect(
      storeWindowRunDay(new Date("2027-03-03T14:29:50Z"), new Date("2027-03-03T14:30:01Z")),
    ).toBeNull();
    // Start before 07:30, answer inside the window
    expect(
      storeWindowRunDay(new Date("2027-03-03T12:29:50Z"), new Date("2027-03-03T12:30:05Z")),
    ).toBeNull();
    // Start after the open
    expect(
      storeWindowRunDay(new Date("2027-03-03T15:00:00Z"), new Date("2027-03-03T15:00:01Z")),
    ).toBeNull();
    // Different Eastern days (both pre-open on two trading days)
    expect(
      storeWindowRunDay(new Date("2027-03-03T12:30:00Z"), new Date("2027-03-04T12:30:00Z")),
    ).toBeNull();
  });
});

describe("expectedPlaidSession", () => {
  it("before 07:40 on a trading day: the session the previous run day stored", () => {
    // Wednesday 07:39 EST: today's read not done; Tuesday's read stored Monday.
    expect(expectedPlaidSession(new Date("2027-03-03T12:39:00Z"))).toBe("2027-03-01");
    // Monday 07:00: Friday's read stored Thursday.
    expect(expectedPlaidSession(new Date("2027-03-08T12:00:00Z"))).toBe("2027-03-04");
  });

  it("at or after 07:40 on a trading day: the previous session", () => {
    expect(expectedPlaidSession(new Date("2027-03-03T12:40:00Z"))).toBe("2027-03-02");
    expect(expectedPlaidSession(new Date("2027-03-03T20:00:00Z"))).toBe("2027-03-02");
  });

  it("on a closed day: the session the last trading day's read stored", () => {
    // Saturday: Friday's read stored Thursday.
    expect(expectedPlaidSession(new Date("2027-03-06T17:00:00Z"))).toBe("2027-03-04");
    // Thanksgiving: Wednesday's read stored Tuesday.
    expect(expectedPlaidSession(new Date("2027-11-25T17:00:00Z"))).toBe("2027-11-23");
  });

  it("the day after a holiday", () => {
    // Friday after Thanksgiving, 07:00: last read was Wednesday's (stored Tuesday).
    expect(expectedPlaidSession(new Date("2027-11-26T12:00:00Z"))).toBe("2027-11-23");
    // 08:00: Friday's read stored Wednesday.
    expect(expectedPlaidSession(new Date("2027-11-26T13:00:00Z"))).toBe("2027-11-24");
  });

  it("is right across daylight saving (07:40 EDT = 11:40Z)", () => {
    expect(expectedPlaidSession(new Date("2026-03-09T11:39:00Z"))).toBe("2026-03-05");
    expect(expectedPlaidSession(new Date("2026-03-09T11:40:00Z"))).toBe("2026-03-06");
  });
});

describe("keys", () => {
  it("builds and recognises new-format keys", () => {
    const key = newFormatHoldingSourceKey(3, 17, "2027-03-02");
    expect(key).toBe("plaid:s:3:17:2027-03-02");
    expect(isNewFormatPlaidHoldingKey(key)).toBe(true);
    expect(isNewFormatPlaidHoldingKey("plaid:3:17:2027-03-03")).toBe(false);
    expect(isNewFormatPlaidHoldingKey("tws-3-17-2027-03-03")).toBe(false);
    expect(isNewFormatPlaidHoldingKey(null)).toBe(false);
  });
});

describe("the section B map", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("starts empty and unrepaired", () => {
    const b = getDatingBoundary(db);
    expect(b.repaired).toBe(false);
    expect(b.accounts.size).toBe(0);
    expect(b.securities.size).toBe(0);
    expect(getDatingSettingsRaw(db)).toEqual({ version: null, firstSession: null });
  });

  it("writes an entry once and never moves it", () => {
    expect(recordFirstNewFormatWrite(db, { accountId: 5, session: "2027-03-02" })).toEqual({
      accountAdded: true,
      securityAdded: false,
    });
    expect(recordFirstNewFormatWrite(db, { accountId: 5, session: "2027-03-03" })).toEqual({
      accountAdded: false,
      securityAdded: false,
    });
    expect(recordFirstNewFormatWrite(db, { securityId: 9, session: "2027-03-03" })).toEqual({
      accountAdded: false,
      securityAdded: true,
    });
    recordFirstNewFormatWrite(db, { accountId: 6, securityId: 9, session: "2027-03-04" });
    const b = getDatingBoundary(db);
    expect([...b.accounts]).toEqual([
      [5, "2027-03-02"],
      [6, "2027-03-04"],
    ]);
    expect([...b.securities]).toEqual([[9, "2027-03-03"]]);
    expect(JSON.parse(getDatingSettingsRaw(db).firstSession ?? "{}")).toEqual({
      accounts: { "5": "2027-03-02", "6": "2027-03-04" },
      securities: { "9": "2027-03-03" },
    });
  });

  it("rolls back with the caller's transaction", () => {
    expect(() =>
      db.transaction(() => {
        recordFirstNewFormatWrite(db, { accountId: 5, session: "2027-03-02" });
        throw new Error("write failed");
      })(),
    ).toThrow("write failed");
    expect(getDatingBoundary(db).accounts.size).toBe(0);
  });

  it("refuses a bad session", () => {
    expect(() => recordFirstNewFormatWrite(db, { accountId: 5, session: "2027-3-2" })).toThrow();
  });

  it("does nothing once repaired; repaired deletes the map", () => {
    recordFirstNewFormatWrite(db, { accountId: 5, session: "2027-03-02" });
    setDatingRepaired(db);
    expect(getDatingSettingsRaw(db)).toEqual({ version: "2", firstSession: null });
    expect(recordFirstNewFormatWrite(db, { accountId: 6, session: "2027-03-04" })).toEqual({
      accountAdded: false,
      securityAdded: false,
    });
    const b = getDatingBoundary(db);
    expect(b.repaired).toBe(true);
    expect(b.accounts.size).toBe(0);
  });

  it("throws on a damaged value instead of guessing", () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('plaid_dating_first_session', '{bad')`).run();
    expect(() => getDatingBoundary(db)).toThrow(/not valid JSON/);
    db.prepare(`UPDATE settings SET value = ? WHERE key = 'plaid_dating_first_session'`).run(
      JSON.stringify({ accounts: { "5": "yesterday" } }),
    );
    expect(() => getDatingBoundary(db)).toThrow(/YYYY-MM-DD/);
    db.prepare(`UPDATE settings SET value = ? WHERE key = 'plaid_dating_first_session'`).run(
      JSON.stringify({ accounts: { abc: "2027-03-02" } }),
    );
    expect(() => getDatingBoundary(db)).toThrow(/bad id/);
    db.prepare(`DELETE FROM settings WHERE key = 'plaid_dating_first_session'`).run();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('plaid_dating_version', '3')`).run();
    expect(() => getDatingBoundary(db)).toThrow(/unknown plaid_dating_version/);
  });
});

describe("per-table classification", () => {
  const boundary = {
    repaired: false,
    accounts: new Map([[1, "2027-03-02"]]),
    securities: new Map([[40, "2027-03-03"]]),
  };
  const repaired = { repaired: true, accounts: new Map(), securities: new Map() };

  it("holdings: a plaid row by its key", () => {
    expect(
      classifyPlaidHoldingRow(
        { accountId: 1, asOfDate: "2027-03-02", sourceKey: "plaid:s:1:40:2027-03-02" },
        boundary,
      ),
    ).toBe("new");
    // A legacy key is legacy even when dated after S0.
    expect(
      classifyPlaidHoldingRow(
        { accountId: 1, asOfDate: "2027-03-05", sourceKey: "plaid:1:40:2027-03-05" },
        boundary,
      ),
    ).toBe("legacy");
    expect(
      classifyPlaidHoldingRow(
        { accountId: 1, asOfDate: "2027-03-05", sourceKey: "plaid:1:40:2027-03-05" },
        repaired,
      ),
    ).toBe("legacy");
  });

  it("holdings: a recon tombstone by its date against the account's S0", () => {
    const t = (accountId: number, asOfDate: string) => ({
      accountId,
      asOfDate,
      sourceKey: `recon:closed-equity:${accountId}:40:${asOfDate}:live`,
    });
    expect(classifyPlaidHoldingRow(t(1, "2027-03-02"), boundary)).toBe("new");
    expect(classifyPlaidHoldingRow(t(1, "2027-03-01"), boundary)).toBe("legacy");
    expect(classifyPlaidHoldingRow(t(2, "2027-03-05"), boundary)).toBe("legacy"); // no entry
    expect(classifyPlaidHoldingRow(t(2, "2027-03-05"), repaired)).toBe("new");
  });

  it("holdings: statement and TWS rows are not Plaid-dated", () => {
    expect(
      classifyPlaidHoldingRow(
        { accountId: 1, asOfDate: "2027-03-02", sourceKey: "vanguard-pdf:holding:x" },
        boundary,
      ),
    ).toBeNull();
    expect(
      classifyPlaidHoldingRow({ accountId: 1, asOfDate: "2027-03-02", sourceKey: "tws-1-2" }, boundary),
    ).toBeNull();
    expect(classifyPlaidHoldingRow({ accountId: 1, asOfDate: "2027-03-02", sourceKey: null }, boundary)).toBeNull();
  });

  it("snapshots by the account's S0", () => {
    expect(classifyPlaidSnapshot(1, "2027-03-02", boundary)).toBe("new");
    expect(classifyPlaidSnapshot(1, "2027-03-01", boundary)).toBe("legacy");
    expect(classifyPlaidSnapshot(2, "2027-03-09", boundary)).toBe("legacy");
    expect(classifyPlaidSnapshot(2, "2027-03-09", repaired)).toBe("new");
  });

  it("prices by the security's S0", () => {
    expect(classifyPlaidPrice(40, "2027-03-03", boundary)).toBe("new");
    expect(classifyPlaidPrice(40, "2027-03-02", boundary)).toBe("legacy");
    expect(classifyPlaidPrice(41, "2027-03-09", boundary)).toBe("legacy");
    // The account map does not date prices.
    expect(classifyPlaidPrice(1, "2027-03-09", boundary)).toBe("legacy");
    expect(classifyPlaidPrice(41, "2027-03-09", repaired)).toBe("new");
  });
});

describe("derived states and the A6 probes", () => {
  let db: Database.Database;
  let taxable: number;
  let roth: number;
  let fake1: number;
  let fund1: number;

  beforeEach(() => {
    db = makeDb();
    taxable = accountId(db, "Vanguard Taxable");
    roth = accountId(db, "Vanguard Roth IRA");
    fake1 = security(db, "FAKE1");
    fund1 = security(db, "FAKEFUND1", "Mutual Fund", "Balanced");
  });

  it("fresh on an empty database; settle sets version 2", () => {
    expect(getDatingState(db)).toBe("fresh");
    // First new-format write on an empty database.
    holding(db, taxable, fake1, 10, "2027-03-02", newFormatHoldingSourceKey(taxable, fake1, "2027-03-02"));
    snapshot(db, taxable, "2027-03-02", 1000, 100);
    recordFirstNewFormatWrite(db, { accountId: taxable, session: "2027-03-02" });
    expect(getDatingState(db)).toBe("fresh");
    expect(settleFreshDatingVersion(db)).toBe("repaired");
    expect(getDatingSettingsRaw(db)).toEqual({ version: "2", firstSession: null });
    expect(getDatingState(db)).toBe("repaired");
  });

  it("a statement tombstone alone does not make legacy rows", () => {
    holding(db, taxable, fake1, 0, "2027-02-26", `recon:closed-equity:${taxable}:${fake1}:2027-02-26:stmt`);
    snapshot(db, taxable, "2027-02-26", 1000, 100, "statement");
    expect(getDatingState(db)).toBe("fresh");
  });

  it("legacy: a legacy key, snapshot or price with an empty map", () => {
    holding(db, taxable, fake1, 10, "2027-03-03", legacyKey(taxable, fake1, "2027-03-03"));
    expect(getDatingState(db)).toBe("legacy");
    expect(settleFreshDatingVersion(db)).toBe("legacy");
    expect(getDatingSettingsRaw(db).version).toBeNull();

    const db2 = makeDb();
    const a2 = accountId(db2, "Vanguard Taxable");
    snapshot(db2, a2, "2027-03-03", 1000, 100);
    expect(getDatingState(db2)).toBe("legacy");

    const db3 = makeDb();
    const s3 = security(db3, "FAKEFUND1", "Mutual Fund");
    price(db3, s3, "2027-03-03", 50);
    expect(getDatingState(db3)).toBe("legacy");
  });

  it("mixed: legacy rows with map entries; repaired skips the probe", () => {
    holding(db, roth, fake1, 10, "2027-03-03", legacyKey(roth, fake1, "2027-03-03"));
    recordFirstNewFormatWrite(db, { accountId: taxable, session: "2027-03-02" });
    expect(getDatingState(db)).toBe("mixed");
    setDatingRepaired(db);
    expect(getDatingState(db)).toBe("repaired");
  });

  it("new-format snapshots and prices do not count as legacy", () => {
    recordFirstNewFormatWrite(db, { accountId: taxable, securityId: fund1, session: "2027-03-02" });
    snapshot(db, taxable, "2027-03-02", 1000, 100);
    price(db, fund1, "2027-03-02", 50);
    expect(getDatingState(db)).toBe("fresh");
    // An older Plaid snapshot before S0 is legacy.
    snapshot(db, taxable, "2027-03-01", 1000, 100);
    expect(getDatingState(db)).toBe("mixed");
  });

  it("a two-account transition: A writes, B misses three days", () => {
    // B (Roth) has legacy books on run days 03-01 .. 03-05 before the switch.
    for (const d of ["2027-03-01", "2027-03-02", "2027-03-03", "2027-03-04", "2027-03-05"]) {
      snapshot(db, roth, d, 2000, 200);
      holding(db, roth, fake1, 20, d, legacyKey(roth, fake1, d));
    }
    // A (taxable) switches on run day 03-03: session 03-02.
    snapshot(db, taxable, "2027-03-02", 1000, 100);
    holding(db, taxable, fake1, 10, "2027-03-02", newFormatHoldingSourceKey(taxable, fake1, "2027-03-02"));
    recordFirstNewFormatWrite(db, { accountId: taxable, session: "2027-03-02" });
    expect(getDatingState(db)).toBe("mixed");

    const b = getDatingBoundary(db);
    expect(classifyPlaidSnapshot(taxable, "2027-03-02", b)).toBe("new");
    // B's rows after A's S0 are still legacy: the boundary is per account.
    for (const d of ["2027-03-03", "2027-03-04", "2027-03-05"]) {
      expect(classifyPlaidSnapshot(roth, d, b)).toBe("legacy");
      expect(
        classifyPlaidHoldingRow({ accountId: roth, asOfDate: d, sourceKey: legacyKey(roth, fake1, d) }, b),
      ).toBe("legacy");
    }
    // B's first new-format write at session 03-05 (run day 03-08) is not blocked;
    // an earlier session would be (A6).
    expect(hasLegacyRowsAfter(db, roth, "2027-03-05")).toBe(false);
    expect(hasLegacyRowsAfter(db, roth, "2027-03-04")).toBe(true);
    expect(hasLegacyRowsAfter(db, taxable, "2027-03-01")).toBe(false);

    // The repair moves B's legacy books one session back and rewrites the keys.
    db.transaction(() => {
      const rows = db
        .prepare(`SELECT id, as_of_date FROM holdings WHERE account_id = ? AND source_key LIKE 'plaid:%' ORDER BY as_of_date`)
        .all(roth) as { id: number; as_of_date: string }[];
      for (const r of rows) {
        const t = plaidSessionDate(r.as_of_date);
        db.prepare(`UPDATE holdings SET as_of_date = ?, source_key = ? WHERE id = ?`).run(
          t,
          newFormatHoldingSourceKey(roth, fake1, t),
          r.id,
        );
      }
      const snaps = db
        .prepare(`SELECT id, month_end_date FROM monthly_snapshots WHERE account_id = ? ORDER BY month_end_date`)
        .all(roth) as { id: number; month_end_date: string }[];
      for (const s of snaps) {
        db.prepare(`UPDATE monthly_snapshots SET month_end_date = ? WHERE id = ?`).run(
          plaidSessionDate(s.month_end_date),
          s.id,
        );
      }
      setDatingRepaired(db);
    })();
    expect(getDatingState(db)).toBe("repaired");
    expect(hasLegacyRowsAfter(db, roth, "2027-02-01")).toBe(false);
    const after = getDatingBoundary(db);
    expect(classifyPlaidSnapshot(roth, "2027-03-04", after)).toBe("new");
  });

  it("A6 for an account: legacy holdings or a legacy snapshot after S", () => {
    snapshot(db, taxable, "2027-03-04", 1000, 100);
    expect(hasLegacyRowsAfter(db, taxable, "2027-03-03")).toBe(true);
    expect(hasLegacyRowsAfter(db, taxable, "2027-03-04")).toBe(false);
    expect(hasLegacyRowsAfter(db, roth, "2027-03-03")).toBe(false);

    const db2 = makeDb();
    const a2 = accountId(db2, "Vanguard Taxable");
    const s2 = security(db2, "FAKE1");
    holding(db2, a2, s2, 5, "2027-03-04", legacyKey(a2, s2, "2027-03-04"));
    expect(hasLegacyRowsAfter(db2, a2, "2027-03-03")).toBe(true);
    // A new-format row after S is not legacy.
    const db3 = makeDb();
    const a3 = accountId(db3, "Vanguard Taxable");
    const s3 = security(db3, "FAKE1");
    holding(db3, a3, s3, 5, "2027-03-04", newFormatHoldingSourceKey(a3, s3, "2027-03-04"));
    expect(hasLegacyRowsAfter(db3, a3, "2027-03-03")).toBe(false);
  });

  it("A6 for a security's Plaid price", () => {
    price(db, fund1, "2027-03-04", 50);
    price(db, fake1, "2027-03-05", 20, "tws");
    expect(hasLegacyPriceAfter(db, fund1, "2027-03-03")).toBe(true);
    expect(hasLegacyPriceAfter(db, fund1, "2027-03-04")).toBe(false);
    // Only Plaid prices count.
    expect(hasLegacyPriceAfter(db, fake1, "2027-03-03")).toBe(false);
    // With an entry, a row on or after S0 is new.
    recordFirstNewFormatWrite(db, { securityId: fund1, session: "2027-03-04" });
    expect(hasLegacyPriceAfter(db, fund1, "2027-03-03")).toBe(false);
    setDatingRepaired(db);
    price(db, fake1, "2027-03-08", 21);
    expect(hasLegacyPriceAfter(db, fake1, "2027-03-03")).toBe(false);
  });

  it("earliestFirstSession follows the scope rule", () => {
    expect(earliestFirstSession(db)).toBeNull();
    recordFirstNewFormatWrite(db, { accountId: taxable, session: "2027-03-04" });
    recordFirstNewFormatWrite(db, { accountId: roth, session: "2027-03-02" });
    expect(earliestFirstSession(db)).toBe("2027-03-02");
    expect(earliestFirstSession(db, [taxable])).toBe("2027-03-04");
    expect(earliestFirstSession(db, [])).toBeNull();
    setDatingRepaired(db);
    expect(earliestFirstSession(db)).toBeNull();
  });
});

describe("getPlaidRepeatReads", () => {
  let db: Database.Database;
  let taxable: number;
  let roth: number;
  let ibkr: number;
  let fake1: number;
  let fake2: number;
  let cashFund: number;

  function book(acct: number, date: string, total: number, cash: number | null, rows: [number, number][]) {
    snapshot(db, acct, date, total, cash);
    for (const [sec, qty] of rows) holding(db, acct, sec, qty, date, newFormatHoldingSourceKey(acct, sec, date));
  }

  beforeEach(() => {
    db = makeDb();
    taxable = accountId(db, "Vanguard Taxable");
    roth = accountId(db, "Vanguard Roth IRA");
    ibkr = accountId(db, "IBKR");
    fake1 = security(db, "FAKE1");
    fake2 = security(db, "FAKE2", "ETF");
    cashFund = security(db, "FAKEMM", "Mutual Fund", "Cash Equivalent");
  });

  it("flags identical books and names the sessions", () => {
    book(taxable, "2027-03-01", 1000, 100, [[fake1, 10]]);
    book(taxable, "2027-03-02", 5000, 500, [[fake1, 10], [fake2, 2.5]]);
    book(taxable, "2027-03-03", 5000, 500, [[fake1, 10], [fake2, 2.5000000001]]);
    expect(getPlaidRepeatReads(db)).toEqual([
      { accountId: taxable, accountName: "Vanguard Taxable", session: "2027-03-03", previousSession: "2027-03-02" },
    ]);
  });

  it("does not flag an equal total with one quantity changed", () => {
    book(taxable, "2027-03-02", 5000, 500, [[fake1, 10], [fake2, 3]]);
    book(taxable, "2027-03-03", 5000, 500, [[fake1, 11], [fake2, 3]]);
    expect(getPlaidRepeatReads(db)).toEqual([]);
  });

  it("does not flag a changed cash figure or a missing position", () => {
    book(taxable, "2027-03-02", 5000, 500, [[fake1, 10]]);
    book(taxable, "2027-03-03", 5000, 400, [[fake1, 10]]);
    book(roth, "2027-03-02", 5000, 500, [[fake1, 10], [fake2, 1]]);
    book(roth, "2027-03-03", 5000, 500, [[fake1, 10]]);
    expect(getPlaidRepeatReads(db)).toEqual([]);
  });

  it("does not flag a book holding only cash equivalents", () => {
    book(taxable, "2027-03-02", 5000, 5000, [[cashFund, 5000]]);
    book(taxable, "2027-03-03", 5000, 5000, [[cashFund, 5000]]);
    expect(getPlaidRepeatReads(db)).toEqual([]);
    const empty = makeDb();
    const a = accountId(empty, "Vanguard Taxable");
    snapshot(empty, a, "2027-03-02", 5000, 5000);
    snapshot(empty, a, "2027-03-03", 5000, 5000);
    expect(getPlaidRepeatReads(empty)).toEqual([]);
  });

  it("ignores zero rows and needs two books", () => {
    book(taxable, "2027-03-03", 5000, 500, [[fake1, 10]]);
    expect(getPlaidRepeatReads(db)).toEqual([]);
    book(taxable, "2027-03-02", 5000, 500, [[fake1, 10], [fake2, 0]]);
    expect(getPlaidRepeatReads(db).map((r) => r.accountId)).toEqual([taxable]);
  });

  it("compares the two newest Plaid books, legacy keys included", () => {
    snapshot(db, roth, "2027-03-03", 5000, 500);
    holding(db, roth, fake1, 10, "2027-03-03", legacyKey(roth, fake1, "2027-03-03"));
    snapshot(db, roth, "2027-03-04", 5000, 500);
    holding(db, roth, fake1, 10, "2027-03-04", legacyKey(roth, fake1, "2027-03-04"));
    // A newer non-Plaid snapshot is not a Plaid book.
    snapshot(db, roth, "2027-03-05", 9000, 900, "statement");
    expect(getPlaidRepeatReads(db)).toEqual([
      { accountId: roth, accountName: "Vanguard Roth IRA", session: "2027-03-04", previousSession: "2027-03-03" },
    ]);
  });

  it("follows the scope rule: undefined, [] and IBKR-only", () => {
    book(taxable, "2027-03-02", 5000, 500, [[fake1, 10]]);
    book(taxable, "2027-03-03", 5000, 500, [[fake1, 10]]);
    book(roth, "2027-03-02", 7000, 700, [[fake2, 4]]);
    book(roth, "2027-03-03", 7000, 700, [[fake2, 4]]);
    // IBKR has two identical live books, but they are TWS, not Plaid.
    snapshot(db, ibkr, "2027-03-02", 3000, 300, "tws");
    snapshot(db, ibkr, "2027-03-03", 3000, 300, "tws");

    expect(getPlaidRepeatReads(db).map((r) => r.accountId)).toEqual([taxable, roth]);
    expect(getPlaidRepeatReads(db, [])).toEqual([]);
    expect(getPlaidRepeatReads(db, [ibkr])).toEqual([]);
    expect(getPlaidRepeatReads(db, [roth]).map((r) => r.accountId)).toEqual([roth]);
  });
});
