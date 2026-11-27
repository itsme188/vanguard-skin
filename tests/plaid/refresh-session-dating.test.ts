/**
 * Plaid session dating in the refresh (plan v4 sections A and B, unit U2).
 *
 * A pre-open read on run day D describes S = previousTradingDay(D): every
 * Plaid row (holdings, snapshot, source key, every price) is dated S, and
 * nothing is stored outside the store window. Synthetic fixtures only: made-
 * up symbols, round numbers, invented dates. The Plaid client is a fake
 * fetcher injected through `fetchHoldings`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import type { PlaidHolding, PlaidHoldingsResponse, PlaidSecurity } from "@/lib/plaid/client";
import {
  setPlaidItem,
  setPlaidAccountMap,
  getPlaidConnection,
  setPlaidLastSyncAt,
  setPlaidConnectionStatus,
  setPlaidReauthAlertedAt,
  getPlaidReauthAlertedAt,
} from "@/lib/queries/plaid-settings";
import { PlaidApiError } from "@/lib/plaid/client";
import { setSyncError, getSyncState } from "@/lib/tws/sync-state";
import { getDatingBoundary, getDatingState } from "@/lib/plaid/session-dating";

const hoisted = vi.hoisted(() => ({ valuationThrows: null as string | null }));
vi.mock("@/lib/compute/daily-valuation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/daily-valuation")>();
  return {
    ...actual,
    computeDailyValuations: (db: Database.Database) => {
      if (hoisted.valuationThrows) throw new Error(hoisted.valuationThrows);
      return actual.computeDailyValuations(db);
    },
  };
});

import { refreshVanguardHoldingsFromPlaid, type PlaidHoldingsFetcher } from "@/lib/plaid/refresh";

// Tue 2026-07-14 is the run day; the session it describes is Mon 07-13.
// July is UTC-4.
const RUN_DAY = "2026-07-14";
const S = "2026-07-13";
const AT_0735 = new Date("2026-07-14T11:35:00.000Z");
const AT_0800 = new Date("2026-07-14T12:00:00.000Z");
const AT_0930_01 = new Date("2026-07-14T13:30:01.000Z");
const AT_1000 = new Date("2026-07-14T14:00:00.000Z");
const SATURDAY_0735 = new Date("2026-07-11T11:35:00.000Z");
const AT_0600 = new Date("2026-07-14T10:00:00.000Z");
const AT_0729_59 = new Date("2026-07-14T11:29:59.000Z");

let db: Database.Database;
let acctA: number;
let acctB: number;

function account(name: string): number {
  return Number(db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(name).lastInsertRowid);
}

beforeEach(() => {
  hoisted.valuationThrows = null;
  setSyncError("test reset");
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  acctA = account("Synthetic A");
  acctB = account("Synthetic B");
  setPlaidItem(db, "access-1", "item-1");
  setPlaidAccountMap(db, { pA: acctA, pB: acctB });
});

function holding(acct: string, sec: string, quantity: number, price: number, asOf: string | null = null): PlaidHolding {
  return {
    account_id: acct,
    security_id: sec,
    quantity,
    institution_price: price,
    institution_value: price * quantity,
    institution_price_as_of: asOf,
  };
}

const SECURITIES: PlaidSecurity[] = [
  { security_id: "s1", ticker_symbol: "FAKE1", cusip: null, name: "Fake One", type: "equity", is_cash_equivalent: false },
  { security_id: "s2", ticker_symbol: "FAKE2", cusip: null, name: "Fake Two", type: "etf", is_cash_equivalent: false },
  { security_id: "f1", ticker_symbol: "FAKFX", cusip: null, name: "Fake Fund", type: "mutual fund", is_cash_equivalent: false },
  { security_id: "m1", ticker_symbol: "FAKMM", cusip: null, name: "Fake Money Market", type: "mutual fund", is_cash_equivalent: true },
];

function answer(opts: { accounts?: string[]; holdings?: PlaidHolding[] } = {}): PlaidHoldingsResponse {
  const accounts = opts.accounts ?? ["pA", "pB"];
  return {
    accounts: accounts.map((a) => ({
      account_id: a,
      name: a,
      mask: "0000",
      subtype: "brokerage",
      balances: { current: 50000, available: null },
    })),
    holdings: opts.holdings ?? [
      holding("pA", "s1", 100, 10, S),
      holding("pA", "f1", 200, 20, "2026-07-10"),
      holding("pB", "s2", 50, 40, null),
    ],
    securities: SECURITIES,
  };
}

/** A fake fetcher: records calls and can move the clock it reports. */
function fake(resp: PlaidHoldingsResponse | (() => PlaidHoldingsResponse)) {
  const calls: string[] = [];
  const fetchHoldings: PlaidHoldingsFetcher = async (token) => {
    calls.push(token);
    return typeof resp === "function" ? resp() : resp;
  };
  return { fetchHoldings, calls };
}

