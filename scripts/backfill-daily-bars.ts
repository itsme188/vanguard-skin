/**
 * One-shot first fill of two years of daily bars (Gains at risk addendum,
 * Task A4; ruling C10). The sync pipeline's capture step
 * (`lib/tws/daily-bar-capture.ts`) then keeps them current, 20 at a time.
 *
 * Dry run by default: opens the database READ-ONLY with its own connection
 * (never the app's database module, which migrates and checkpoints at load),
 * prints the target and skip counts, the number of TWS requests and the time
 * they take at 55 per 10 minutes, and writes nothing.
 *
 * A read-only open of a WAL-mode database can still create empty `-shm` and
 * `-wal` sidecar files next to it (SQLite needs the shared-memory index to
 * read a WAL database). They hold no data and the database file itself is
 * not changed; the test pins the file's bytes.
 *
 * `--apply`:
 *   0. needs the database named explicitly (`--db` or `BACKFILL_DB_PATH`);
 *      the app's default path is accepted only for the dry run;
 *   1. refuses while anything answers on 127.0.0.1:3099 (the installed app)
 *      or 127.0.0.1:3000 (`npm run dev`): quit the app first, since it holds
 *      TWS client id 1 and the same limiter budget;
 *   2. takes a backup through `takeBackup` (purpose `daily-bar-backfill`);
 *   3. opens its own writable connection, connects TWS as client id 1;
 *   4. runs the capture with no cap and no batch window, prints the result,
 *      disconnects.
 *
 * Database: `--db <path>`, else `BACKFILL_DB_PATH`, else (dry run only) the
 * app's default resolution (`resolveDbPath`: DATABASE_PATH, VANGUARD_DB_DIR,
 * then the checkout's data folder). The path is the first line printed.
 *
 * Run from the repo root (the `@/` alias resolves from the cwd's tsconfig):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/backfill-daily-bars.ts
 *   npm run coord -- lock run tws --task <id> -- env PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/backfill-daily-bars.ts --apply
 */

import Database from "better-sqlite3";
import { resolveDbPath, type EnvLike } from "@/lib/db/db-path";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { getPricedDailyBarRange } from "@/lib/queries/ohlcv";
import {
  DAILY_BAR_HISTORY_DAYS,
  listDailyBarTargets,
  runDailyBarCapture,
  type DailyBarCaptureResult,
} from "@/lib/tws/daily-bar-capture";
import type { fetchOhlcvBars } from "@/lib/tws/ohlcv";

/** The OHLCV limiter's budget (`lib/tws/rate-limiter.ts`). */
const REQUESTS_PER_WINDOW = 55;
const WINDOW_MINUTES = 10;
/** Same slack as the capture: a stored history starting later than this is fetched in full. */
const FULL_HISTORY_DAYS = DAILY_BAR_HISTORY_DAYS - 7;

/** `explicit` is true only for `--db` or `BACKFILL_DB_PATH`; `--apply` needs it. */
export function resolveBackfillDbPath(argv: string[], env: EnvLike = process.env): { path: string; explicit: boolean } {
  const eq = argv.find((a) => a.startsWith("--db="));
  if (eq) return { path: eq.slice("--db=".length), explicit: true };
  const i = argv.indexOf("--db");
  if (i !== -1 && i + 1 < argv.length) return { path: argv[i + 1], explicit: true };
  if (env.BACKFILL_DB_PATH) return { path: env.BACKFILL_DB_PATH, explicit: true };
  return { path: resolveDbPath(env), explicit: false };
}

export interface BackfillDryRunSummary {
  today: string;
  targets: number;
  foreignSession: number;
  noContractId: number;
  mutualFund: number;
  bondFund: number;
  /** Targets with no priced bars, or a history that starts too late: one two-year request each. */
  fullFetches: number;
  /** Targets with a two-year history: one overlap request each. */
  overlapFetches: number;
  /** One request per target. */
  requests: number;
  /** If every overlap finds a basis change, each adds one two-year request. */
  maxRequests: number;
  /** Minutes at 55 requests per 10 minutes, for `requests` and `maxRequests`. */
  minutes: number;
  maxMinutes: number;
  /** `total_changes()` on the script's own connection: always 0. */
  totalChanges: number;
}

function minutesFor(requests: number): number {
  return Math.ceil((requests / REQUESTS_PER_WINDOW) * WINDOW_MINUTES);
}

export function runBackfillDryRun(
  dbPath: string,
  opts: { today?: string; log?: (line: string) => void } = {},
): BackfillDryRunSummary {
  const log = opts.log ?? console.log;
  const today = opts.today ?? todayET();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const listed = listDailyBarTargets(db, today);
    const floor = addDays(today, -FULL_HISTORY_DAYS);
    const windowStart = addDays(today, -DAILY_BAR_HISTORY_DAYS);
    let fullFetches = 0;
    let overlapFetches = 0;
    for (const id of listed.targets) {
      const range = getPricedDailyBarRange(db, id);
      if (!range || range.latest < windowStart || range.earliest > floor) fullFetches++;
      else overlapFetches++;
    }
    const requests = fullFetches + overlapFetches;
    const maxRequests = requests + overlapFetches;
    const totalChanges = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const summary: BackfillDryRunSummary = {
      today,
      targets: listed.targets.length,
      foreignSession: listed.foreignSession,
      noContractId: listed.noContractId,
      mutualFund: listed.mutualFund,
      bondFund: listed.bondFund,
      fullFetches,
      overlapFetches,
      requests,
      maxRequests,
      minutes: minutesFor(requests),
      maxMinutes: minutesFor(maxRequests),
      totalChanges,
    };
    log(`DRY RUN (nothing written), Eastern day ${today}`);
    log(`  targets: ${summary.targets} (${fullFetches} need two full years, ${overlapFetches} need an overlap refresh)`);
    log(
      `  left out: ${summary.foreignSession} not on the US session, ${summary.noContractId} with no contract id, ` +
        `${summary.mutualFund} mutual funds (no TRADES bars), ${summary.bondFund} bond funds (fixed beta)`,
    );
    log(
      `  requests: ${requests} (up to ${maxRequests} if every overlap finds a basis change), ` +
        `about ${summary.minutes} min (up to ${summary.maxMinutes} min) at ${REQUESTS_PER_WINDOW} per ${WINDOW_MINUTES} minutes`,
    );
    log("  Run with --apply to fetch (quit the app first; run under the coordination tws lock).");
    return summary;
  } finally {
    db.close();
  }
}

