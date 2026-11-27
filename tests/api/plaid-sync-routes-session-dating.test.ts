/**
 * Both Plaid sync routes with session dating (plan v4 sections A and F, unit
 * U2): the scheduled cron route (`POST /api/cron/plaid-sync`) and the in-app
 * button's route (`POST /api/plaid/sync`, forced).
 *
 * A fake Plaid client (a `fetchImpl` on the config `loadPlaidConfig`
 * returns) answers with synthetic holdings; the database singleton is a
 * migrated in-memory database; the wall clock is pinned with fake `Date`
 * only. Every write is asserted in SQLite, and every skip reason is read
 * back from the `{ success, data }` envelope.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import {
  setPlaidItem,
  setPlaidAccountMap,
  getPlaidConnection,
  setPlaidConnectionStatus,
} from "@/lib/queries/plaid-settings";
import { setSyncError } from "@/lib/tws/sync-state";
import { getDatingBoundary, getDatingSettingsRaw } from "@/lib/plaid/session-dating";
import type { PlaidClientConfig, PlaidHoldingsResponse } from "@/lib/plaid/client";

const hoisted = vi.hoisted(() => ({
  db: null as unknown,
  cfg: null as unknown,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));
vi.mock("@/lib/plaid/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plaid/client")>();
  return { ...actual, loadPlaidConfig: () => hoisted.cfg };
});

import { POST as cronPOST } from "@/app/api/cron/plaid-sync/route";
import { POST as appPOST } from "@/app/api/plaid/sync/route";

const SECRET = "test-cron-secret";
// Tue 2026-07-14 is the run day; the session it describes is Mon 07-13.
const S = "2026-07-13";
const RUN_DAY = "2026-07-14";
const AT_0735 = new Date("2026-07-14T11:35:00.000Z");
const AT_0740 = new Date("2026-07-14T11:40:00.000Z");
const AT_0930_01 = new Date("2026-07-14T13:30:01.000Z");
const AT_1000 = new Date("2026-07-14T14:00:00.000Z");
const SATURDAY_0735 = new Date("2026-07-11T11:35:00.000Z");
const AT_0600 = new Date("2026-07-14T10:00:00.000Z");

type Db = Database.Database;
const theDb = (): Db => hoisted.db as Db;

/** What the fake Plaid client answers, and how many calls it saw. */
let plaidAnswer: { status: number; body: unknown };
let plaidCalls = 0;
/** Optional: moves the wall clock while the "network call" is in flight. */
let duringCall: (() => void) | null = null;

