/**
 * audit-ibkr-ledger-vs-broker.ts
 *
 * Acceptance gate for the IBKR ledger rebuild (2026-08-03 audit,
 * docs/superpowers/plans/2026-08-03-ibkr-ledger-rebuild.md): reconstructs
 * each IBKR security's position from the transactions ledger and compares it
 * against broker-reported holdings rows. The 2026-08-03 audit that motivated
 * the whole rebuild (QQQ off by ~700 shares, an incomplete canonical batch)
 * used exactly this math by hand — this script makes it repeatable and
 * exit-code-gateable.
 *
 * Position math mirrors `computeTaxLots` (lib/compute/tax-lots.ts) EXACTLY —
 * this script verifies what the tax-lot engine will see, not raw economic
 * long/short direction. That means SELL_TO_OPEN is lot-CREATING (mirrors the
 * engine's `is_short` bookkeeping) even though it's a short position, and
 * RECONCILE_CLOSE (the engine's own synthetic close) is deliberately absent
 * from BOTH type lists below so it's ignored without an extra filter.
 *
 * Same-day ambiguity: a TWS-sourced holdings row is captured intraday, so a
 * broker row dated the same day as a trade can't be assumed to have been
 * taken before OR after that day's fills. A (symbol, date) pair counts as
 * clean if EITHER including or excluding that day's trades reconciles with
 * the broker-reported quantity (the audit's AAL false-positive — a broker
 * row that looked "wrong" was actually captured mid-cover).
 *
 * Evaluation points per (IBKR, security) pair with >=1 broker holdings row:
 * the LATEST broker row, plus the row nearest 2026-06-30 (the last date with
 * full statement coverage across every account as of the 2026-08-03 audit).
 *
 * CLI usage:
 *   npx tsx scripts/audit-ibkr-ledger-vs-broker.ts                (all broker rows)
 *   npx tsx scripts/audit-ibkr-ledger-vs-broker.ts --as-of 2026-07-31   (tolerate later lag)
 *
 * Exit 0: every evaluated pair reconciles (or nothing to evaluate).
 * Exit 1: at least one (symbol, date) pair is gapped.
 */

import type Database from "better-sqlite3";

// ─── Config ────────────────────────────────────────────────────────

/** Below this absolute gap, a pair is considered reconciled (floating-point
 * noise from summing many fills, not a real discrepancy). */
const GAP_TOLERANCE = 1e-6;

/** Last date with full statement coverage across every account as of the
 * 2026-08-03 audit — the second mandatory evaluation point alongside the
 * latest broker row. NOT meant to be edited casually; if this needs to move
 * forward as later statements land, that's a deliberate call, not a
 * mechanical bump (Task 7's runbook decides). */
const FULL_COVERAGE_DATE = "2026-06-30";

/**
 * Position-increasing transaction types, LOWER(type)-compared — copied
 * VERBATIM from `computeTaxLots`'s buy list (lib/compute/tax-lots.ts:79).
 * SELL_TO_OPEN counts as lot-CREATING in the engine (it opens a tax lot
 * flagged `is_short`), so it belongs here even though it's economically a
 * short — this script mirrors what the engine will see, not raw direction.
 */
const BUY_TYPES = [
  "buy",
  "reinvestment",
  "buy_to_open",
  "sell_to_open",
  "transfer_in",
] as const;

/**
 * Position-decreasing transaction types — copied VERBATIM from
 * `computeTaxLots`'s sell list (lib/compute/tax-lots.ts:127-129).
 * `RECONCILE_CLOSE` (the engine's own synthetic close transaction,
 * LOWER(type) = 'reconcile_close') is deliberately absent from this list —
 * it's engine-owned and must never be treated as real broker activity, so
 * omitting it here is sufficient to ignore it, no extra filter needed.
 */
const SELL_TYPES = [
  "sell",
  "sell_to_close",
  "redemption",
  "buy_to_cover",
  "expired",
  "exercised",
  "assigned",
  "buy_to_close",
] as const;

// ─── Types ─────────────────────────────────────────────────────────

export interface AuditLedgerOptions {
  /** Restricts which broker holdings rows are considered (both for picking
   * "latest" and "nearest to 2026-06-30") to `as_of_date <= asOf`. Lets a
   * gate run tolerate lag since the last imported statement (e.g. August
   * trades before the August statement lands) without failing on rows the
   * ledger genuinely hasn't caught up to yet. Validated YYYY-MM-DD. */
  asOf?: string;
}

export interface AuditGapRow {
  symbol: string;
  date: string;
  broker: number;
  ledger: number;
  gap: number;
}

export interface AuditResult {
  pairs: number;
  clean: number;
  gapped: AuditGapRow[];
}

interface BrokerHoldingRow {
  security_id: number;
  symbol: string;
  quantity: number;
  as_of_date: string;
}