export interface BackfillApplyDeps {
  log?: (line: string) => void;
  /** True when anything answers on 127.0.0.1:`port`. */
  portAnswers?: (port: number) => Promise<boolean>;
  makeBackup?: (db: Database.Database, purpose: string) => Promise<unknown>;
  /** Connect TWS as `clientId`; true when connected. */
  connect?: (clientId: number) => Promise<boolean>;
  disconnect?: () => void | Promise<void>;
  fetch?: typeof fetchOhlcvBars;
  today?: string;
  /** Defaults to no cap. */
  maxSecurities?: number;
}

export async function runBackfillApply(dbPath: string, deps: BackfillApplyDeps = {}): Promise<DailyBarCaptureResult> {
  const APP_HOST = "127.0.0.1";
  /** The installed app, and `npm run dev`. */
  const APP_PORTS = [3099, 3000];
  const TWS_CLIENT_ID = 1;
  const log = deps.log ?? console.log;
  const portAnswers =
    deps.portAnswers ??
    (async (port: number) => {
      const net = await import("node:net");
      return new Promise<boolean>((resolve) => {
        const sock = net.createConnection({ host: APP_HOST, port });
        const done = (answer: boolean) => {
          sock.destroy();
          resolve(answer);
        };
        sock.setTimeout(1_000, () => done(false));
        sock.once("connect", () => done(true));
        sock.once("error", () => done(false));
      });
    });
  const makeBackup =
    deps.makeBackup ??
    (async (db: Database.Database, purpose: string) => {
      const { takeBackup } = await import("@/lib/backup/take-backup");
      return takeBackup(db, { purpose, script: "backfill-daily-bars.ts" });
    });
  const connect =
    deps.connect ??
    (async (clientId: number) => {
      const { connectTws, getIbApi } = await import("@/lib/tws/client");
      await connectTws({ clientId });
      return getIbApi() != null;
    });
  const disconnect =
    deps.disconnect ??
    (async () => {
      const { disconnectTws } = await import("@/lib/tws/client");
      disconnectTws();
    });

  for (const port of APP_PORTS) {
    if (await portAnswers(port)) {
      throw new Error(`Something answers on ${APP_HOST}:${port}. Quit the app first. Nothing written.`);
    }
  }

  const db = new Database(dbPath, { fileMustExist: true, timeout: 60_000 });
  db.pragma("foreign_keys = ON");
  try {
    await makeBackup(db, "daily-bar-backfill");
    log("Backup taken.");
    if (!(await connect(TWS_CLIENT_ID))) {
      throw new Error(`Could not connect to TWS as client id ${TWS_CLIENT_ID}. Is Trader Workstation running?`);
    }
    try {
      log("TWS connected. Capturing (paced by the shared limiter)...");
      const result = await runDailyBarCapture(db, {
        today: deps.today,
        ignoreBatchWindow: true,
        maxSecurities: deps.maxSecurities ?? Number.POSITIVE_INFINITY,
        fetch: deps.fetch,
      });
      log(
        `Done: ${result.written}/${result.attempted} captured, ${result.fullRefetches} full fetches, ` +
          `${result.basisChanges} basis changes, ${result.exhausted} with under two years of history, ` +
          `${result.failed} failed, ${result.staleOlderBarsDeleted} older old-basis bars deleted, ` +
          `${result.foreignSession} not on the US session, ${result.noContractId} with no contract id, ` +
          `${result.mutualFund} mutual funds and ${result.bondFund} bond funds left out` +
          (result.skippedReason ? ` (skipped: ${result.skippedReason})` : ""),
      );
      return result;
    } finally {
      await disconnect();
    }
  } finally {
    db.close();
  }
}

export interface BackfillCliIo {
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Injected into the apply path (tests). */
  apply?: BackfillApplyDeps;
}

/** The command line: prints the database path first, then runs the dry run or the apply. Returns the exit code. */
export async function runBackfillCli(argv: string[], env: EnvLike, io: BackfillCliIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const resolved = resolveBackfillDbPath(argv, env);
  log(`[backfill-daily-bars] db: ${resolved.path}${resolved.explicit ? "" : " (the app default)"}`);
  try {
    if (argv.includes("--apply")) {
      if (!resolved.explicit) {
        error("--apply needs the database named explicitly: pass --db <path> or set BACKFILL_DB_PATH. Nothing written.");
        return 1;
      }
      await runBackfillApply(resolved.path, { log, ...io.apply });
      return 0;
    }
    runBackfillDryRun(resolved.path, { log });
    return 0;
  } catch (err) {
    error(`[backfill-daily-bars] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const isMain =
  typeof process !== "undefined" && process.argv[1] != null && /backfill-daily-bars\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  void runBackfillCli(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