const CFG: PlaidClientConfig = {
  clientId: "cid",
  secret: "sec",
  env: "sandbox",
  redirectUri: null,
  fetchImpl: (async () => {
    plaidCalls++;
    duringCall?.();
    return new Response(JSON.stringify(plaidAnswer.body), {
      status: plaidAnswer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch,
};

let acctA: number;

function account(name: string): number {
  return Number(theDb().prepare(`INSERT INTO accounts (name) VALUES (?)`).run(name).lastInsertRowid);
}

function answer(accounts: string[], holdings: [string, string, number][]): PlaidHoldingsResponse {
  return {
    accounts: accounts.map((a) => ({
      account_id: a,
      name: a,
      mask: "0000",
      subtype: "brokerage",
      balances: { current: 40000, available: null },
    })),
    holdings: holdings.map(([acct, sec, qty]) => ({
      account_id: acct,
      security_id: sec,
      quantity: qty,
      institution_price: 10,
      institution_value: 10 * qty,
      institution_price_as_of: null,
    })),
    securities: [
      { security_id: "s1", ticker_symbol: "FAKE1", cusip: null, name: "Fake One", type: "equity", is_cash_equivalent: false },
      { security_id: "s2", ticker_symbol: "FAKE2", cusip: null, name: "Fake Two", type: "equity", is_cash_equivalent: false },
    ],
  };
}

function cronReq(body = "{}"): Request {
  return new Request("http://localhost:3099/api/cron/plaid-sync", {
    method: "POST",
    headers: { "x-cron-secret": SECRET, "content-type": "application/json" },
    body,
  });
}

async function cron(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await cronPOST(cronReq());
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function app(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await appPOST();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type Data = {
  skippedReason: string | null;
  session: string | null;
  datingState: string;
  accountsSynced: number;
  storedAccounts: { accountId: number; accountName: string }[];
  skippedAccounts: { accountId: number; accountName: string; reason: string }[];
  pricesHeldLegacyAfter: number;
  valuationsRecomputed: boolean;
  valuationError: string | null;
};
const dataOf = (body: Record<string, unknown>): Data => body.data as Data;

const originalSecret = process.env.CRON_SHARED_SECRET;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AT_0735);
  process.env.CRON_SHARED_SECRET = SECRET;
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  hoisted.cfg = CFG;
  setSyncError("test reset");
  plaidCalls = 0;
  duringCall = null;
  acctA = account("Synthetic A");
  setPlaidItem(db, "access-1", "item-1");
  setPlaidAccountMap(db, { pA: acctA });
  plaidAnswer = { status: 200, body: answer(["pA"], [["pA", "s1", 100]]) };
});

afterEach(() => {
  vi.useRealTimers();
  setSyncError("test reset");
  if (originalSecret === undefined) delete process.env.CRON_SHARED_SECRET;
  else process.env.CRON_SHARED_SECRET = originalSecret;
});

/** A legacy (run-day dated) Plaid book on an earlier day, so the map stays in use. */
function seedLegacyBook(): number {
  const sec = upsertSecurity(theDb(), { symbol: "FAKE9", securityType: "Stock" });
  theDb()
    .prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 5, NULL, '2026-07-10', ?)`,
    )
    .run(acctA, sec, `plaid:${acctA}:${sec}:2026-07-10`);
  return sec;
}

function rowsOnS(): { source_key: string; as_of_date: string; quantity: number }[] {
  return theDb()
    .prepare(
      `SELECT source_key, as_of_date, quantity FROM holdings
        WHERE account_id = ? AND source_key LIKE 'plaid:s:%' ORDER BY source_key`,
    )
    .all(acctA) as { source_key: string; as_of_date: string; quantity: number }[];
}

for (const [name, call] of [
  ["cron", cron],
  ["in-app", app],
] as const) {
  describe(`${name} route: a pre-open read is stored on the session`, () => {
    it("writes rows dated S with new-format keys, the snapshot and the map entry", async () => {
      seedLegacyBook();
      const { status, body } = await call();
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      const d = dataOf(body);
      expect(d.skippedReason).toBeNull();
      expect(d.session).toBe(S);
      expect(d.datingState).toBe("mixed");
      expect(d.storedAccounts).toEqual([{ accountId: acctA, accountName: "Synthetic A" }]);
      expect(d.skippedAccounts).toEqual([]);
      expect(d.valuationsRecomputed).toBe(true);
      expect(d.valuationError).toBeNull();
      expect(d.pricesHeldLegacyAfter).toBe(0);

      const fake1 = (theDb().prepare(`SELECT id FROM securities WHERE symbol = 'FAKE1'`).get() as { id: number }).id;
      expect(rowsOnS()).toEqual([{ source_key: `plaid:s:${acctA}:${fake1}:${S}`, as_of_date: S, quantity: 100 }]);
      const snap = theDb()
        .prepare(`SELECT month_end_date, source FROM monthly_snapshots WHERE account_id = ?`)
        .all(acctA);
      expect(snap).toEqual([{ month_end_date: S, source: "plaid" }]);
      const price = theDb().prepare(`SELECT date, source FROM prices WHERE security_id = ?`).all(fake1);
      expect(price).toEqual([{ date: S, source: "plaid" }]);
      const onRunDay = theDb().prepare(`SELECT COUNT(*) AS c FROM holdings WHERE as_of_date = ?`).get(RUN_DAY) as {
        c: number;
      };
      expect(onRunDay.c).toBe(0);

      const boundary = getDatingBoundary(theDb());
      expect(boundary.accounts.get(acctA)).toBe(S);
      expect(boundary.securities.get(fake1)).toBe(S);
      expect(getPlaidConnection(theDb()).lastSyncAt).toBe(AT_0735.toISOString());
    });

    it("a fresh database settles to version 2", async () => {
      const { body } = await call();
      expect(dataOf(body).datingState).toBe("repaired");
      expect(getDatingSettingsRaw(theDb())).toEqual({ version: "2", firstSession: null });
    });

    it("market_closed (Saturday) passes through; no Plaid call, nothing written", async () => {
      vi.setSystemTime(SATURDAY_0735);
      const { status, body } = await call();
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(dataOf(body).skippedReason).toBe("market_closed");
      expect(dataOf(body).session).toBeNull();
      expect(plaidCalls).toBe(0);
      expect((theDb().prepare(`SELECT COUNT(*) AS c FROM holdings`).get() as { c: number }).c).toBe(0);
    });

    it("before_window (06:00) passes through; no Plaid call, last sync not moved", async () => {
      vi.setSystemTime(AT_0600);
      const { status, body } = await call();
      expect(status).toBe(200);
      expect(dataOf(body).skippedReason).toBe("before_window");
      expect(plaidCalls).toBe(0);
      expect((theDb().prepare(`SELECT COUNT(*) AS c FROM holdings`).get() as { c: number }).c).toBe(0);
      expect(getPlaidConnection(theDb()).lastSyncAt).toBeNull();
    });

    it("after_open (10:00) passes through; no Plaid call", async () => {
      vi.setSystemTime(AT_1000);
      const { body } = await call();
      expect(dataOf(body).skippedReason).toBe("after_open");
      expect(plaidCalls).toBe(0);
    });

    it("read_finished_after_open passes through; nothing written, last sync not moved", async () => {
      duringCall = () => vi.setSystemTime(AT_0930_01);
      const { body } = await call();
      expect(dataOf(body).skippedReason).toBe("read_finished_after_open");
      expect(plaidCalls).toBe(1);
      expect((theDb().prepare(`SELECT COUNT(*) AS c FROM holdings`).get() as { c: number }).c).toBe(0);
      expect(getPlaidConnection(theDb()).lastSyncAt).toBeNull();
    });

    it("every per-account skip reason passes through", async () => {
      const db = theDb();
      const acctB = account("Synthetic B");
      const acctC = account("Synthetic C");
      const acctD = account("Synthetic D");
      const acctE = account("Synthetic E");
      setPlaidAccountMap(db, { pA: acctA, pB: acctB, pC: acctC, pD: acctD, pE: acctE });
      const fake2 = upsertSecurity(db, { symbol: "FAKE2", securityType: "Stock" });
      // B: a statement already holds the session.
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
         VALUES (?, ?, 10, 100, ?, ?)`,
      ).run(acctB, fake2, S, `vanguard-pdf:holding:${acctB}:${fake2}:${S}`);
      // C: legacy rows dated after the session (the run day itself).
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
         VALUES (?, ?, 10, NULL, ?, ?)`,
      ).run(acctC, fake2, RUN_DAY, `plaid:${acctC}:${fake2}:${RUN_DAY}`);
      // A legacy Plaid price after the session holds FAKE2's price back.
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 9, 'plaid')`).run(fake2, RUN_DAY);
      // D is listed with no positions; E is not in the answer.
      plaidAnswer = {
        status: 200,
        body: answer(["pA", "pB", "pC", "pD"], [
          ["pA", "s1", 100],
          ["pB", "s2", 10],
          ["pC", "s2", 10],
        ]),
      };

      const { body } = await call();
      const d = dataOf(body);
      expect(d.storedAccounts.map((a) => a.accountId)).toEqual([acctA]);
      expect(d.skippedAccounts).toEqual([
        { accountId: acctB, accountName: "Synthetic B", reason: "statement_on_session" },
        { accountId: acctC, accountName: "Synthetic C", reason: "legacy_rows_after_session" },
        { accountId: acctD, accountName: "Synthetic D", reason: "no_positions" },
        { accountId: acctE, accountName: "Synthetic E", reason: "missing_in_response" },
      ]);
      // FAKE2's price is offered by B and by C: held back both times.
      expect(d.pricesHeldLegacyAfter).toBe(2);
    });

    it("a Plaid failure answers 500 with the error and writes nothing", async () => {
      plaidAnswer = {
        status: 500,
        body: { error_code: "INTERNAL_SERVER_ERROR", error_type: "API_ERROR", error_message: "synthetic outage" },
      };
      const { status, body } = await call();
      expect(status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe("synthetic outage");
      expect((theDb().prepare(`SELECT COUNT(*) AS c FROM holdings`).get() as { c: number }).c).toBe(0);
    });
  });
}