function holdingsRows(acct: number): { symbol: string; quantity: number; as_of_date: string; source_key: string }[] {
  return db
    .prepare(
      `SELECT s.symbol, h.quantity, h.as_of_date, h.source_key FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE h.account_id = ? ORDER BY s.symbol, h.as_of_date`,
    )
    .all(acct) as { symbol: string; quantity: number; as_of_date: string; source_key: string }[];
}

function snapshots(acct: number): { month_end_date: string; total_value: number; source: string }[] {
  return db
    .prepare(`SELECT month_end_date, total_value, source FROM monthly_snapshots WHERE account_id = ? ORDER BY month_end_date`)
    .all(acct) as { month_end_date: string; total_value: number; source: string }[];
}

function plaidPrices(): { symbol: string; date: string; close_price: number }[] {
  return db
    .prepare(
      `SELECT s.symbol, p.date, p.close_price FROM prices p JOIN securities s ON s.id = p.security_id
        WHERE p.source = 'plaid' ORDER BY s.symbol, p.date`,
    )
    .all() as { symbol: string; date: string; close_price: number }[];
}

function securityId(symbol: string): number {
  return (db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(symbol) as { id: number }).id;
}

function writtenRowCount(): number {
  const h = (db.prepare(`SELECT COUNT(*) AS c FROM holdings`).get() as { c: number }).c;
  const m = (db.prepare(`SELECT COUNT(*) AS c FROM monthly_snapshots`).get() as { c: number }).c;
  const p = (db.prepare(`SELECT COUNT(*) AS c FROM prices`).get() as { c: number }).c;
  return h + m + p;
}

