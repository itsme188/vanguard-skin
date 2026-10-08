/**
 * Dry-run-default repair for option holdings that are still the "latest" row
 * of their (account, security) pair after the contract expired (user ruling
 * 2026-10-06, fifth batch: expired options leave the counts by expiry date at
 * read time; this user-run script retires the rows afterwards).
 *
 * WHAT IT WRITES (only with --apply AND --acknowledge-repair): one
 * `quantity = 0` tombstone per retirable pair, dated at the account's newest
 * real holdings snapshot, keyed exactly like the reconciler's live-pass
 * tombstone (`recon:closed-equity:<account>:<security>:<date>:live`).
 *
 * WHAT IT NEVER DOES:
 *  - delete or change an existing holdings row (statement rows stay as the
 *    audit trail — unlike `purgeExpiredOptionHoldings`, an unscoped delete);
 *  - write a statement-grade (`:stmt`) tombstone, touch `tax_lots`,
 *    `transactions` or `tax_input_generation`, or mint a closing entry. A
 *    `:live` tombstone is not a tax input (spec 2026-10-02 statement-only
 *    synthetic closes), and the contract's real outcome (expired, assigned,
 *    exercised) is still transcribed from the broker statement.
 *
 * A pair is SKIPPED (reported, never written) when the account has no
 * snapshot dated after both the stale row and the expiration day: retiring it
 * would need to overwrite the row's own slot, or would mark the contract flat
 * before it expired.
 *
 * Prints ids, OCC symbols and dates only — never a quantity, price or value.
 *
 * Usage (from the repo root; rehearse on a copy first):
 *   REPAIR_DB_PATH=/tmp/rehearsal.db npx tsx scripts/retire-expired-option-holdings.ts
 *   REPAIR_DB_PATH=/tmp/rehearsal.db npx tsx scripts/retire-expired-option-holdings.ts --apply --acknowledge-repair
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { todayET } from "@/lib/calendar/date-utils";
import {
  isOptionLive,
  liveOptionExpirationSql,
  normalizeOptionExpiration,
} from "@/lib/compute/option-expiry";
import {
  RECON_HOLDING_SOURCE_PREFIX,
  RECON_LIVE_SUFFIX,
  classifyHoldingSourceKey,
} from "@/lib/db/holding-sources";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

const DB_PATH = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
const ACK_FLAG = "--acknowledge-repair";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ExpiredOptionSkipReason =
  /** The stale row sits on the account's newest snapshot date — its slot is taken. */
  | "no_newer_snapshot"
  /** The account's newest snapshot is not after the expiration day. */
  | "no_snapshot_after_expiry";

export interface ExpiredOptionHolding {
  holdingId: number;
  accountId: number;
  securityId: number;
  symbol: string;
  /** Dashed `YYYY-MM-DD`, whatever spelling is stored. */
  expiration: string;
  heldAsOf: string;
  sourceClass: "statement" | "live";
  /** Tombstone date when retirable, else null. */
  retireDate: string | null;
  skipReason: ExpiredOptionSkipReason | null;
}

export interface ExpiredOptionGroup {
  accountId: number;
  sourceClass: "statement" | "live";
  expired: number;
  retirable: number;
  skipped: number;
}

export interface ExpiredOptionPlan {
  today: string;
  rows: ExpiredOptionHolding[];
  groups: ExpiredOptionGroup[];
}

interface CandidateRow {
  holding_id: number;
  account_id: number;
  security_id: number;
  symbol: string;
  expiration_date: string;
  as_of_date: string;
  source_key: string | null;
}

/**
 * Latest non-zero holdings rows whose option is past expiration as of `today`
 * (ET). The expiration is compared ONLY through `liveOptionExpirationSql`
 * (legacy compact `YYYYMMDD` rows are normalized there); a contract expiring
 * today is still live and is not listed.
 */
export function planExpiredOptionHoldings(
  db: Database.Database,
  today: string = todayET(),
): ExpiredOptionPlan {
  const candidates = db
    .prepare(
      `SELECT h.id AS holding_id, h.account_id, h.security_id, s.symbol,
              s.expiration_date, h.as_of_date, h.source_key
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE ${latestHoldingsPredicate()}
          AND LOWER(COALESCE(s.security_type, '')) = 'option'
          AND s.expiration_date IS NOT NULL
          AND NOT ${liveOptionExpirationSql("s", today)}
        ORDER BY h.account_id, s.symbol, h.id`,
    )
    .all() as CandidateRow[];

  // Newest REAL snapshot date of the account: tombstones are derived rows and
  // prove nothing about what a source reported, so they never set the date.
  const newestSnapshotStmt = db.prepare(
    `SELECT h.as_of_date AS d FROM holdings h
      WHERE h.account_id = ?
        AND COALESCE(h.source_key, '') NOT LIKE '${RECON_HOLDING_SOURCE_PREFIX}%'
      ORDER BY h.as_of_date DESC LIMIT 1`,
  );
  const newestByAccount = new Map<number, string | null>();
  const newestSnapshot = (accountId: number): string | null => {
    if (!newestByAccount.has(accountId)) {
      const row = newestSnapshotStmt.get(accountId) as { d: string } | undefined;
      newestByAccount.set(accountId, row?.d ?? null);
    }
    return newestByAccount.get(accountId) ?? null;
  };

  const rows: ExpiredOptionHolding[] = [];
  for (const c of candidates) {
    const expiration = normalizeOptionExpiration(c.expiration_date);
    // Belt and braces: the JS twin must agree with the SQL predicate, and an
    // expiration that is not a readable date is never treated as expired.
    if (!DATE_PATTERN.test(expiration) || isOptionLive(c.expiration_date, today)) continue;

    const newest = newestSnapshot(c.account_id);
    let retireDate: string | null = null;
    let skipReason: ExpiredOptionSkipReason | null = null;
    if (newest == null || newest <= c.as_of_date) skipReason = "no_newer_snapshot";
    else if (newest <= expiration) skipReason = "no_snapshot_after_expiry";
    else retireDate = newest;

    rows.push({
      holdingId: c.holding_id,
      accountId: c.account_id,
      securityId: c.security_id,
      symbol: c.symbol,
      expiration,
      heldAsOf: c.as_of_date,
      sourceClass: classifyHoldingSourceKey(c.source_key),
      retireDate,
      skipReason,
    });
  }

  const groups = new Map<string, ExpiredOptionGroup>();
  for (const r of rows) {
    const key = `${r.accountId}:${r.sourceClass}`;
    const g = groups.get(key) ?? {
      accountId: r.accountId,
      sourceClass: r.sourceClass,
      expired: 0,
      retirable: 0,
      skipped: 0,
    };
    g.expired += 1;
    if (r.retireDate) g.retirable += 1;
    else g.skipped += 1;
    groups.set(key, g);
  }

  return { today, rows, groups: [...groups.values()] };
}

