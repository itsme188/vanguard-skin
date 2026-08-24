#!/usr/bin/env tsx
/**
 * reconcile-tax-report-vs-broker.ts
 *
 * Acceptance harness (number-trust durable fixes, Task 7): reconciles the
 * tax-lot engine's realized gain/loss (`tax_lot_sales`, filing rows only)
 * against a broker-reported realized section — a Vanguard 1099-B-shaped
 * statement section or the IBKR annual activity CSV's realized-P&L rows —
 * transcribed into a JSON config. Fail-closed on every ambiguity: an
 * unmatched broker row, an unmatched (extra) engine disposal, an ambiguous
 * one-to-one match, zero configured coverage, or a transcription tie-out
 * miss all fail the whole entry. Nothing is ever "close enough" without an
 * explicit tolerance check.
 *
 * INPUT INTERFACE (Codex plan review #13): the JSON config is the SINGLE
 * validated input. This script does NOT parse any broker source file
 * itself:
 *   - Vanguard statement realized-gain sections: transcribe the printed
 *     rows AND the section's printed totals (proceeds/basis/gain) by hand
 *     into `rows` / `statementTotal`. The transcription tie-out (rows must
 *     sum to statementTotal within $0.02, checked BEFORE any engine
 *     comparison — see runReconciliation) catches transcription slips
 *     before they can hide behind a broker/engine mismatch.
 *   - IBKR annual activity CSV realized-P&L section: convert its rows to
 *     the same shape (symbol, disposal date, quantity, proceeds, basis,
 *     gain) with a throwaway jq/spreadsheet pass, or by hand. No CSV
 *     parsing lives in this script.
 *
 * A real config holds real dollar figures for a PUBLIC repo and must never
 * be committed — it lives at gitignored `data/repair-configs/
 * broker-realized-<year>.json` (see CLAUDE.md "No sensitive data in public
 * assets"). tests/fixtures/broker-realized-sample.json is a synthetic
 * stand-in that documents the shape.
 *
 * Run from the repo root — tsx's "@/" alias resolution depends on cwd
 * (2026-08-23 rehearsal: running from another cwd broke dynamic "@/"
 * imports transitively; this script's imports are all static, but the
 * convention is kept for consistency with the repair-script family).
 *
 * Usage:
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx \
 *     scripts/reconcile-tax-report-vs-broker.ts \
 *     --config data/repair-configs/broker-realized-2026.json \
 *     [--stamp] [--detail-out <gitignored-path>]
 *
 * DB: opens `REPAIR_DB_PATH` if set, else `data/vanguard.db`. Read-only
 * UNLESS --stamp is passed (write access is needed to call
 * stampBrokerAcceptance).
 *
 * stdout is `result.summary` ONLY — direction-only (counts + PASS/FAIL per
 * entry, reason labels like "tie-out mismatch" — never a dollar figure or
 * quantity). Real proceeds/basis/gain detail is written ONLY to
 * --detail-out, and only after confirming the path is covered by
 * `.gitignore` (mirrors scripts/audit-twr-vs-statements.ts's
 * assertGitignored convention) — a real-figure detail file can never land
 * in this public repo by accident.
 *
 * --stamp calls `stampBrokerAcceptance(db, result.coverage)` inside a
 * transaction, and ONLY when `result.pass` is true — a failed
 * reconciliation must never be able to mark any (account, year) as
 * broker-accepted.
 *
 * Exit code: 0 iff result.pass (or nothing was configured — vacuous pass);
 * 1 otherwise.
 */

import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { stampBrokerAcceptance, type AcceptanceCoverage } from "@/lib/compute/tax-convention";

// ─── Tolerances ──────────────────────────────────────────────────────

/** Per-dollar-field tolerance for a single disposal match (proceeds, basis,
 * gain independently) — spec value, never loosened without a design call. */
export const ACCEPT_TOL_USD = 0.01;

/** Transcription tie-out tolerance: entry.rows must sum to
 * entry.statementTotal within this, checked BEFORE any engine comparison —
 * a looser bound than ACCEPT_TOL_USD because it's absorbing hand-transcribed
 * rounding across many rows, not a single-disposal match. */
export const TIE_OUT_TOL_USD = 0.02;

// ─── Config / result shapes ────────────────────────────────────────────