describe("a pre-open read is dated on the session it describes", () => {
  it("holdings, snapshot, keys and every price are dated S; the answer names S", async () => {
    const f = fake(answer());
    const r = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings: f.fetchHoldings });
    expect(r).not.toBeNull();
    expect(r!.skippedReason).toBeNull();
    expect(r!.session).toBe(S);
    expect(f.calls).toEqual(["access-1"]);

    const a = holdingsRows(acctA);
    expect(a.map((h) => [h.symbol, h.as_of_date])).toEqual([
      ["FAKE1", S],
      ["FAKFX", S],
    ]);
    for (const h of a) {
      expect(h.source_key).toBe(`plaid:s:${acctA}:${securityId(h.symbol)}:${S}`);
    }
    expect(holdingsRows(acctB).map((h) => [h.symbol, h.as_of_date])).toEqual([["FAKE2", S]]);
    expect(snapshots(acctA)).toEqual([{ month_end_date: S, total_value: 50000, source: "plaid" }]);
    expect(snapshots(acctB)).toEqual([{ month_end_date: S, total_value: 50000, source: "plaid" }]);

    // Stock, ETF and mutual fund alike on S. FAKE1's as-of equals S (not
    // counted), FAKFX's is a day early (counted), FAKE2's is null (not
    // counted).
    expect(plaidPrices()).toEqual([
      { symbol: "FAKE1", date: S, close_price: 10 },
      { symbol: "FAKE2", date: S, close_price: 40 },
      { symbol: "FAKFX", date: S, close_price: 20 },
    ]);
    expect(r!.priceAsOfMismatches).toBe(1);
    expect(r!.storedAccounts.map((x) => x.accountId)).toEqual([acctA, acctB]);
    expect(r!.skippedAccounts).toEqual([]);
    expect(r!.valuationsRecomputed).toBe(true);
    expect(r!.valuationError).toBeNull();

    // Nothing on the run day.
    const onRunDay = db
      .prepare(`SELECT COUNT(*) AS c FROM holdings WHERE as_of_date = ?`)
      .get(RUN_DAY) as { c: number };
    expect(onRunDay.c).toBe(0);
    expect(getPlaidConnection(db).lastSyncAt).toBe(AT_0735.toISOString());
  });

  it("a money-market fund's own row is dated S with a new-format key", async () => {
    const mmId = upsertSecurity(db, { symbol: "FAKMM", securityType: "Mutual Fund" });
    db.prepare(`UPDATE securities SET fund_category = 'Cash Equivalent' WHERE id = ?`).run(mmId);
    const f = fake(answer({ holdings: [holding("pA", "s1", 100, 10), holding("pA", "m1", 3000, 1)], accounts: ["pA"] }));
    setPlaidAccountMap(db, { pA: acctA });
    const r = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings: f.fetchHoldings });
    expect(r!.cashEquivalentRowsWritten).toBe(1);
    const mm = holdingsRows(acctA).find((h) => h.symbol === "FAKMM");
    expect(mm).toEqual({ symbol: "FAKMM", quantity: 3000, as_of_date: S, source_key: `plaid:s:${acctA}:${mmId}:${S}` });
  });
});

describe("outside the store window nothing is stored (A2)", () => {
  it("a forced Saturday read: market_closed, no Plaid call, nothing written", async () => {
    const f = fake(answer());
    const r = await refreshVanguardHoldingsFromPlaid(db, { now: SATURDAY_0735, force: true, fetchHoldings: f.fetchHoldings });
    expect(r!.skippedReason).toBe("market_closed");
    expect(r!.session).toBeNull();
    expect(f.calls).toEqual([]);
    expect(writtenRowCount()).toBe(0);
    expect(getPlaidConnection(db).lastSyncAt).toBeNull();
  });

  it("a forced 06:00 read: before_window, no Plaid call, and the 07:35 scheduled read still runs", async () => {
    setPlaidLastSyncAt(db, "2026-07-13T11:35:00.000Z");
    const f = fake(answer());
    const early = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0600, force: true, fetchHoldings: f.fetchHoldings });
    expect(early!.skippedReason).toBe("before_window");
    expect(early!.session).toBeNull();
    expect(f.calls).toEqual([]);
    expect(writtenRowCount()).toBe(0);
    expect(getPlaidConnection(db).lastSyncAt).toBe("2026-07-13T11:35:00.000Z");

    const edge = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0729_59, force: true, fetchHoldings: f.fetchHoldings });
    expect(edge!.skippedReason).toBe("before_window");

    // Not "already synced today": the scheduled read stores the session.
    const scheduled = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings: f.fetchHoldings });
    expect(scheduled!.skippedReason).toBeNull();
    expect(scheduled!.session).toBe(S);
    expect(f.calls).toHaveLength(1);
  });

  it("a forced 10:00 read: after_open, no Plaid call", async () => {
    const f = fake(answer());
    const r = await refreshVanguardHoldingsFromPlaid(db, { now: AT_1000, force: true, fetchHoldings: f.fetchHoldings });
    expect(r!.skippedReason).toBe("after_open");
    expect(f.calls).toEqual([]);
    expect(writtenRowCount()).toBe(0);
  });

  it("an answer arriving at 09:30:01: read_finished_after_open, nothing written, last sync not moved", async () => {
    setPlaidLastSyncAt(db, "2026-07-13T11:35:00.000Z");
    const f = fake(answer());
    const r = await refreshVanguardHoldingsFromPlaid(db, {
      now: AT_0735,
      clock: () => AT_0930_01,
      fetchHoldings: f.fetchHoldings,
    });
    expect(r!.skippedReason).toBe("read_finished_after_open");
    expect(f.calls).toHaveLength(1);
    expect(writtenRowCount()).toBe(0);
    expect(getPlaidConnection(db).lastSyncAt).toBe("2026-07-13T11:35:00.000Z");
    // The sync mutex is released.
    expect(getSyncState().status).toBe("idle");
  });

  it("already_synced_today stops an unforced second read; force bypasses only that gate", async () => {
    const f = fake(answer());
    await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings: f.fetchHoldings });
    const second = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0800, fetchHoldings: f.fetchHoldings });
    expect(second!.skippedReason).toBe("already_synced_today");
    expect(f.calls).toHaveLength(1);
    const forced = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0800, force: true, fetchHoldings: f.fetchHoldings });
    expect(forced!.skippedReason).toBeNull();
    expect(f.calls).toHaveLength(2);
  });
});

