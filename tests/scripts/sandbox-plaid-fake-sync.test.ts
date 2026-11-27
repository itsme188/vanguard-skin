/**
 * scripts/sandbox-plaid-fake-sync.ts: sandbox-only driver for the real Plaid
 * refresh with a fake Plaid answer. Synthetic fixtures only (FAKE1, FAKE2).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import { setPlaidItem, setPlaidAccountMap } from "@/lib/queries/plaid-settings";
import { setSyncError } from "@/lib/tws/sync-state";
import { easternInstant, main } from "@/scripts/sandbox-plaid-fake-sync";

// Tue 2026-07-14 07:35 ET; the session is Mon 2026-07-13.
const NOW = easternInstant("2026-07-14", "07:35").toISOString();
const SESSION = "2026-07-13";

let dir: string;
let dbPath: string;
let acctA: number;
let acctB: number;
const env = () => ({ VANGUARD_LIVE_DB_PATH: path.join(dir, "not-the-sandbox-live.db") });

function seed(withConnection: boolean): void {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  acctA = Number(db.prepare(`INSERT INTO accounts (name) VALUES ('Synthetic A')`).run().lastInsertRowid);
  acctB = Number(db.prepare(`INSERT INTO accounts (name) VALUES ('Synthetic B')`).run().lastInsertRowid);
  const s1 = upsertSecurity(db, { symbol: "FAKE1", securityType: "Stock" });
  const s2 = upsertSecurity(db, { symbol: "FAKE2", securityType: "ETF" });
  const hold = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, 100, '2026-06-30', ?)`,
  );
  hold.run(acctA, s1, 10, `vanguard-pdf:holding:${acctA}:${s1}:2026-06-30`);
  hold.run(acctB, s2, 20, `vanguard-pdf:holding:${acctB}:${s2}:2026-06-30`);
  const price = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-06-30', ?, 'manual')`);
  price.run(s1, 10);
  price.run(s2, 5);
  if (withConnection) {
    setPlaidItem(db, "access-1", "item-1");
    setPlaidAccountMap(db, { pA: acctA, pB: acctB });
  }
  db.close();
}

function query<T>(sql: string, ...args: unknown[]): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

beforeEach(() => {
  setSyncError("test reset");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-plaid-"));
  dbPath = path.join(dir, "copy.db");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const args = (scenario: string, extra: string[] = []) => [
  "--db", dbPath, "--scenario", scenario, "--sandbox-root", dir, "--now", NOW, ...extra,
];

describe("sandbox fake sync: runs", () => {
  it("success stores both accounts on the session with new-format keys", async () => {
    seed(true);
    const o = await main(args("success"), env());
    expect(o.result!.skippedReason).toBeNull();
    expect(o.result!.session).toBe(SESSION);
    expect(o.result!.storedAccounts.map((a) => a.accountName).sort()).toEqual(["Synthetic A", "Synthetic B"]);
    expect(o.result!.skippedAccounts).toEqual([]);
    expect(o.result!.valuationsRecomputed).toBe(true);
    expect(o.newFormatHoldingRows).toBe(2);
    expect(o.plaidSnapshotsOnSession).toBe(2);
    const rows = query<{ as_of_date: string; source_key: string; quantity: number }>(
      `SELECT as_of_date, source_key, quantity FROM holdings WHERE source_key LIKE 'plaid:s:%' ORDER BY quantity`,
    );
    expect(rows.map((r) => r.quantity)).toEqual([10, 20]);
    for (const r of rows) {
      expect(r.as_of_date).toBe(SESSION);
      expect(r.source_key.endsWith(`:${SESSION}`)).toBe(true);
    }
  });

  it("replace re-reads at 08:00 with one extra share", async () => {
    seed(true);
    await main(args("success"), env());
    const replaceArgs = ["--db", dbPath, "--scenario", "replace", "--sandbox-root", dir,
      "--now", easternInstant("2026-07-14", "08:00").toISOString()];
    const o = await main(replaceArgs, env());
    expect(o.result!.skippedReason).toBeNull();
    expect(o.result!.session).toBe(SESSION);
    const qty = query<{ quantity: number }>(
      `SELECT quantity FROM holdings WHERE source_key LIKE 'plaid:s:%' ORDER BY quantity`,
    ).map((r) => r.quantity);
    expect(qty).toEqual([11, 20]);
    expect(o.newFormatHoldingRows).toBe(2);
  });

  it("partial leaves one account out and says why", async () => {
    seed(true);
    const o = await main(args("partial"), env());
    expect(o.result!.storedAccounts.map((a) => a.accountName)).toEqual(["Synthetic B"]);
    expect(o.result!.skippedAccounts).toEqual([
      expect.objectContaining({ accountName: "Synthetic A", reason: "missing_in_response" }),
    ]);
    expect(o.newFormatHoldingRows).toBe(1);
    expect(o.plaidSnapshotsOnSession).toBe(1);
  });

  it("valuation-fail stores the books and reports the failed recompute", async () => {
    seed(true);
    const o = await main(args("valuation-fail"), env());
    expect(o.result!.valuationsRecomputed).toBe(false);
    expect(o.result!.valuationError).toContain("forced valuation failure");
    expect(o.newFormatHoldingRows).toBe(2);
    // The temporary triggers are gone with the connection: nothing persists.
    expect(query(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sandbox_%'`)).toEqual([]);
  });
});

describe("sandbox fake sync: refusals", () => {
  it("refuses the live database", async () => {
    seed(true);
    await expect(
      main(args("success"), { VANGUARD_LIVE_DB_PATH: dbPath }),
    ).rejects.toThrow(/live database/);
    expect(query(`SELECT 1 FROM holdings WHERE source_key LIKE 'plaid:s:%'`)).toEqual([]);
  });

  it("refuses a path inside the main checkout's data folder", async () => {
    await expect(
      main(["--db", "/Users/Yitzi/code/vanguard-skin/data/anything.db", "--scenario", "success",
        "--sandbox-root", "/Users/Yitzi/code/vanguard-skin/data"], env()),
    ).rejects.toThrow(/main checkout/);
  });

  it("refuses a path outside every sandbox root", async () => {
    seed(true);
    await expect(
      main(["--db", dbPath, "--scenario", "success", "--now", NOW], env()),
    ).rejects.toThrow(/not under a worktree/);
  });

  it("refuses a database with no Plaid connection", async () => {
    seed(false);
    await expect(main(args("success"), env())).rejects.toThrow(/no Plaid connection/);
  });

  it("refuses a missing file and an unknown scenario", async () => {
    await expect(main(args("success"), env())).rejects.toThrow(/does not exist/);
    await expect(main(args("nonsense"), env())).rejects.toThrow(/--scenario/);
  });
});
