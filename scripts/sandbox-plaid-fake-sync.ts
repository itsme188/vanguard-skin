/**
 * SANDBOX ONLY. Runs the real Plaid refresh against a sandbox copy of the
 * database with a FAKE Plaid client, so the browser check can see a
 * successful sync without touching Plaid.
 *
 * It refuses unless the database is a sandbox copy: not the owner's live
 * database, and the file sits under a worktree's `data/` folder
 * (`.../.claude/worktrees/<name>/data/`) or under a folder named with
 * `--sandbox-root <dir>`. A path inside the main checkout's `data/` is always
 * refused.
 *
 * The fake answer is built from the copy's own newest holdings, so the mapper
 * matches the same securities. Output is counts and names only, never a
 * dollar figure.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/sandbox-plaid-fake-sync.ts --db <copy.db> --scenario success
 *   scenarios: success | replace | partial | valuation-fail
 *   options:   --now <ISO>  --force  --sandbox-root <dir>
 * The database path also comes from DATABASE_PATH when --db is not given.
 */

import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { isLiveDatabase, resolveLiveDbPath } from "../lib/backup/backup-home";
import { isMarketClosed, previousTradingDay } from "../lib/calendar/market-holidays";
import { nowET, todayET } from "../lib/calendar/date-utils";
import { refreshVanguardHoldingsFromPlaid, type PlaidRefreshResult } from "../lib/plaid/refresh";
import { getPlaidConnection } from "../lib/queries/plaid-settings";
import { latestHoldingsPredicate } from "../lib/queries/latest-holdings";
import { isCashEquivalentSecurity } from "../lib/compute/cash-equivalents";
import type { PlaidHoldingsResponse, PlaidHolding, PlaidSecurity, PlaidAccount } from "../lib/plaid/client";
import type { EnvLike } from "../lib/db/db-path";

export const SCENARIOS = ["success", "replace", "partial", "valuation-fail"] as const;
export type SandboxScenario = (typeof SCENARIOS)[number];

/** The main checkout's data folder: always refused, whatever the flags. */
const MAIN_CHECKOUT_DATA_DIR = "/Users/Yitzi/code/vanguard-skin/data/";