describe("a forced re-read inside the window replaces the stored session (A3)", () => {
  it("overwrites quantities and drops a name the new read no longer reports", async () => {
    await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings: fake(answer()).fetchHoldings });
    const second = fake(
      answer({ holdings: [holding("pA", "s1", 120, 11), holding("pB", "s2", 50, 40)] }),
    );
    const r = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0800, force: true, fetchHoldings: second.fetchHoldings });
    expect(r!.session).toBe(S);
    expect(r!.staleRemoved).toBe(1);
    expect(holdingsRows(acctA).map((h) => [h.symbol, h.quantity, h.as_of_date])).toEqual([["FAKE1", 120, S]]);
    expect(plaidPrices().find((p) => p.symbol === "FAKE1")).toEqual({ symbol: "FAKE1", date: S, close_price: 11 });
  });
});

describe("per-account skips", () => {
  it("A5: a statement book on S skips that account's holdings and snapshot; its prices still go in", async () => {
    const fund = upsertSecurity(db, { symbol: "FAKE2", securityType: "ETF" });
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 50, 2000, ?, ?)`,
    ).run(acctB, fund, S, `vanguard-pdf:holding:${acctB}:${fund}:${S}`);

    const r = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings: fake(answer()).fetchHoldings });
    expect(r!.skippedAccounts).toEqual([
      { accountId: acctB, accountName: "Synthetic B", reason: "statement_on_session" },
    ]);
    expect(r!.storedAccounts.map((x) => x.accountId)).toEqual([acctA]);
    expect(r!.accountsSynced).toBe(1);
    expect(holdingsRows(acctB).map((h) => h.source_key)).toEqual([`vanguard-pdf:holding:${acctB}:${fund}:${S}`]);
    expect(snapshots(acctB)).toEqual([]);
    expect(plaidPrices().find((p) => p.symbol === "FAKE2")).toEqual({ symbol: "FAKE2", date: S, close_price: 40 });
    // The statement row is not a tombstone target: the reconciler did not run for B.
    const zeros = db.prepare(`SELECT COUNT(*) AS c FROM holdings WHERE account_id = ? AND quantity = 0`).get(acctB) as { c: number };
    expect(zeros.c).toBe(0);
  });

  it("A6: an account with legacy run-day rows after S is skipped; the other account is written", async () => {
    // A legacy book for B dated on the run day itself (an older build read
    // this morning): key without the `s:` marker, plus a Plaid snapshot.
    const legacySec = upsertSecurity(db, { symbol: "FAKE2", securityType: "ETF" });
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 50, NULL, ?, ?)`,
    ).run(acctB, legacySec, RUN_DAY, `plaid:${acctB}:${legacySec}:${RUN_DAY}`);
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
       VALUES (?, ?, 50000, 0, 'plaid')`,
    ).run(acctB, RUN_DAY);

    const r = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings: fake(answer()).fetchHoldings });
    expect(r!.skippedAccounts).toEqual([
      { accountId: acctB, accountName: "Synthetic B", reason: "legacy_rows_after_session" },
    ]);
    expect(holdingsRows(acctA).every((h) => h.as_of_date === S)).toBe(true);
    // B's legacy book is untouched and nothing new was written for B.
    expect(holdingsRows(acctB)).toEqual([
      { symbol: "FAKE2", quantity: 50, as_of_date: RUN_DAY, source_key: `plaid:${acctB}:${legacySec}:${RUN_DAY}` },
    ]);
    expect(snapshots(acctB).map((s) => s.month_end_date)).toEqual([RUN_DAY]);
    // The map holds A only; the database is Mixed.
    const boundary = getDatingBoundary(db);
    expect([...boundary.accounts]).toEqual([[acctA, S]]);
    expect(boundary.accounts.has(acctB)).toBe(false);
    expect(r!.datingState).toBe("mixed");
  });

  it("A6 per security: a legacy Plaid price after S holds that price back and counts it", async () => {
    const etf = upsertSecurity(db, { symbol: "FAKE2", securityType: "ETF" });
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 39, 'plaid')`).run(etf, RUN_DAY);

    const r = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings: fake(answer()).fetchHoldings });
    expect(r!.pricesHeldLegacyAfter).toBe(1);
    expect(plaidPrices().filter((p) => p.symbol === "FAKE2")).toEqual([{ symbol: "FAKE2", date: RUN_DAY, close_price: 39 }]);
    // The other prices are written and recorded in the map.
    const boundary = getDatingBoundary(db);
    expect(boundary.securities.get(securityId("FAKE1"))).toBe(S);
    expect(boundary.securities.has(etf)).toBe(false);
    expect(getDatingState(db)).toBe("mixed");
  });

  it("one account missing from the answer and one with no positions are named", async () => {
    const acctC = account("Synthetic C");
    setPlaidAccountMap(db, { pA: acctA, pB: acctB, pC: acctC });
    // pB is listed with no holdings; pC is not in the answer at all.
    const f = fake(answer({ accounts: ["pA", "pB"], holdings: [holding("pA", "s1", 100, 10)] }));
    const r = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings: f.fetchHoldings });
    expect(r!.skippedAccounts).toEqual([
      { accountId: acctB, accountName: "Synthetic B", reason: "no_positions" },
      { accountId: acctC, accountName: "Synthetic C", reason: "missing_in_response" },
    ]);
    expect(r!.storedAccounts.map((x) => x.accountId)).toEqual([acctA]);
    expect(snapshots(acctB)).toEqual([]);
    expect(snapshots(acctC)).toEqual([]);
  });
});