/**
 * Dry run unless `apply` is set. Applying inserts one `:live` tombstone per
 * retirable pair inside a single transaction and changes nothing else.
 */
export function runExpiredOptionRetirement(
  db: Database.Database,
  opts: { apply?: boolean; today?: string } = {},
): { plan: ExpiredOptionPlan; applied: boolean; tombstones: number } {
  const today = opts.today ?? todayET();
  if (!opts.apply) return { plan: planExpiredOptionHoldings(db, today), applied: false, tombstones: 0 };

  return db.transaction(() => {
    const plan = planExpiredOptionHoldings(db, today);
    const insert = db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key, import_batch_id)
       VALUES (?, ?, 0, 0, ?, ?, NULL)`,
    );
    let tombstones = 0;
    for (const r of plan.rows) {
      if (!r.retireDate) continue;
      tombstones += insert.run(
        r.accountId,
        r.securityId,
        r.retireDate,
        `${RECON_HOLDING_SOURCE_PREFIX}${r.accountId}:${r.securityId}:${r.retireDate}${RECON_LIVE_SUFFIX}`,
      ).changes;
    }
    const expected = plan.rows.filter((r) => r.retireDate).length;
    if (tombstones !== expected) {
      throw new Error(`expected to write ${expected} tombstone(s), wrote ${tombstones}; rolled back`);
    }
    return { plan, applied: true, tombstones };
  })();
}

const SKIP_COPY: Record<ExpiredOptionSkipReason, string> = {
  no_newer_snapshot: "left alone: it is on the account's newest snapshot (needs a newer snapshot or statement)",
  no_snapshot_after_expiry: "left alone: the account has no snapshot dated after the expiration day",
};

/** Report lines: ids, OCC symbols and dates only — never a quantity, price or value. */
export function formatExpiredOptionReport(result: {
  plan: ExpiredOptionPlan;
  applied: boolean;
  tombstones: number;
}): string[] {
  const { plan } = result;
  const lines = [`Expired as of ${plan.today} (Eastern). A contract expiring today is still live.`];
  if (plan.rows.length === 0) {
    lines.push("No latest holdings row is for an option past expiration.");
    return lines;
  }
  for (const g of plan.groups) {
    lines.push(
      `Account ${g.accountId}, ${g.sourceClass} rows: ${g.expired} expired ` +
        `(${g.retirable} ${result.applied ? "retired" : "would be retired"}, ${g.skipped} left alone)`,
    );
    for (const r of plan.rows) {
      if (r.accountId !== g.accountId || r.sourceClass !== g.sourceClass) continue;
      const action = r.retireDate
        ? `${result.applied ? "zero row written" : "would write a zero row"} at ${r.retireDate}`
        : SKIP_COPY[r.skipReason as ExpiredOptionSkipReason];
      lines.push(`  holding ${r.holdingId}  ${r.symbol}  expired ${r.expiration}  held as of ${r.heldAsOf}  ${action}`);
    }
  }
  lines.push(
    result.applied
      ? `Wrote ${result.tombstones} zero row(s). No existing row, tax lot or transaction was changed.`
      : `Dry run (default). Re-run with --apply ${ACK_FLAG} on a rehearsed copy to write.`,
  );
  return lines;
}

function main() {
  const apply = process.argv.includes("--apply");
  if (apply && !process.argv.includes(ACK_FLAG)) {
    throw new Error(
      `Refusing to write without ${ACK_FLAG}. Dry-run is the default; rehearse on a REPAIR_DB_PATH copy first.`,
    );
  }
  const db = new BetterSqlite3(DB_PATH, { readonly: !apply, timeout: 60_000 });
  try {
    if (apply) db.pragma("foreign_keys = ON");
    for (const line of formatExpiredOptionReport(runExpiredOptionRetirement(db, { apply }))) console.log(line);
  } finally {
    db.close();
  }
}

if (process.argv[1]?.includes("retire-expired-option-holdings")) main();