const AS_OF_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ─── Core ──────────────────────────────────────────────────────────

/** Resolves the IBKR account id the same way the rest of the app does —
 * name-contains-"ibkr", case-insensitive (mirrors lib/chat/ibkr-context.ts
 * and lib/trade-review/questions.ts) rather than an exact-match on 'IBKR',
 * so a differently-cased or -suffixed account name still resolves. */
function resolveIbkrAccountId(db: Database.Database): number | null {
  const accounts = db.prepare("SELECT id, name FROM accounts").all() as Array<{
    id: number;
    name: string;
  }>;
  const ibkr = accounts.find((a) => a.name.toLowerCase().includes("ibkr"));
  return ibkr ? ibkr.id : null;
}

/**
 * Broker-reported holdings rows for the IBKR account: TWS live-sync rows
 * (`tws-%`) or native ibkr-activity statement rows (`ibkr:%`) — EXCLUDING
 * `recon:%` (engine-synthesized closed-equity tombstones, not broker data)
 * and `plaid:%` (a different broker's connector; never applies to the IBKR
 * account in practice, excluded anyway per the brief for defense-in-depth).
 */
function getBrokerHoldingsRows(
  db: Database.Database,
  accountId: number,
  asOf?: string
): BrokerHoldingRow[] {
  const asOfClause = asOf ? "AND h.as_of_date <= ?" : "";
  const sql = `
    SELECT h.security_id AS security_id, s.symbol AS symbol,
           h.quantity AS quantity, h.as_of_date AS as_of_date
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
     WHERE h.account_id = ?
       AND (h.source_key LIKE 'tws-%' OR h.source_key LIKE 'ibkr:%')
       AND h.source_key NOT LIKE 'recon:%'
       AND h.source_key NOT LIKE 'plaid:%'
       ${asOfClause}
     ORDER BY h.security_id, h.as_of_date
  `;
  const params = asOf ? [accountId, asOf] : [accountId];
  return db.prepare(sql).all(...params) as BrokerHoldingRow[];
}

/**
 * Ledger-reconstructed position for one (account, security) as of `asOfDate`
 * — sum of buy-list quantities minus sum of sell-list quantities, mirroring
 * how `computeTaxLots` would net out `tax_lots.quantity_remaining` for this
 * pair. `inclusive` controls whether trades ON `asOfDate` itself count
 * (`<=`) or not (`<`) — the two calls this feeds the same-day ambiguity
 * check.
 */
function computeLedgerQty(
  db: Database.Database,
  accountId: number,
  securityId: number,
  asOfDate: string,
  inclusive: boolean
): number {
  const cmp = inclusive ? "<=" : "<";
  const buyPlaceholders = BUY_TYPES.map(() => "?").join(",");
  const sellPlaceholders = SELL_TYPES.map(() => "?").join(",");

  const buyQty = (
    db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS q FROM transactions
          WHERE account_id = ? AND security_id = ? AND trade_date ${cmp} ?
            AND LOWER(type) IN (${buyPlaceholders})`
      )
      .get(accountId, securityId, asOfDate, ...BUY_TYPES) as { q: number }
  ).q;

  const sellQty = (
    db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS q FROM transactions
          WHERE account_id = ? AND security_id = ? AND trade_date ${cmp} ?
            AND LOWER(type) IN (${sellPlaceholders})`
      )
      .get(accountId, securityId, asOfDate, ...SELL_TYPES) as { q: number }
  ).q;

  return buyQty - sellQty;
}