describe("a forced read outside the window while re-auth is pending", () => {
  it("in-app: checks the connection, stores nothing, passes connectionChecked through", async () => {
    setPlaidConnectionStatus(theDb(), "reauth_required");
    vi.setSystemTime(SATURDAY_0735);
    const { body } = await app();
    expect(dataOf(body).skippedReason).toBe("market_closed");
    expect((body.data as { connectionChecked: boolean }).connectionChecked).toBe(true);
    expect(plaidCalls).toBe(1);
    expect((theDb().prepare(`SELECT COUNT(*) AS c FROM holdings`).get() as { c: number }).c).toBe(0);
    expect(getPlaidConnection(theDb()).connectionStatus).toBe("ok");
  });

  it("cron: never calls Plaid outside the window, even with re-auth pending", async () => {
    setPlaidConnectionStatus(theDb(), "reauth_required");
    vi.setSystemTime(SATURDAY_0735);
    const { body } = await cron();
    expect((body.data as { connectionChecked: boolean }).connectionChecked).toBe(false);
    expect(plaidCalls).toBe(0);
    expect(getPlaidConnection(theDb()).connectionStatus).toBe("reauth_required");
  });
});

describe("a null result (nothing could run)", () => {
  function disconnect(): void {
    theDb().prepare(`DELETE FROM settings WHERE key = 'plaid_access_token'`).run();
  }

  it("cron: success with data null and the cause named", async () => {
    disconnect();
    const { status, body } = await cron();
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, data: null, cause: "not_connected" });
    expect(plaidCalls).toBe(0);
  });

  it("in-app: a refusal with the cause in plain words", async () => {
    disconnect();
    const { body } = await app();
    expect(body.success).toBe(false);
    expect(String(body.error)).toContain("not connected");
  });
});