export interface BrokerRealizedRow {
  symbol: string;
  disposalDate: string; // YYYY-MM-DD
  quantity: number;
  currency: string;
  proceeds: number;
  basis: number;
  gain: number;
}

export interface BrokerRealizedEntry {
  accountId: number;
  taxYear: number;
  /** Provenance label, e.g. "vanguard-statement-2026-04" — free text. */
  source: string;
  /** Printed section totals from the statement/CSV — the tie-out target. */
  statementTotal: { proceeds: number; basis: number; gain: number };
  rows: BrokerRealizedRow[];
}

export interface BrokerRealizedConfig {
  entries: BrokerRealizedEntry[];
}

export interface ReconcileResult {
  pass: boolean;
  /** Entries that fully reconciled — the exact payload for stampBrokerAcceptance. */
  coverage: AcceptanceCoverage[];
  /** Direction-only: counts + PASS/FAIL + reason labels per entry. Safe for stdout. */
  summary: string;
  /** Real proceeds/basis/gain/quantity figures. Caller controls destination
   * (never stdout — see --detail-out gating in main()). */
  detailLines: string[];
}

// ─── Symbol / quantity normalization ──────────────────────────────────

/**
 * Canonical symbol for matching: uppercase, then collapsed to the
 * alphabetically-first member of its issuer family so share classes never
 * split a match (project convention — "Share classes roll up via
 * issuerSiblings(), never symbol-string-equal"). GOOG and GOOGL, e.g., both
 * canonicalize to "GOOG".
 */
function canonicalSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  const family = issuerSiblings(upper).map((s) => s.toUpperCase());
  return [...family].sort()[0] ?? upper;
}

/** Rounds to 4dp and renders as a fixed-width string for key stability —
 * quantity is an EXACT match field (spec), not tolerance-checked. */
function round4Key(qty: number): string {
  return (Math.round(qty * 10000) / 10000).toFixed(4);
}

/** Broker↔engine match identity: (accountId, symbol, disposalDate,
 * quantity to 4dp, currency). Deliberately excludes sale_transaction_id —
 * the broker side has no concept of it; the engine's FIFO-split rows for
 * one sale_transaction_id are pre-summed into one candidate before this key
 * is ever computed (see groupEngineSales). */
function matchKey(
  accountId: number,
  symbol: string,
  date: string,
  qty: number,
  currency: string,
): string {
  return `${accountId}|${canonicalSymbol(symbol)}|${date}|${round4Key(qty)}|${currency.toUpperCase()}`;
}

function withinTol(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol + 1e-9;
}

// ─── Engine side ───────────────────────────────────────────────────────

interface RawSaleRow {
  accountId: number;
  symbol: string;
  saleDate: string;
  saleTransactionId: number;
  quantitySold: number;
  proceeds: number;
  costBasisAllocated: number;
  realizedGainLoss: number;
  currency: string;
}

interface EngineGroup {
  accountId: number;
  symbol: string;
  saleDate: string;
  saleTransactionId: number;
  currency: string;
  quantity: number;
  proceeds: number;
  basis: number;
  gain: number;
}

/**
 * Filing-eligible tax_lot_sales rows for one (account, tax year), mirroring
 * getClosedTaxLotSales's filingOnly predicate exactly (tls.premium_rollover
 * = 0 AND t.type != 'RECONCILE_CLOSE' — lib/queries/tax-lots.ts). Queried
 * directly rather than through getClosedTaxLotSales because its returned
 * shape (TaxLotSaleWithDetails) doesn't carry sale_transaction_id, which
 * this script needs for the FIFO-split grouping key.
 *
 * ORDER BY tl.acquisition_date, tls.id gives groupEngineSales a
 * deterministic row order to sum in (spec: "summed deterministically").
 */
function fetchFilingSaleRows(
  db: Database.Database,
  accountId: number,
  taxYear: number,
): RawSaleRow[] {
  return db
    .prepare(
      `SELECT tl.account_id AS accountId,
              s.symbol AS symbol,
              tls.sale_date AS saleDate,
              tls.sale_transaction_id AS saleTransactionId,
              tls.quantity_sold AS quantitySold,
              tls.proceeds AS proceeds,
              tls.cost_basis_allocated AS costBasisAllocated,
              tls.realized_gain_loss AS realizedGainLoss,
              COALESCE(s.currency, 'USD') AS currency
         FROM tax_lot_sales tls
         JOIN tax_lots tl ON tl.id = tls.tax_lot_id
         JOIN securities s ON s.id = tl.security_id
         JOIN transactions t ON t.id = tls.sale_transaction_id
        WHERE tl.account_id = ?
          AND tls.sale_date >= ? AND tls.sale_date <= ?
          AND tls.premium_rollover = 0 AND t.type != 'RECONCILE_CLOSE'
        ORDER BY tl.acquisition_date, tls.id`,
    )
    .all(accountId, `${taxYear}-01-01`, `${taxYear}-12-31`) as RawSaleRow[];
}