describe("a failed valuation recompute is reported, never swallowed (A8)", () => {
  it("the books stay stored, last sync moves, and the answer says the values are not updated", async () => {
    hoisted.valuationThrows = "synthetic valuation failure";
    const r = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings: fake(answer()).fetchHoldings });
    expect(r!.valuationsRecomputed).toBe(false);
    expect(r!.valuationError).toBe("synthetic valuation failure");
    expect(holdingsRows(acctA).length).toBeGreaterThan(0);
    expect(getPlaidConnection(db).lastSyncAt).toBe(AT_0735.toISOString());
    expect(getSyncState().status).toBe("idle");
  });
});

describe("the injected fetcher", () => {
  it("needs no Plaid credentials; the connection is still required", async () => {
    const f = fake(answer());
    const ok = await refreshVanguardHoldingsFromPlaid(db, { cfg: null, now: AT_0735, fetchHoldings: f.fetchHoldings });
    expect(ok!.skippedReason).toBeNull();

    const bare = new Database(":memory:");
    bare.pragma("foreign_keys = ON");
    runMigrations(bare);
    expect(await refreshVanguardHoldingsFromPlaid(bare, { cfg: null, now: AT_0735, fetchHoldings: f.fetchHoldings })).toBeNull();
  });

  it("a fetcher failure releases the sync mutex and rethrows", async () => {
    const failing: PlaidHoldingsFetcher = async () => {
      throw new Error("synthetic Plaid outage");
    };
    await expect(refreshVanguardHoldingsFromPlaid(db, { now: AT_0735, fetchHoldings: failing })).rejects.toThrow(
      "synthetic Plaid outage",
    );
    expect(getSyncState().status).toBe("error");
    expect(writtenRowCount()).toBe(0);
  });
});