export interface SandboxFakeSyncOutcome {
  scenario: SandboxScenario;
  now: Date;
  result: PlaidRefreshResult | null;
  newFormatHoldingRows: number;
  plaidSnapshotsOnSession: number;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function realOrResolved(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Throws a plain message unless `dbPath` is a sandbox copy. Exported for tests.
 */
export function assertSandboxDatabase(
  dbPath: string,
  opts: { sandboxRoot?: string; env?: EnvLike } = {},
): void {
  const env = opts.env ?? process.env;
  const resolved = path.resolve(dbPath);
  const real = realOrResolved(dbPath);

  const mainDirs = [MAIN_CHECKOUT_DATA_DIR];
  // The main checkout is found from this file's own place, never from env.
  const live = resolveLiveDbPath({});
  if (live) mainDirs.push(path.dirname(live) + path.sep);
  for (const dir of mainDirs) {
    const d = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (resolved.startsWith(d) || real.startsWith(d)) {
      throw new Error(`Refused: ${resolved} is inside the main checkout's data folder.`);
    }
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Refused: ${resolved} does not exist (this script never creates a database).`);
  }
  if (isLiveDatabase(resolved, env)) {
    throw new Error(`Refused: ${resolved} is the owner's live database.`);
  }
  const inWorktreeData = /(^|\/)\.claude\/worktrees\/[^/]+\/data\//.test(real) ||
    /(^|\/)\.claude\/worktrees\/[^/]+\/data\//.test(resolved);
  const inNamedRoot =
    opts.sandboxRoot !== undefined &&
    (isInside(real, realOrResolved(opts.sandboxRoot)) || isInside(resolved, path.resolve(opts.sandboxRoot)));
  if (!inWorktreeData && !inNamedRoot) {
    throw new Error(
      `Refused: ${resolved} is not under a worktree's data/ folder or a --sandbox-root folder.`,
    );
  }
}

/** The most recent trading day at 07:35 Eastern, as an instant. */
export function defaultSandboxNow(from: Date = new Date()): Date {
  let day = todayET(from);
  if (isMarketClosed(day) || nowET(from) < "07:35") day = previousTradingDay(day);
  return easternInstant(day, "07:35");
}

/** A date and an Eastern wall-clock time ("HH:MM") as an instant. */
export function easternInstant(day: string, hhmm: string): Date {
  for (const offset of ["-04:00", "-05:00"]) {
    const d = new Date(`${day}T${hhmm}:00${offset}`);
    if (todayET(d) === day && nowET(d) === hhmm) return d;
  }
  throw new Error(`Cannot place ${day} ${hhmm} on the Eastern clock.`);
}

interface HeldRow {
  security_id: number;
  symbol: string;
  security_type: string | null;
  fund_category: string | null;
  quantity: number;
}

const PLAID_TYPE_BY_SECURITY_TYPE: Record<string, string> = {
  stock: "equity",
  etf: "etf",
  "mutual fund": "mutual fund",
};

/** Builds the fake Plaid answer from each mapped account's newest holdings. */
export function buildFakeAnswer(
  db: Database.Database,
  accountMap: Record<string, number>,
  opts: { dropPlaidAccount?: string; addShareTo?: { plaidAccountId: string; symbol: string } } = {},
): { response: PlaidHoldingsResponse; counts: { accounts: number; positions: number; leftOut: number } } {
  const accounts: PlaidAccount[] = [];
  const holdings: PlaidHolding[] = [];
  const securities = new Map<string, PlaidSecurity>();
  let positions = 0;
  let leftOut = 0;

  const held = db.prepare(
    `SELECT h.security_id, s.symbol, s.security_type, s.fund_category, h.quantity
       FROM holdings h JOIN securities s ON s.id = h.security_id
      WHERE ${latestHoldingsPredicate({ accountFilter: "AND h.account_id = ?" })}
      ORDER BY s.symbol`,
  );
  const latestPrice = db.prepare(
    `SELECT close_price FROM prices WHERE security_id = ? ORDER BY date DESC LIMIT 1`,
  );

  for (const [plaidAccountId, localId] of Object.entries(accountMap)) {
    if (plaidAccountId === opts.dropPlaidAccount) continue;
    let total = 0;
    for (const row of held.all(localId) as HeldRow[]) {
      const kind = PLAID_TYPE_BY_SECURITY_TYPE[(row.security_type ?? "").toLowerCase()];
      const isCash = isCashEquivalentSecurity({
        security_type: row.security_type,
        fund_category: row.fund_category,
      });
      if (!kind && !isCash) {
        leftOut += 1; // options and bonds: Plaid prices for them are not used
        continue;
      }
      const price = (latestPrice.get(row.security_id) as { close_price: number } | undefined)?.close_price ?? 1;
      let quantity = row.quantity;
      if (
        opts.addShareTo &&
        opts.addShareTo.plaidAccountId === plaidAccountId &&
        opts.addShareTo.symbol === row.symbol
      ) {
        quantity += 1;
      }
      const secId = `sec-${row.security_id}`;
      securities.set(secId, {
        security_id: secId,
        ticker_symbol: row.symbol,
        cusip: null,
        name: row.symbol,
        type: kind ?? "mutual fund",
        is_cash_equivalent: isCash,
      });
      const value = quantity * price;
      total += value;
      holdings.push({
        account_id: plaidAccountId,
        security_id: secId,
        quantity,
        institution_price: price,
        institution_value: value,
        institution_price_as_of: null,
      });
      positions += 1;
    }
    // A synthetic cash balance (Plaid's generic cash line).
    const cashId = `cash-${plaidAccountId}`;
    securities.set(cashId, {
      security_id: cashId,
      ticker_symbol: null,
      cusip: null,
      name: "Cash",
      type: "cash",
      is_cash_equivalent: true,
    });
    holdings.push({
      account_id: plaidAccountId,
      security_id: cashId,
      quantity: 1000,
      institution_price: 1,
      institution_value: 1000,
      institution_price_as_of: null,
    });
    total += 1000;
    accounts.push({
      account_id: plaidAccountId,
      name: `Sandbox ${plaidAccountId}`,
      mask: null,
      subtype: "brokerage",
      balances: { current: total, available: null },
    });
  }
  return {
    response: { accounts, holdings, securities: [...securities.values()] },
    counts: { accounts: accounts.length, positions, leftOut },
  };
}

/** Temp triggers (this connection only, nothing stored) make the recompute throw. */
function breakValuationRecompute(db: Database.Database): void {
  const msg = "sandbox: forced valuation failure";
  db.exec(
    `CREATE TEMP TRIGGER sandbox_fail_valuation_insert BEFORE INSERT ON main.daily_valuations
       BEGIN SELECT RAISE(ABORT, '${msg}'); END;
     CREATE TEMP TRIGGER sandbox_fail_valuation_delete BEFORE DELETE ON main.daily_valuations
       BEGIN SELECT RAISE(ABORT, '${msg}'); END;`,
  );
}

export async function runSandboxFakeSync(
  db: Database.Database,
  scenario: SandboxScenario,
  opts: { now: Date; force?: boolean },
): Promise<SandboxFakeSyncOutcome> {
  const conn = getPlaidConnection(db);
  if (!conn.accessToken || Object.keys(conn.accountMap).length === 0) {
    throw new Error("Refused: this database has no Plaid connection (token and account map). Nothing to drive.");
  }
  const plaidIds = Object.keys(conn.accountMap);
  let answer = buildFakeAnswer(db, conn.accountMap);
  if (scenario === "partial") {
    answer = buildFakeAnswer(db, conn.accountMap, { dropPlaidAccount: plaidIds[0] });
  } else if (scenario === "replace") {
    const first = answer.response.holdings.find((h) => {
      const sec = answer.response.securities.find((s) => s.security_id === h.security_id);
      return sec?.type !== "cash" && sec?.ticker_symbol;
    });
    const sec = answer.response.securities.find((s) => s.security_id === first?.security_id);
    if (!first || !sec?.ticker_symbol) throw new Error("Refused: no ordinary position to change for the replace run.");
    answer = buildFakeAnswer(db, conn.accountMap, {
      addShareTo: { plaidAccountId: first.account_id, symbol: sec.ticker_symbol },
    });
  }
  console.log(
    `[sandbox] fake answer: ${answer.counts.accounts} account(s), ${answer.counts.positions} position(s), ` +
      `${answer.counts.leftOut} option/bond line(s) left out`,
  );

  if (scenario === "valuation-fail") breakValuationRecompute(db);
  let result: PlaidRefreshResult | null;
  try {
    result = await refreshVanguardHoldingsFromPlaid(db, {
      now: opts.now,
      force: opts.force ?? scenario === "replace",
      fetchHoldings: async () => answer.response,
    });
  } finally {
    if (scenario === "valuation-fail") {
      db.exec(`DROP TRIGGER IF EXISTS temp.sandbox_fail_valuation_insert;
               DROP TRIGGER IF EXISTS temp.sandbox_fail_valuation_delete;`);
    }
  }

  const session = result?.session ?? null;
  const newFormatHoldingRows = (
    db.prepare(`SELECT COUNT(*) AS n FROM holdings WHERE source_key LIKE 'plaid:s:%'`).get() as { n: number }
  ).n;
  const plaidSnapshotsOnSession = session
    ? (
        db
          .prepare(`SELECT COUNT(*) AS n FROM monthly_snapshots WHERE source = 'plaid' AND month_end_date = ?`)
          .get(session) as { n: number }
      ).n
    : 0;
  return { scenario, now: opts.now, result, newFormatHoldingRows, plaidSnapshotsOnSession };
}

function printOutcome(o: SandboxFakeSyncOutcome): void {
  const r = o.result;
  console.log(`[sandbox] scenario=${o.scenario}, clock=${o.now.toISOString()}`);
  if (!r) {
    console.log("[sandbox] the refresh returned null (not configured, not connected, or a sync is running)");
  } else {
    console.log(`skippedReason: ${r.skippedReason ?? "none"}`);
    console.log(`session: ${r.session ?? "none"}`);
    console.log(`datingState: ${r.datingState}`);
    console.log(
      `stored accounts: ${r.storedAccounts.map((a) => a.accountName).join(", ") || "none"}`,
    );
    console.log(
      `skipped accounts: ${r.skippedAccounts.map((a) => `${a.accountName} (${a.reason})`).join(", ") || "none"}`,
    );
    console.log(`valuationsRecomputed: ${r.valuationsRecomputed}${r.valuationError ? ` (${r.valuationError})` : ""}`);
  }
  console.log(`plaid:s: holdings rows: ${o.newFormatHoldingRows}`);
  console.log(`plaid snapshots dated on the session: ${o.plaidSnapshotsOnSession}`);
}

/** The whole script, callable in-process (tests). Throws on a refusal. */
export async function main(
  argv: string[],
  env: EnvLike = process.env,
): Promise<SandboxFakeSyncOutcome> {
  const dbPath = flagValue(argv, "--db") ?? env.DATABASE_PATH;
  if (!dbPath) throw new Error("Give the sandbox database with --db <path> or DATABASE_PATH.");
  // Printed BEFORE anything is opened or checked further.
  console.log(`[sandbox-plaid-fake-sync] db: ${path.resolve(dbPath)}`);

  const scenario = flagValue(argv, "--scenario") as SandboxScenario | undefined;
  if (!scenario || !SCENARIOS.includes(scenario)) {
    throw new Error(`Give --scenario one of: ${SCENARIOS.join(", ")}.`);
  }
  assertSandboxDatabase(dbPath, { sandboxRoot: flagValue(argv, "--sandbox-root"), env });

  const nowFlag = flagValue(argv, "--now");
  let now: Date;
  if (nowFlag) {
    now = new Date(nowFlag);
    if (Number.isNaN(now.getTime())) throw new Error(`--now is not a date: ${nowFlag}`);
  } else {
    const base = defaultSandboxNow();
    now = scenario === "replace" ? easternInstant(todayET(base), "08:00") : base;
  }

  const db = new BetterSqlite3(path.resolve(dbPath), { fileMustExist: true, timeout: 60_000 });
  db.pragma("foreign_keys = ON");
  try {
    const outcome = await runSandboxFakeSync(db, scenario, { now, force: argv.includes("--force") || undefined });
    printOutcome(outcome);
    return outcome;
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith("sandbox-plaid-fake-sync.ts")) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