/**
 * Groups filing sale rows by (account_id, symbol, sale_date,
 * sale_transaction_id) and sums — this is the "one broker disposal, many
 * FIFO-matched tax_lot_sales rows" case (spec test (e)): a single sale
 * transaction that consumed multiple lots leaves multiple tax_lot_sales
 * rows sharing one sale_transaction_id; they collapse to ONE engine
 * candidate here, before matching ever sees a broker row.
 */
function groupEngineSales(rows: RawSaleRow[]): EngineGroup[] {
  const order: string[] = [];
  const groups = new Map<string, EngineGroup>();
  for (const r of rows) {
    const key = `${r.accountId}|${r.symbol}|${r.saleDate}|${r.saleTransactionId}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        accountId: r.accountId,
        symbol: r.symbol,
        saleDate: r.saleDate,
        saleTransactionId: r.saleTransactionId,
        currency: r.currency,
        quantity: 0,
        proceeds: 0,
        basis: 0,
        gain: 0,
      };
      groups.set(key, g);
      order.push(key);
    }
    g.quantity += r.quantitySold;
    g.proceeds += r.proceeds;
    g.basis += r.costBasisAllocated;
    g.gain += r.realizedGainLoss;
  }
  return order.map((k) => groups.get(k)!);
}

// ─── Per-entry reconciliation ──────────────────────────────────────────

interface EntryOutcome {
  source: string;
  pass: boolean;
  /** Direction-only reason labels — safe for stdout/summary. */
  reasons: string[];
  /** Real figures — never surfaced outside detailLines/--detail-out. */
  detail: string[];
  coverage?: AcceptanceCoverage;
}

function reconcileEntry(db: Database.Database, entry: BrokerRealizedEntry): EntryOutcome {
  const detail: string[] = [];
  const reasons = new Set<string>();
  const header = `[${entry.source}] account=${entry.accountId} year=${entry.taxYear}`;

  if (entry.rows.length === 0) {
    reasons.add("zero coverage");
    detail.push(`${header}: zero coverage — entry has no rows`);
    return { source: entry.source, pass: false, reasons: [...reasons], detail };
  }

  // Step 1: transcription tie-out, BEFORE any engine comparison.
  const rowsSum = entry.rows.reduce(
    (acc, r) => ({
      proceeds: acc.proceeds + r.proceeds,
      basis: acc.basis + r.basis,
      gain: acc.gain + r.gain,
    }),
    { proceeds: 0, basis: 0, gain: 0 },
  );
  const tieOk =
    withinTol(rowsSum.proceeds, entry.statementTotal.proceeds, TIE_OUT_TOL_USD) &&
    withinTol(rowsSum.basis, entry.statementTotal.basis, TIE_OUT_TOL_USD) &&
    withinTol(rowsSum.gain, entry.statementTotal.gain, TIE_OUT_TOL_USD);

  detail.push(
    `${header}: tie-out rows(proceeds=${rowsSum.proceeds.toFixed(2)}, basis=${rowsSum.basis.toFixed(2)}, ` +
      `gain=${rowsSum.gain.toFixed(2)}) vs statementTotal(proceeds=${entry.statementTotal.proceeds.toFixed(2)}, ` +
      `basis=${entry.statementTotal.basis.toFixed(2)}, gain=${entry.statementTotal.gain.toFixed(2)}) — ${tieOk ? "OK" : "MISMATCH"}`,
  );

  if (!tieOk) {
    reasons.add("transcription tie-out mismatch");
    return { source: entry.source, pass: false, reasons: [...reasons], detail };
  }

  // Step 2: engine side, grouped.
  const engineGroups = groupEngineSales(fetchFilingSaleRows(db, entry.accountId, entry.taxYear));

  const brokerByKey = new Map<string, BrokerRealizedRow[]>();
  for (const row of entry.rows) {
    const key = matchKey(entry.accountId, row.symbol, row.disposalDate, row.quantity, row.currency);
    const list = brokerByKey.get(key);
    if (list) list.push(row);
    else brokerByKey.set(key, [row]);
  }

  const engineByKey = new Map<string, EngineGroup[]>();
  for (const g of engineGroups) {
    const key = matchKey(g.accountId, g.symbol, g.saleDate, g.quantity, g.currency);
    const list = engineByKey.get(key);
    if (list) list.push(g);
    else engineByKey.set(key, [g]);
  }

  // Step 3: match broker rows against engine candidates.
  for (const [key, brokerRows] of brokerByKey) {
    const engineCandidates = engineByKey.get(key) ?? [];
    if (engineCandidates.length === 0) {
      reasons.add("unmatched broker row");
      for (const br of brokerRows) {
        detail.push(
          `${header}: UNMATCHED broker row symbol=${br.symbol} date=${br.disposalDate} qty=${br.quantity} ` +
            `currency=${br.currency} proceeds=${br.proceeds.toFixed(2)} basis=${br.basis.toFixed(2)} ` +
            `gain=${br.gain.toFixed(2)} — no engine disposal found`,
        );
      }
      continue;
    }
    if (engineCandidates.length > 1 || brokerRows.length > 1) {
      reasons.add("ambiguous match");
      detail.push(
        `${header}: AMBIGUOUS match key=${key} — ${brokerRows.length} broker row(s), ` +
          `${engineCandidates.length} engine group(s) share this identity`,
      );
      continue;
    }
    const br = brokerRows[0];
    const eg = engineCandidates[0];
    const okProceeds = withinTol(eg.proceeds, br.proceeds, ACCEPT_TOL_USD);
    const okBasis = withinTol(eg.basis, br.basis, ACCEPT_TOL_USD);
    const okGain = withinTol(eg.gain, br.gain, ACCEPT_TOL_USD);
    if (!okProceeds || !okBasis || !okGain) reasons.add("field mismatch");
    detail.push(
      `${header}: MATCH symbol=${br.symbol} date=${br.disposalDate} qty=${br.quantity} — ` +
        `broker(proceeds=${br.proceeds.toFixed(2)}, basis=${br.basis.toFixed(2)}, gain=${br.gain.toFixed(2)}) vs ` +
        `engine(proceeds=${eg.proceeds.toFixed(2)}, basis=${eg.basis.toFixed(2)}, gain=${eg.gain.toFixed(2)}) — ` +
        `${okProceeds && okBasis && okGain ? "OK" : "MISMATCH"}`,
    );
  }

  // Step 4: any engine group the broker never mentioned is an extra
  // disposal — fails closed. premium_rollover/RECONCILE_CLOSE rows are
  // already excluded by fetchFilingSaleRows, so they can never appear here.
  for (const [key, engineCandidates] of engineByKey) {
    if (brokerByKey.has(key)) continue;
    reasons.add("extra engine disposal");
    for (const eg of engineCandidates) {
      detail.push(
        `${header}: EXTRA engine disposal symbol=${eg.symbol} date=${eg.saleDate} qty=${eg.quantity} ` +
          `proceeds=${eg.proceeds.toFixed(2)} basis=${eg.basis.toFixed(2)} gain=${eg.gain.toFixed(2)} — ` +
          "no broker row found",
      );
    }
  }

  const pass = reasons.size === 0;
  return {
    source: entry.source,
    pass,
    reasons: [...reasons],
    detail,
    coverage: pass ? { accountId: entry.accountId, taxYear: entry.taxYear } : undefined,
  };
}

// ─── Core entry point ───────────────────────────────────────────────────

export function runReconciliation(
  db: Database.Database,
  config: BrokerRealizedConfig,
): ReconcileResult {
  const outcomes = config.entries.map((entry) => reconcileEntry(db, entry));

  const coverageMap = new Map<string, AcceptanceCoverage>();
  for (const o of outcomes) {
    if (o.coverage) coverageMap.set(`${o.coverage.accountId}|${o.coverage.taxYear}`, o.coverage);
  }

  const passCount = outcomes.filter((o) => o.pass).length;
  const failCount = outcomes.length - passCount;
  const allPass = failCount === 0;

  const summaryLines: string[] = [
    `Broker-reconciliation acceptance: ${outcomes.length} entr${outcomes.length === 1 ? "y" : "ies"} — ${passCount} pass, ${failCount} fail`,
  ];
  for (const o of outcomes) {
    summaryLines.push(`  [${o.source}] ${o.pass ? "PASS" : `FAIL (${o.reasons.join(", ")})`}`);
  }
  summaryLines.push(
    outcomes.length === 0
      ? "GATE: SKIP (no entries configured)"
      : allPass
        ? "GATE: PASS"
        : "GATE: FAIL",
  );

  return {
    pass: allPass,
    coverage: [...coverageMap.values()],
    summary: summaryLines.join("\n"),
    detailLines: outcomes.flatMap((o) => o.detail),
  };
}

// ─── CLI shell ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { configPath: string; stamp: boolean; detailOut?: string } {
  const configIdx = argv.indexOf("--config");
  const configPath = configIdx !== -1 ? argv[configIdx + 1] : undefined;
  if (!configPath) {
    console.error(
      "Usage: npx tsx scripts/reconcile-tax-report-vs-broker.ts --config <path> [--stamp] [--detail-out <path>]",
    );
    process.exit(1);
  }

  const detailOutIdx = argv.indexOf("--detail-out");
  const detailOut = detailOutIdx !== -1 ? argv[detailOutIdx + 1] : undefined;
  if (detailOutIdx !== -1 && !detailOut) {
    console.error("--detail-out requires a path argument");
    process.exit(1);
  }

  return { configPath, stamp: argv.includes("--stamp"), detailOut };
}

/**
 * Refuses (exit 1) unless `filePath` is covered by .gitignore — mirrors
 * scripts/audit-twr-vs-statements.ts's assertGitignored. Real proceeds/
 * basis/gain detail must never be reachable from a committed file in this
 * PUBLIC repo.
 */
function assertGitignored(filePath: string): string {
  const resolved = path.resolve(filePath);
  const result = spawnSync("git", ["check-ignore", "-q", resolved], { cwd: process.cwd() });
  if (result.status !== 0) {
    console.error(
      `Refusing to write --detail-out to ${filePath}: it is not covered by .gitignore. ` +
        "This file holds real proceeds/basis/gain figures and must never be committable " +
        "— point it at an already-ignored location (e.g. under docs/private/ or data/) " +
        "or add a .gitignore rule for it.",
    );
    process.exit(1);
  }
  return resolved;
}

function parseConfigJson(raw: string, configPath: string): BrokerRealizedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `Unreadable config JSON at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    console.error(`Invalid config at ${configPath}: expected shape { entries: [...] }`);
    process.exit(1);
  }
  return parsed as BrokerRealizedConfig;
}