describe("a forced skipped read checks the connection when re-auth is pending (planner ruling 2026-11-26)", () => {
  beforeEach(() => {
    setPlaidConnectionStatus(db, "reauth_required");
    setPlaidReauthAlertedAt(db, "2026-07-10T11:35:00.000Z");
    setPlaidLastSyncAt(db, "2026-07-10T11:35:00.000Z");
  });

  it("forced Saturday read with reauth_required: one Plaid call, nothing written, status ok", async () => {
    const f = fake(answer());
    const r = await refreshVanguardHoldingsFromPlaid(db, { now: SATURDAY_0735, force: true, fetchHoldings: f.fetchHoldings });
    expect(r!.skippedReason).toBe("market_closed");
    expect(r!.connectionChecked).toBe(true);
    expect(r!.session).toBeNull();
    expect(f.calls).toHaveLength(1);
    expect(writtenRowCount()).toBe(0);
    expect(getPlaidConnection(db).connectionStatus).toBe("ok");
    expect(getPlaidReauthAlertedAt(db)).toBeNull();
    expect(getPlaidConnection(db).lastSyncAt).toBe("2026-07-10T11:35:00.000Z");
    expect(getSyncState().status).toBe("idle");
  });

  it("the same check runs for a forced before_window or after_open read", async () => {
    const f = fake(answer());
    const early = await refreshVanguardHoldingsFromPlaid(db, { now: AT_0600, force: true, fetchHoldings: f.fetchHoldings });
    expect(early!.skippedReason).toBe("before_window");
    expect(early!.connectionChecked).toBe(true);
    setPlaidConnectionStatus(db, "reauth_required");
    const late = await refreshVanguardHoldingsFromPlaid(db, { now: AT_1000, force: true, fetchHoldings: f.fetchHoldings });
    expect(late!.skippedReason).toBe("after_open");
    expect(late!.connectionChecked).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(writtenRowCount()).toBe(0);
  });

  it("forced Saturday read with status ok: no Plaid call", async () => {
    setPlaidConnectionStatus(db, "ok");
    const f = fake(answer());
    const r = await refreshVanguardHoldingsFromPlaid(db, { now: SATURDAY_0735, force: true, fetchHoldings: f.fetchHoldings });
    expect(r!.skippedReason).toBe("market_closed");
    expect(r!.connectionChecked).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("an unforced (cron) read with reauth_required outside the window never calls Plaid", async () => {
    const f = fake(answer());
    for (const now of [SATURDAY_0735, AT_0600, AT_1000]) {
      const r = await refreshVanguardHoldingsFromPlaid(db, { now, fetchHoldings: f.fetchHoldings });
      expect(r!.connectionChecked).toBe(false);
    }
    expect(f.calls).toEqual([]);
    expect(getPlaidConnection(db).connectionStatus).toBe("reauth_required");
  });

  it("a failure during the check keeps reauth_required and is reported (rethrown)", async () => {
    const loginRequired: PlaidHoldingsFetcher = async () => {
      throw new PlaidApiError("synthetic login required", "ITEM_LOGIN_REQUIRED", "ITEM_ERROR");
    };
    await expect(
      refreshVanguardHoldingsFromPlaid(db, { now: SATURDAY_0735, force: true, fetchHoldings: loginRequired }),
    ).rejects.toThrow("synthetic login required");
    expect(getPlaidConnection(db).connectionStatus).toBe("reauth_required");

    const outage: PlaidHoldingsFetcher = async () => {
      throw new Error("synthetic outage");
    };
    await expect(
      refreshVanguardHoldingsFromPlaid(db, { now: SATURDAY_0735, force: true, fetchHoldings: outage }),
    ).rejects.toThrow("synthetic outage");
    expect(getPlaidConnection(db).connectionStatus).toBe("reauth_required");
    expect(getSyncState().status).toBe("error");
    expect(writtenRowCount()).toBe(0);
  });
});
