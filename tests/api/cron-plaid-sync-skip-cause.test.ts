/**
 * `POST /api/cron/plaid-sync` names WHY a sync did not run.
 *
 * The daily launchd script logs the first line of this route's answer. When
 * the refresh returned null the route logged one catch-all note ("not
 * connected, not configured, or another sync in progress"), which also left
 * out a fourth cause (no account mapped). It now reads the same gate the
 * in-app route reads, `plaidRefreshBlocker`, so the log line names the cause.
 * The answer stays a 200 with `success: true` and `result: null`: a skipped
 * run is not a failure, and the script accepts any 2xx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { setPlaidItem, setPlaidAccountMap } from "@/lib/queries/plaid-settings";
import { setSyncPhase, setSyncError } from "@/lib/tws/sync-state";
import { plaidSyncUnavailableMessage } from "@/lib/plaid/refresh";
import type { PlaidClientConfig } from "@/lib/plaid/client";

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

import { POST } from "@/app/api/cron/plaid-sync/route";

const SECRET = "test-cron-secret";
const CFG: PlaidClientConfig = {
  clientId: "cid",
  secret: "sec",
  env: "sandbox",
  redirectUri: null,
  fetchImpl: (async () => {
    throw new Error("the network must not be reached in a skipped run");
  }) as typeof fetch,
};

function req(secret: string | null = SECRET): Request {
  return new Request("http://localhost:3099/api/cron/plaid-sync", {
    method: "POST",
    headers: secret === null ? {} : { "x-cron-secret": secret },
  });
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function vanguardId(db: Database.Database): number {
  db.prepare(`INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable')`).run();
  return (db.prepare(`SELECT id FROM accounts WHERE name = 'Vanguard Taxable'`).get() as { id: number }).id;
}

const originalSecret = process.env.CRON_SHARED_SECRET;

beforeEach(() => {
  process.env.CRON_SHARED_SECRET = SECRET;
  hoisted.db = freshDb();
  hoisted.cfg = CFG;
  setSyncError("test reset");
});

afterEach(() => {
  setSyncError("test reset");
  if (originalSecret === undefined) delete process.env.CRON_SHARED_SECRET;
  else process.env.CRON_SHARED_SECRET = originalSecret;
});

async function skipped(): Promise<{ success: boolean; result: unknown; cause?: string; note?: string }> {
  const res = await POST(req());
  expect(res.status).toBe(200);
  return res.json();
}

describe("the cron Plaid sync names the cause of a skipped run", () => {
  it("credentials not set", async () => {
    hoisted.cfg = null;
    const body = await skipped();
    expect(body).toMatchObject({ success: true, result: null, cause: "not_configured" });
    expect(body.note).toBe(`skipped: ${plaidSyncUnavailableMessage("not_configured")}`);
  });

  it("Plaid not connected", async () => {
    const body = await skipped();
    expect(body).toMatchObject({ success: true, result: null, cause: "not_connected" });
    expect(body.note).toBe(`skipped: ${plaidSyncUnavailableMessage("not_connected")}`);
  });

  it("no account mapped (the cause the old note left out)", async () => {
    setPlaidItem(hoisted.db as Database.Database, "access-1", "item-1");
    const body = await skipped();
    expect(body).toMatchObject({ success: true, result: null, cause: "no_account_mapped" });
    expect(body.note).toBe(`skipped: ${plaidSyncUnavailableMessage("no_account_mapped")}`);
  });

  it("another sync in progress", async () => {
    const db = hoisted.db as Database.Database;
    setPlaidItem(db, "access-1", "item-1");
    setPlaidAccountMap(db, { pTax: vanguardId(db) });
    setSyncPhase("positions");
    const body = await skipped();
    expect(body).toMatchObject({ success: true, result: null, cause: "sync_in_progress" });
    expect(body.note).toBe(`skipped: ${plaidSyncUnavailableMessage("sync_in_progress")}`);
  });

  it("never the old catch-all, and the cause is the first thing in the logged line", async () => {
    const res = await POST(req());
    const text = await res.text();
    expect(text).not.toContain("not connected, not configured, or another sync in progress");
    // run-plaid-sync.sh logs `head -n 1` of the body; the answer is one line.
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain('"cause":"not_connected"');
  });
});

describe("auth is unchanged", () => {
  it("a wrong secret is refused before anything is read", async () => {
    const res = await POST(req("wrong"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: "unauthorized" });
  });

  it("a missing secret header is refused", async () => {
    expect((await POST(req(null))).status).toBe(401);
  });

  it("a server with no CRON_SHARED_SECRET answers 500", async () => {
    delete process.env.CRON_SHARED_SECRET;
    expect((await POST(req())).status).toBe(500);
  });
});