function loadConfig(configPath: string): BrokerRealizedConfig {
  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  return parseConfigJson(raw, configPath);
}

async function main(): Promise<void> {
  const { configPath, stamp, detailOut } = parseArgs(process.argv.slice(2));
  const resolvedDetailOut = detailOut !== undefined ? assertGitignored(detailOut) : undefined;
  const config = loadConfig(configPath);

  const { default: BetterSqlite3 } = await import("better-sqlite3");
  const dbPath = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`);
    process.exit(1);
  }

  // Read-only unless --stamp — this script must never write without the
  // explicit flag, and never writes anything but the acceptance stamp.
  const db: Database.Database = new BetterSqlite3(dbPath, { readonly: !stamp }) as Database.Database;

  const result = runReconciliation(db, config);

  // stdout: direction-only, always.
  console.log(result.summary);

  if (stamp) {
    if (!result.pass) {
      console.log("\n--stamp requested but reconciliation FAILED — no coverage stamped.");
    } else {
      db.transaction(() => {
        stampBrokerAcceptance(db, result.coverage);
      })();
      console.log(`\nStamped broker acceptance for ${result.coverage.length} (account, year) pair(s).`);
    }
  }

  if (resolvedDetailOut) {
    fs.writeFileSync(resolvedDetailOut, result.detailLines.join("\n") + "\n", "utf8");
    console.log(`\nWrote numeric detail (${result.detailLines.length} line(s)) to ${detailOut}`);
  }

  db.close();
  process.exit(result.pass ? 0 : 1);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("reconcile-tax-report-vs-broker.ts") ||
    process.argv[1].endsWith("reconcile-tax-report-vs-broker.js"));

if (isMain) {
  main().catch((err) => {
    console.error("\nFatal error:", err);
    process.exit(1);
  });
}
