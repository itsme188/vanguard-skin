/**
 * scripts/backfill-daily-bars.ts (Gains at risk addendum, Task A4; ruling C10).
 *
 * The dry run must change nothing; the apply path is exercised only against a
 * temp database with every outside effect injected (no TWS, no app probe, no
 * real backup home). Synthetic ZZ* securities only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/tws/client", () => ({
  getIbApi: vi.fn(() => ({})),
  connectTws: vi.fn(),
  disconnectTws: vi.fn(),
}));

import {
  resolveBackfillDbPath,
  runBackfillDryRun,
  runBackfillApply,
  runBackfillCli,
} from "@/scripts/backfill-daily-bars";
import { upsertOhlcvBars } from "@/lib/mutations/ohlcv";
import { storableDailyBars, type FetchOhlcvOptions, type FetchOhlcvResult, type fetchOhlcvBars } from "@/lib/tws/ohlcv";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { isMarketClosed, previousTradingDay } from "@/lib/calendar/market-holidays";

const SCRIPT = path.join(process.cwd(), "scripts/backfill-daily-bars.ts");

let dir: string;
let dbPath: string;

function sessions(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isMarketClosed(d)) out.push(d);
  return out;
}

function seedFile(): void {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const acct = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Test')").run().lastInsertRowid as number;
  const today = todayET();
  const yesterday = previousTradingDay(today);
  const ins = db.prepare(
    "INSERT INTO securities (symbol, name, security_type, ib_con_id, currency) VALUES (?, ?, 'Stock', ?, ?)",
  );
  const withBars = ins.run("ZZA", "ZZA name", 9001, "USD").lastInsertRowid as number;
  const empty = ins.run("ZZB", "ZZB name", 9002, "USD").lastInsertRowid as number;
  const foreign = ins.run("ZZK", "ZZK name", 9003, "KRW").lastInsertRowid as number;
  const noCon = ins.run("ZZN", "ZZN name", null, "USD").lastInsertRowid as number;
  for (const id of [withBars, empty, foreign, noCon]) {
    db.prepare("INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 10, ?)").run(
      acct,
      id,
      yesterday,
    );
  }
  upsertOhlcvBars(
    db,
    withBars,
    "1 day",
    sessions(addDays(today, -729), yesterday).map((d) => ({ date: d, open: 100, high: 100, low: 100, close: 100, volume: 1 })),
  );
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-daily-bars-"));
  dbPath = path.join(dir, "zz.db");
  seedFile();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__tws_dailyBarLedger;
  delete g.__tws_dailyBarLastBatchAt;
  delete g.__tws_dailyBarRunning;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("backfill-daily-bars dry run", () => {
  it("dry run changes nothing", () => {
    const before = fs.readFileSync(dbPath);
    const lines: string[] = [];
    const summary = runBackfillDryRun(dbPath, { log: (l) => lines.push(l) });
    expect(summary.totalChanges).toBe(0);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(summary).toMatchObject({ targets: 2, foreignSession: 1, noContractId: 1, fullFetches: 1, overlapFetches: 1 });
    expect(summary.requests).toBe(2);
    expect(summary.maxRequests).toBe(3); // the overlap may find a basis change and refetch in full
    expect(lines.join("\n")).toMatch(/55 per 10 minutes/);

    // Reopen: still the same rows.
    const check = new Database(dbPath, { readonly: true });
    expect((check.prepare("SELECT COUNT(*) AS n FROM ohlcv_bars").get() as { n: number }).n).toBeGreaterThan(400);
    check.close();
  });

  it("refuses a database that does not exist, creating nothing", () => {
    const missing = path.join(dir, "nope.db");
    expect(() => runBackfillDryRun(missing, { log: () => {} })).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("resolves the database from --db or BACKFILL_DB_PATH (explicit), else the app default (not explicit)", () => {
    expect(resolveBackfillDbPath(["--db", "/x/a.db"], {})).toEqual({ path: "/x/a.db", explicit: true });
    expect(resolveBackfillDbPath(["--db=/x/b.db"], { BACKFILL_DB_PATH: "/x/c.db" })).toEqual({ path: "/x/b.db", explicit: true });
    expect(resolveBackfillDbPath([], { BACKFILL_DB_PATH: "/x/c.db" })).toEqual({ path: "/x/c.db", explicit: true });
    expect(resolveBackfillDbPath([], { DATABASE_PATH: "/x/d.db" })).toEqual({ path: "/x/d.db", explicit: false });
  });

  it("the dry run may default, printing the path first", async () => {
    const lines: string[] = [];
    const code = await runBackfillCli([], { DATABASE_PATH: dbPath }, { log: (l) => lines.push(l), error: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines[0]).toContain(dbPath);
    expect(lines.join("\n")).toMatch(/DRY RUN/);
  });
});

describe("backfill-daily-bars apply (temp database, everything injected)", () => {
  function fakeFetch() {
    const calls: FetchOhlcvOptions[] = [];
    const fn = async (_db: Database.Database, o: FetchOhlcvOptions): Promise<FetchOhlcvResult> => {
      calls.push(o);
      const today = todayET();
      const from = o.durationStr === "2 Y" ? addDays(today, -730) : addDays(today, -Number(/^(\d+)/.exec(o.durationStr!)![1]));
      const bars = storableDailyBars(
        sessions(from, today).map((d) => ({ date: d, open: 100, high: 100, low: 100, close: 100, volume: 1 })),
        o.maxBarDate!,
      );
      return { bars, barsInserted: 0, fromCache: false, symbol: "ZZ" };
    };
    return { fn: fn as unknown as typeof fetchOhlcvBars, calls };
  }

  it("refuses while the app answers on either port, writing nothing", async () => {
    const before = fs.readFileSync(dbPath);
    for (const busy of [3099, 3000]) {
      const backup = vi.fn();
      const connect = vi.fn();
      const asked: number[] = [];
      await expect(
        runBackfillApply(dbPath, {
          log: () => {},
          portAnswers: async (port) => {
            asked.push(port);
            return port === busy;
          },
          makeBackup: backup,
          connect,
          disconnect: vi.fn(),
          fetch: fakeFetch().fn,
        }),
      ).rejects.toThrow(new RegExp(`${busy}.*quit`, "i"));
      expect(asked).toContain(busy);
      expect(backup).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    }
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it("--apply refuses without an explicit database, in a plain sentence, writing nothing", async () => {
    const before = fs.readFileSync(dbPath);
    const lines: string[] = [];
    const errors: string[] = [];
    const connect = vi.fn();
    const code = await runBackfillCli(["--apply"], { DATABASE_PATH: dbPath }, {
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
      apply: { portAnswers: async () => false, makeBackup: vi.fn(), connect, disconnect: vi.fn(), fetch: fakeFetch().fn },
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain(dbPath);
    expect(errors.join("\n")).toMatch(/--apply needs the database named explicitly: pass --db <path> or set BACKFILL_DB_PATH\./);
    expect(connect).not.toHaveBeenCalled();
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it("--apply with --db runs", async () => {
    const lines: string[] = [];
    const code = await runBackfillCli(["--apply", "--db", dbPath], {}, {
      log: (l) => lines.push(l),
      error: (l) => lines.push(l),
      apply: {
        portAnswers: async () => false,
        makeBackup: async () => {},
        connect: async () => true,
        disconnect: () => {},
        fetch: fakeFetch().fn,
      },
    });
    expect(code).toBe(0);
    expect(lines[0]).toContain(dbPath);
  });

  it("backs up, connects as client 1, captures every target with no cap and no batch window, then disconnects", async () => {
    const order: string[] = [];
    const f = fakeFetch();
    const result = await runBackfillApply(dbPath, {
      log: () => {},
      portAnswers: async () => false,
      makeBackup: async (_db, purpose) => {
        order.push(`backup:${purpose}`);
      },
      connect: async (clientId) => {
        order.push(`connect:${clientId}`);
        return true;
      },
      disconnect: () => {
        order.push("disconnect");
      },
      fetch: f.fn,
      maxSecurities: undefined,
    });
    expect(order).toEqual(["backup:daily-bar-backfill", "connect:1", "disconnect"]);
    expect(result).toMatchObject({ attempted: 2, written: 2, failed: 0 });
    expect(result.skippedReason).toBeUndefined();
    const db = new Database(dbPath, { readonly: true });
    const latest = db
      .prepare("SELECT MAX(bar_date) AS d FROM ohlcv_bars WHERE bar_size = '1 day'")
      .get() as { d: string };
    expect(latest.d < todayET()).toBe(true);
    db.close();
  });
});

describe("backfill-daily-bars source pins", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("never imports the app database module", () => {
    expect(code).not.toMatch(/["']@\/lib\/db["']/);
    expect(code).not.toMatch(/["'](\.\.\/)+lib\/db["']/);
  });

  it("prints the database path as its first line", () => {
    const cli = code.slice(code.indexOf("export async function runBackfillCli"));
    const firstLog = cli.search(/\blog\(/);
    expect(firstLog).toBeGreaterThan(-1);
    expect(cli.slice(firstLog, firstLog + 80)).toMatch(/resolved\.path/);
    expect(cli.slice(0, firstLog)).not.toMatch(/\b(log|error)\(|console\.\w+\(/);
  });

  it("the header notes that a read-only open of a WAL database can create sidecar files", () => {
    expect(src).toMatch(/-shm/);
    expect(src).toMatch(/-wal/);
  });

  it("the dry-run path opens the file read-only", () => {
    const dry = code.slice(code.indexOf("export function runBackfillDryRun"), code.indexOf("export async function runBackfillApply"));
    expect(dry).toMatch(/readonly:\s*true/);
    expect(dry).toMatch(/fileMustExist:\s*true/);
    expect(dry).not.toMatch(/connectTws|takeBackup|3099/);
  });

  it("connectTws, takeBackup and the 3099 probe appear only on the --apply path", () => {
    const applyStart = code.indexOf("export async function runBackfillApply");
    const before = code.slice(0, applyStart);
    expect(before).not.toMatch(/connectTws|takeBackup|3099/);
    for (const name of ["connectTws", "takeBackup", "3099"]) {
      const at = code.indexOf(name);
      expect(at).toBeGreaterThan(applyStart);
    }
    // No static import brings them in.
    expect(code).not.toMatch(/^import[^\n]*(client|take-backup)["']/m);
  });
});