describe("two ticks in one window", () => {
  it("cron: the second tick is already_synced_today, and the request body cannot force it", async () => {
    const first = await cron();
    expect(dataOf(first.body).skippedReason).toBeNull();
    vi.setSystemTime(AT_0740);
    const res = await cronPOST(cronReq(JSON.stringify({ force: true })));
    const second = (await res.json()) as Record<string, unknown>;
    expect(dataOf(second).skippedReason).toBe("already_synced_today");
    expect(plaidCalls).toBe(1);
  });

  it("in-app (forced): the second press reads again and replaces the session's book", async () => {
    await app();
    vi.setSystemTime(AT_0740);
    plaidAnswer = { status: 200, body: answer(["pA"], [["pA", "s1", 120]]) };
    const second = await app();
    expect(dataOf(second.body).skippedReason).toBeNull();
    expect(plaidCalls).toBe(2);
    expect(rowsOnS().map((r) => r.quantity)).toEqual([120]);
  });

  it("in-app: the answer is the plain { success, data } envelope (no top-level copy)", async () => {
    const { body } = await app();
    expect(Object.keys(body).sort()).toEqual(["data", "success"]);
    expect(dataOf(body).session).toBe(S);
    expect(dataOf(body).accountsSynced).toBe(1);
  });
});