/** Absolute calendar-day distance between two YYYY-MM-DD dates. */
function daysApart(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00Z`).getTime();
  const tb = new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(Math.round((tb - ta) / (1000 * 60 * 60 * 24)));
}

/**
 * Reconstructs every IBKR position from the ledger and compares it against
 * broker-reported holdings. See file header for the position-math and
 * same-day-ambiguity rules.
 */
export function auditLedgerVsBroker(
  db: Database.Database,
  opts: AuditLedgerOptions = {}
): AuditResult {
  if (opts.asOf !== undefined && !AS_OF_PATTERN.test(opts.asOf)) {
    throw new Error(
      `auditLedgerVsBroker: asOf must match YYYY-MM-DD, got ${JSON.stringify(opts.asOf)}`
    );
  }

  const accountId = resolveIbkrAccountId(db);
  if (accountId === null) {
    return { pairs: 0, clean: 0, gapped: [] };
  }

  const rows = getBrokerHoldingsRows(db, accountId, opts.asOf);

  const bySecurity = new Map<number, { symbol: string; rows: BrokerHoldingRow[] }>();
  for (const row of rows) {
    const entry = bySecurity.get(row.security_id);
    if (entry) entry.rows.push(row);
    else bySecurity.set(row.security_id, { symbol: row.symbol, rows: [row] });
  }

  let pairs = 0;
  let clean = 0;
  const gapped: AuditGapRow[] = [];

  for (const { symbol, rows: secRows } of bySecurity.values()) {
    // Latest broker row (max as_of_date — safe as string compare on
    // YYYY-MM-DD) and the row nearest FULL_COVERAGE_DATE. Ties on "nearest"
    // keep the earlier candidate (secRows is already as_of_date-ascending
    // from the query's ORDER BY) — deterministic, not load-bearing in
    // practice (an exact-tie is vanishingly unlikely).
    const latest = secRows.reduce((a, b) => (b.as_of_date > a.as_of_date ? b : a));
    const nearest = secRows.reduce((a, b) =>
      daysApart(b.as_of_date, FULL_COVERAGE_DATE) < daysApart(a.as_of_date, FULL_COVERAGE_DATE)
        ? b
        : a
    );

    // Dedupe by date: when the security has only one broker row (or latest
    // and nearest happen to be the same row), evaluate it once, not twice.
    const targets = new Map<string, BrokerHoldingRow>();
    targets.set(latest.as_of_date, latest);
    targets.set(nearest.as_of_date, nearest);

    for (const [date, brokerRow] of targets) {
      pairs++;

      const ledgerIncl = computeLedgerQty(db, accountId, brokerRow.security_id, date, true);
      const ledgerExcl = computeLedgerQty(db, accountId, brokerRow.security_id, date, false);
      const gapIncl = brokerRow.quantity - ledgerIncl;
      const gapExcl = brokerRow.quantity - ledgerExcl;

      // Report whichever variant reconciles better — that's the genuine
      // residual once same-day ambiguity is given its benefit of the doubt.
      const useIncl = Math.abs(gapIncl) <= Math.abs(gapExcl);
      const gap = useIncl ? gapIncl : gapExcl;
      const ledger = useIncl ? ledgerIncl : ledgerExcl;

      if (Math.abs(gap) < GAP_TOLERANCE) {
        clean++;
      } else {
        gapped.push({ symbol, date, broker: brokerRow.quantity, ledger, gap });
      }
    }
  }

  gapped.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

  return { pairs, clean, gapped };
}

// ─── CLI entry point ───────────────────────────────────────────────

function parseAsOfArg(argv: string[]): string | undefined {
  const idx = argv.indexOf("--as-of");
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value || !AS_OF_PATTERN.test(value)) {
    console.error(
      `--as-of requires a YYYY-MM-DD date, got ${JSON.stringify(value ?? null)}`
    );
    process.exit(1);
  }
  return value;
}

async function main() {
  const path = await import("node:path");
  const fs = await import("node:fs");
  const { default: BetterSqlite3 } = await import("better-sqlite3");

  const asOf = parseAsOfArg(process.argv.slice(2));

  const dataDir = process.env.VANGUARD_DB_DIR || path.join(process.cwd(), "data");
  const dbPath = path.join(dataDir, "vanguard.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`);
    process.exit(1);
  }

  // Read-only — this script only ever audits, never mutates.
  const db: Database.Database = new BetterSqlite3(dbPath, { readonly: true });

  console.log(
    `IBKR Ledger vs Broker Audit${asOf ? ` (as of ${asOf})` : ""}\n${"=".repeat(70)}`
  );

  const result = auditLedgerVsBroker(db, { asOf });
  db.close();

  console.log(`\nEvaluated ${result.pairs} (symbol, date) pair(s)`);
  console.log(`  Clean:  ${result.clean}`);
  console.log(`  Gapped: ${result.gapped.length}`);

  if (result.gapped.length > 0) {
    console.log("\nSYMBOL      DATE              BROKER          LEDGER             GAP");
    for (const g of result.gapped) {
      console.log(
        `${g.symbol.padEnd(10)}  ${g.date}  ${g.broker.toFixed(2).padStart(12)}  ` +
          `${g.ledger.toFixed(2).padStart(14)}  ${g.gap >= 0 ? "+" : ""}${g.gap.toFixed(2)}`
      );
    }
    console.log(
      "\nGATE: FAIL — ledger does not reconcile with every evaluated broker holdings row."
    );
    process.exit(1);
  }

  console.log(
    result.pairs === 0
      ? "\nGATE: PASS (nothing to evaluate — no IBKR broker holdings rows matched)"
      : "\nGATE: PASS — every evaluated broker holdings row reconciles with the ledger."
  );
  process.exit(0);
}

// Detect if this file is being run directly (mirrors
// scripts/rebuild-ibkr-ledger.ts / scripts/repair-acats-opening-lots.ts).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("audit-ibkr-ledger-vs-broker.ts") ||
    process.argv[1].endsWith("audit-ibkr-ledger-vs-broker.js"));

if (isMain) {
  main().catch((err) => {
    console.error("\nFatal error:", err);
    process.exit(1);
  });
}
