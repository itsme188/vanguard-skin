/**
 * Plaid minors, second batch (wave Q unit 30).
 *
 * 1. The Settings "Sync Vanguard now" button calls a route that always forces
 *    the sync, and a forced sync never reports "market closed" or "already
 *    synced today". The panel carried two messages for those answers that no
 *    click could ever show. They are gone; the pin on the route's `force`
 *    keeps the removal honest (drop the force and this file fails, which is
 *    the moment to put the messages back).
 * 2. The daily launchd script: it stops with a clear line when `.env.local`
 *    or the cron secret is missing (it used to call the route with no secret
 *    and log only the refusal), it accepts any 2xx answer, and it logs a line
 *    when a tick starts work.
 *
 * The script is never RUN here: past its time gate it calls the live app.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { refreshVanguardHoldingsFromPlaid } from "@/lib/plaid/refresh";
import { setPlaidItem, setPlaidAccountMap } from "@/lib/queries/plaid-settings";
import type { PlaidClientConfig } from "@/lib/plaid/client";
import { setSyncError } from "@/lib/tws/sync-state";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const EMPTY_PLAID = { accounts: [], holdings: [], securities: [] };

function stubCfg(json: unknown): PlaidClientConfig {
  return {
    clientId: "cid",
    secret: "sec",
    env: "sandbox",
    redirectUri: null,
    fetchImpl: (async () =>
      new Response(JSON.stringify(json), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  };
}

function connectedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable')`).run();
  const id = (db.prepare(`SELECT id FROM accounts WHERE name = 'Vanguard Taxable'`).get() as { id: number }).id;
  setPlaidItem(db, "access-1", "item-1");
  setPlaidAccountMap(db, { pTax: id });
  setSyncError("test reset");
  return db;
}

describe("a forced Plaid sync never answers with a skip reason", () => {
  // Sat 2026-07-11 noon ET: the market is closed.
  const SATURDAY = new Date("2026-07-11T16:00:00.000Z");

  it("unforced on a closed day: skipped as market_closed (the cron's answer)", async () => {
    const r = await refreshVanguardHoldingsFromPlaid(connectedDb(), { cfg: stubCfg(EMPTY_PLAID), now: SATURDAY });
    expect(r?.skippedReason).toBe("market_closed");
  });

  it("forced on a closed day: runs, skip reason is null", async () => {
    const r = await refreshVanguardHoldingsFromPlaid(connectedDb(), {
      cfg: stubCfg(EMPTY_PLAID),
      now: SATURDAY,
      force: true,
    });
    expect(r).not.toBeNull();
    expect(r!.skippedReason).toBeNull();
  });

  it("forced twice in one day: the second run is not 'already synced today'", async () => {
    const db = connectedDb();
    const FRIDAY = new Date("2026-07-10T16:00:00.000Z");
    const first = await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(EMPTY_PLAID), now: FRIDAY, force: true });
    const second = await refreshVanguardHoldingsFromPlaid(db, { cfg: stubCfg(EMPTY_PLAID), now: FRIDAY, force: true });
    expect(first!.skippedReason).toBeNull();
    expect(second!.skippedReason).toBeNull();
  });
});

describe("PlaidSection carries no message a click can never show", () => {
  const panel = readFileSync("app/dashboard/components/PlaidSection.tsx", "utf8");
  const route = readFileSync("app/api/plaid/sync/route.ts", "utf8");

  it("the in-app sync route still forces (the reason the skip messages are unreachable)", () => {
    expect(route).toContain("refreshVanguardHoldingsFromPlaid(db, { force: true })");
    expect(panel).toContain('apiFetch("/api/plaid/sync", { method: "POST" })');
  });

  it("the two skip-reason messages and the field are gone from the panel", () => {
    expect(panel).not.toContain("market_closed");
    expect(panel).not.toContain("already_synced_today");
    expect(panel).not.toContain("skippedReason");
    expect(panel).not.toContain("the market is closed");
    expect(panel).not.toContain("Already synced today");
  });

  it("the success message is the one honest count line, with the new-securities warning kept", () => {
    const handler = sliceBetween(panel, "async function handleSync()", "if (!payload && !loadError)");
    expect(handler).toContain("Synced ${holdingsWritten} holding");
    expect(handler).toContain("across ${accountsSynced} account");
    expect(handler).toContain("New securities created:");
    // A failed sync names itself and carries the server's own reason, read
    // through the shared result reader (a 500 with no JSON is still a line).
    expect(handler).toContain("readMutationResult<SyncResponse>(res)");
    expect(handler).toContain("Vanguard sync failed: ${result.message}");
    expect(handler).toContain('networkFailureMessage("sync Vanguard")');
  });
});

describe("scripts/run-plaid-sync.sh guards", () => {
  const path = "scripts/run-plaid-sync.sh";
  const sh = readFileSync(path, "utf8");

  it("parses (bash -n)", () => {
    expect(() => execFileSync("/bin/bash", ["-n", path], { stdio: "pipe" })).not.toThrow();
  });

  it("stays time-gated before anything else happens", () => {
    const gate = anchorIndex(sh, 'in_et_window "1,2,3,4,5" 7 30');
    expect(gate).toBeLessThan(anchorIndex(sh, "ENV_FILE="));
    expect(gate).toBeLessThan(anchorIndex(sh, "curl "));
    expect(gate).toBeLessThan(anchorIndex(sh, "tick start"));
  });

  it("a missing .env.local stops the run with a named error before any call", () => {
    const guard = anchorIndex(sh, 'if [ ! -f "$ENV_FILE" ]; then');
    const block = sh.slice(guard, anchorIndex(sh, "\nfi", guard));
    expect(block).toContain("ERROR: $ENV_FILE not found");
    expect(block).toContain("exit 2");
    expect(guard).toBeLessThan(anchorIndex(sh, "curl "));
    expect(guard).toBeLessThan(anchorIndex(sh, "SECRET=$(grep"));
  });

  it("a missing cron secret stops the run with a named error before any call", () => {
    const guard = anchorIndex(sh, 'if [ -z "$SECRET" ]; then');
    const block = sh.slice(guard, anchorIndex(sh, "\nfi", guard));
    expect(block).toContain("ERROR: CRON_SHARED_SECRET missing from $ENV_FILE");
    expect(block).toContain("exit 2");
    expect(guard).toBeLessThan(anchorIndex(sh, "curl "));
    // The secret is always sent: no branch that calls the route without it.
    expect(sh).not.toContain('if [ -n "$SECRET" ]');
    expect(sh).toContain('-H "X-Cron-Secret: $SECRET"');
  });

  it("never prints the secret", () => {
    for (const line of sh.split("\n").filter((l) => /^\s*echo /.test(l))) {
      expect(line).not.toContain("$SECRET");
      expect(line).not.toContain("HEADERS");
    }
  });

  it("success is any 2xx with a clean curl exit, not the literal 200", () => {
    expect(sh).toContain('[[ "$code" =~ ^2[0-9][0-9]$ ]]');
    expect(sh).toContain("[ $curl_exit -eq 0 ]");
    expect(sh).not.toContain('[ "$code" = "200" ]');
  });

  it("the 2xx test accepts 200-299 and refuses everything else", () => {
    const check = (code: string) => {
      try {
        execFileSync("/bin/bash", ["-c", '[[ "$1" =~ ^2[0-9][0-9]$ ]]', "bash", code], { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    };
    expect(["200", "201", "204", "299"].map(check)).toEqual([true, true, true, true]);
    expect(["000", "199", "300", "403", "500", "2000", "20", "", "200x"].map(check)).toEqual(
      Array(9).fill(false),
    );
  });

  it("logs a line when a tick starts work, and still tries both ports", () => {
    expect(sh).toContain("plaid-sync tick start");
    expect(sh).toContain("http://localhost:3099/api/cron/plaid-sync");
    expect(sh).toContain("http://localhost:3000/api/cron/plaid-sync");
    expect(sh).toContain("plaid-sync failed on both ports");
    expect(sh.trimEnd().endsWith("exit 1")).toBe(true);
  });
});
