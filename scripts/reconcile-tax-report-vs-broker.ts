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
 *     [--rollup] [--stamp] [--detail-out <gitignored-path>]
 *
 * MATCH MODES (the summary's second line always names the one that ran):
 *   - strict (default): one broker row ↔ one engine disposal (a sale
 *     transaction's FIFO lot rows pre-summed), keyed on quantity too.
 *   - --rollup: the broker prints one row per closing ORDER while the engine
 *     records one row per LOT closed, so a day with several orders and
 *     several lots can never pair one-to-one even when the day agrees. Roll-up
 *     sums BOTH sides per (account, issuer-canonical symbol, disposal date,
 *     currency) — and per term (short/long) when EVERY broker row carries
 *     `term` — then compares group to group: quantity exactly (4dp),
 *     proceeds / basis / gain each within ACCEPT_TOL_USD per GROUP (the
 *     tolerance is not scaled by row count). Fail-closed exactly like strict:
 *     a group present on one side only, or out of tolerance, fails the entry
 *     and is listed in the detail output. Roll-up changes how rows are
 *     paired, never what passes: --stamp still requires every group matched.
 *     Without `term` in the file, holding period is NOT checked — the
 *     summary says so.
 *
 * DB: opens `REPAIR_DB_PATH` if set, else `data/vanguard.db`. Read-only
 * UNLESS --stamp is passed (write access is needed to call
 * stampBrokerAcceptance).
 *
 * stdout is `result.summary` ONLY — direction-only (counts + PASS/FAIL per
 * entry, reason labels like "tie-out mismatch" — never a dollar figure or
 * quantity). `entry.source` (the transcriber-supplied provenance label,
 * e.g. "vanguard-statement-2026-04") is echoed into that summary too — it
 * MUST stay a free-text label, never a number: whoever fills in `source`
 * in the config should never encode a dollar figure or count into it, or
 * it would leak a real figure onto stdout through the back door. Real
 * proceeds/basis/gain detail is written ONLY to --detail-out, and only
 * after confirming the path is covered by `.gitignore` (mirrors
 * scripts/audit-twr-vs-statements.ts's assertGitignored convention) — a
 * real-figure detail file can never land in this public repo by accident.
 *
 * --stamp calls `stampBrokerAcceptance(db, result.coverage)` inside a
 * transaction, and ONLY when `result.pass` is true — a failed
 * reconciliation must never be able to mark any (account, year) as
 * broker-accepted. An EMPTY `entries` config is itself a failure (zero
 * configured coverage), not a vacuous pass — see runReconciliation.
 *
 * Exit code: 0 iff result.pass; 1 otherwise. This includes an empty
 * `entries` config, which fails closed rather than vacuously passing.
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
  /** Holding period as the broker printed it. Optional; read ONLY by
   * roll-up mode, and only when every row of the entry carries it. */
  term?: "short" | "long";
}

export type MatchMode = "strict" | "rollup";

export interface ReconcileOptions {
  /** Default "strict". */
  mode?: MatchMode;
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
  /** tax_lot_sales.is_long_term (NOT NULL 0/1). */
  isLongTerm: number;
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
              tls.is_long_term AS isLongTerm,
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

// ─── Roll-up match mode ────────────────────────────────────────────────

/** One realized row from either side, reduced to what the roll-up sums. */
export interface RollUpItem {
  accountId: number;
  symbol: string;
  date: string;
  currency: string;
  /** null = term is not part of this run's key. */
  term: "short" | "long" | null;
  quantity: number;
  proceeds: number;
  basis: number;
  gain: number;
}

export interface RollUpGroup extends RollUpItem {
  key: string;
  /** Source rows summed into this group. */
  rowCount: number;
}

function rollUpKey(i: RollUpItem): string {
  return `${i.accountId}|${canonicalSymbol(i.symbol)}|${i.date}|${i.currency.toUpperCase()}|${i.term ?? "-"}`;
}

/**
 * Sums items per (account, issuer-canonical symbol, date, currency, term).
 * Pure and order-preserving (first-seen group order). Every item lands in
 * exactly one group — the conservation property the tests pin and
 * `conserves` re-checks at run time.
 */
export function rollUpItems(items: RollUpItem[]): RollUpGroup[] {
  const groups = new Map<string, RollUpGroup>();
  for (const i of items) {
    const key = rollUpKey(i);
    let g = groups.get(key);
    if (!g) {
      g = {
        ...i,
        symbol: canonicalSymbol(i.symbol),
        currency: i.currency.toUpperCase(),
        key,
        rowCount: 0,
        quantity: 0,
        proceeds: 0,
        basis: 0,
        gain: 0,
      };
      groups.set(key, g);
    }
    g.rowCount += 1;
    g.quantity += i.quantity;
    g.proceeds += i.proceeds;
    g.basis += i.basis;
    g.gain += i.gain;
  }
  return [...groups.values()];
}

function normalizeTerm(term: unknown): "short" | "long" | null {
  if (typeof term !== "string") return null;
  const t = term.trim().toLowerCase();
  return t === "short" || t === "long" ? t : null;
}

export function brokerRollUpItems(
  accountId: number,
  rows: BrokerRealizedRow[],
  useTerm: boolean,
): RollUpItem[] {
  return rows.map((r) => ({
    accountId,
    symbol: r.symbol,
    date: r.disposalDate,
    currency: r.currency,
    term: useTerm ? normalizeTerm(r.term) : null,
    quantity: r.quantity,
    proceeds: r.proceeds,
    basis: r.basis,
    gain: r.gain,
  }));
}

/** Filing-eligible engine rows (same predicate as strict mode), one item per
 * tax_lot_sales row — i.e. per LOT closed. */
export function engineRollUpItems(
  db: Database.Database,
  accountId: number,
  taxYear: number,
  useTerm: boolean,
): RollUpItem[] {
  return fetchFilingSaleRows(db, accountId, taxYear).map((r) => ({
    accountId: r.accountId,
    symbol: r.symbol,
    date: r.saleDate,
    currency: r.currency,
    term: useTerm ? (r.isLongTerm === 1 ? "long" : "short") : null,
    quantity: r.quantitySold,
    proceeds: r.proceeds,
    basis: r.costBasisAllocated,
    gain: r.realizedGainLoss,
  }));
}

/** Run-time conservation guard: Σ rows = Σ groups (float-noise bound only —
 * this is an arithmetic identity, not a tolerance). */
function conserves(items: RollUpItem[], groups: RollUpGroup[]): boolean {
  const fields = ["quantity", "proceeds", "basis", "gain"] as const;
  if (groups.reduce((a, g) => a + g.rowCount, 0) !== items.length) return false;
  return fields.every((f) => {
    const rowSum = items.reduce((a, i) => a + i[f], 0);
    const groupSum = groups.reduce((a, g) => a + g[f], 0);
    return Math.abs(rowSum - groupSum) <= 1e-6 * Math.max(1, Math.abs(rowSum));
  });
}

/** Row-level compatibility: the strict matcher's rule (quantity exact,
 * proceeds / basis / gain each within ACCEPT_TOL_USD). */
function rowsCompatible(a: RollUpItem, b: RollUpItem): boolean {
  return (
    round4Key(a.quantity) === round4Key(b.quantity) &&
    withinTol(a.proceeds, b.proceeds, ACCEPT_TOL_USD) &&
    withinTol(a.basis, b.basis, ACCEPT_TOL_USD) &&
    withinTol(a.gain, b.gain, ACCEPT_TOL_USD)
  );
}

/** True when the two row lists admit a perfect one-to-one matching under
 * `rowsCompatible` (order-independent; augmenting paths, so two rows on one
 * side can never both claim the same row on the other). */
function hasPerfectRowMatching(left: RollUpItem[], right: RollUpItem[]): boolean {
  if (left.length !== right.length) return false;
  const owner: number[] = new Array(right.length).fill(-1);
  const tryAssign = (l: number, seen: boolean[]): boolean => {
    for (let r = 0; r < right.length; r++) {
      if (seen[r] || !rowsCompatible(left[l], right[r])) continue;
      seen[r] = true;
      if (owner[r] === -1 || tryAssign(owner[r], seen)) {
        owner[r] = l;
        return true;
      }
    }
    return false;
  };
  for (let l = 0; l < left.length; l++) {
    if (!tryAssign(l, new Array(right.length).fill(false))) return false;
  }
  return true;
}

function itemsByKey(items: RollUpItem[]): Map<string, RollUpItem[]> {
  const m = new Map<string, RollUpItem[]>();
  for (const i of items) {
    const k = rollUpKey(i);
    const list = m.get(k);
    if (list) list.push(i);
    else m.set(k, [i]);
  }
  return m;
}

function describeGroup(g: RollUpGroup): string {
  return (
    `symbol=${g.symbol} date=${g.date} currency=${g.currency}` +
    `${g.term ? ` term=${g.term}` : ""} rows=${g.rowCount} qty=${g.quantity} ` +
    `proceeds=${g.proceeds.toFixed(2)} basis=${g.basis.toFixed(2)} gain=${g.gain.toFixed(2)}`
  );
}

/**
 * Roll-up comparison for one entry (the tie-out has already passed). Returns
 * direction-only reasons plus counts; real figures go to `detail` only.
 */
function reconcileEntryRollUp(
  db: Database.Database,
  entry: BrokerRealizedEntry,
  header: string,
  detail: string[],
): { reasons: string[]; note: string } {
  const reasons = new Set<string>();

  // Term joins the key only when the WHOLE file carries it. A file that
  // carries it on some rows (or with an unknown value) cannot be grouped
  // honestly either way — refuse rather than guess.
  const withTerm = entry.rows.filter((r) => r.term !== undefined && r.term !== null).length;
  const validTerm = entry.rows.filter((r) => normalizeTerm(r.term) !== null).length;
  if (withTerm > 0 && validTerm !== entry.rows.length) {
    reasons.add("partial or invalid term");
    detail.push(
      `${header}: TERM unusable — ${validTerm} of ${entry.rows.length} broker row(s) carry a ` +
        "short/long term; roll-up needs all or none",
    );
    return { reasons: [...reasons], note: "" };
  }
  const useTerm = withTerm > 0;

  const brokerItems = brokerRollUpItems(entry.accountId, entry.rows, useTerm);
  const engineItems = engineRollUpItems(db, entry.accountId, entry.taxYear, useTerm);
  const brokerGroups = rollUpItems(brokerItems);
  const engineGroups = rollUpItems(engineItems);

  if (!conserves(brokerItems, brokerGroups) || !conserves(engineItems, engineGroups)) {
    reasons.add("roll-up conservation failure");
    detail.push(`${header}: CONSERVATION failure — grouped totals do not equal row totals`);
    return { reasons: [...reasons], note: "" };
  }

  const engineByKey = new Map(engineGroups.map((g) => [g.key, g]));
  const brokerItemsByKey = itemsByKey(brokerItems);
  const engineItemsByKey = itemsByKey(engineItems);
  const brokerKeys = new Set(brokerGroups.map((g) => g.key));
  let matched = 0;
  let residual = 0;

  for (const bg of brokerGroups) {
    const eg = engineByKey.get(bg.key);
    if (!eg) {
      reasons.add("unmatched broker group");
      residual++;
      detail.push(`${header}: UNMATCHED broker group ${describeGroup(bg)} — no engine group found`);
      continue;
    }
    const okQty = round4Key(bg.quantity) === round4Key(eg.quantity);
    const okProceeds = withinTol(eg.proceeds, bg.proceeds, ACCEPT_TOL_USD);
    const okBasis = withinTol(eg.basis, bg.basis, ACCEPT_TOL_USD);
    const okGain = withinTol(eg.gain, bg.gain, ACCEPT_TOL_USD);
    if (!okQty) reasons.add("quantity mismatch");
    if (!okProceeds || !okBasis || !okGain) reasons.add("field mismatch");
    const totalsOk = okQty && okProceeds && okBasis && okGain;
    // Same granularity on both sides: totals alone could net two offsetting
    // row errors, so the rows themselves must match one-to-one. Roll-up only
    // bridges a DIFFERENT row count.
    const sameCount = bg.rowCount === eg.rowCount;
    const rowsOk =
      !sameCount ||
      hasPerfectRowMatching(brokerItemsByKey.get(bg.key) ?? [], engineItemsByKey.get(bg.key) ?? []);
    if (totalsOk && !rowsOk) reasons.add("same row count but rows differ (offsetting differences)");
    const ok = totalsOk && rowsOk;
    if (ok) matched++;
    else residual++;
    detail.push(
      `${header}: GROUP ${ok ? "OK" : "MISMATCH"} broker(${describeGroup(bg)}) vs engine(${describeGroup(eg)})` +
        (totalsOk && !rowsOk ? " — same row count but rows differ (offsetting differences)" : ""),
    );
  }

  // Filing-only predicate already applied, so RECONCILE_CLOSE and
  // premium-rollover rows can never appear here.
  for (const eg of engineGroups) {
    if (brokerKeys.has(eg.key)) continue;
    reasons.add("extra engine group");
    residual++;
    detail.push(`${header}: EXTRA engine group ${describeGroup(eg)} — no broker group found`);
  }

  const keyLabel = useTerm ? "symbol, date, term" : "symbol, date — holding period NOT checked";
  return {
    reasons: [...reasons],
    note: `${matched} matched, ${residual} residual group(s); key: ${keyLabel}`,
  };
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
  /** Direction-only counts line (roll-up mode) — safe for stdout. */
  note?: string;
}

function reconcileEntry(
  db: Database.Database,
  entry: BrokerRealizedEntry,
  mode: MatchMode = "strict",
): EntryOutcome {
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

  if (mode === "rollup") {
    const rolled = reconcileEntryRollUp(db, entry, header, detail);
    // Same gate as strict: ANY reason fails the entry; coverage only when
    // every group on both sides matched.
    const rolledPass = rolled.reasons.length === 0;
    return {
      source: entry.source,
      pass: rolledPass,
      reasons: rolled.reasons,
      detail,
      note: rolled.note,
      coverage: rolledPass ? { accountId: entry.accountId, taxYear: entry.taxYear } : undefined,
    };
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
  opts: ReconcileOptions = {},
): ReconcileResult {
  const mode: MatchMode = opts.mode ?? "strict";
  const modeLine =
    mode === "rollup"
      ? "Match mode: roll-up (both sides summed per symbol and disposal date before comparing)"
      : "Match mode: strict (one broker row to one engine disposal)";
  // Zero configured entries is zero configured coverage — fail closed, same
  // as an entry with zero rows. An empty config must never vacuously pass
  // and must never let --stamp write an empty-coverage acceptance stamp.
  if (config.entries.length === 0) {
    return {
      pass: false,
      coverage: [],
      summary: [
        "Broker-reconciliation acceptance: 0 entries — 0 pass, 0 fail",
        modeLine,
        "  FAIL (no entries — nothing reconciled)",
        "GATE: FAIL",
      ].join("\n"),
      detailLines: ["no entries — nothing reconciled: config.entries is empty"],
    };
  }

  const outcomes = config.entries.map((entry) => reconcileEntry(db, entry, mode));

  const coverageMap = new Map<string, AcceptanceCoverage>();
  for (const o of outcomes) {
    if (o.coverage) coverageMap.set(`${o.coverage.accountId}|${o.coverage.taxYear}`, o.coverage);
  }

  const passCount = outcomes.filter((o) => o.pass).length;
  const failCount = outcomes.length - passCount;
  const allPass = failCount === 0;

  const summaryLines: string[] = [
    `Broker-reconciliation acceptance: ${outcomes.length} entr${outcomes.length === 1 ? "y" : "ies"} — ${passCount} pass, ${failCount} fail`,
    modeLine,
  ];
  for (const o of outcomes) {
    const note = o.note ? ` — ${o.note}` : "";
    summaryLines.push(`  [${o.source}] ${o.pass ? "PASS" : `FAIL (${o.reasons.join(", ")})`}${note}`);
  }
  summaryLines.push(allPass ? "GATE: PASS" : "GATE: FAIL");

  return {
    pass: allPass,
    coverage: [...coverageMap.values()],
    summary: summaryLines.join("\n"),
    detailLines: outcomes.flatMap((o) => o.detail),
  };
}

// ─── CLI shell ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  configPath: string;
  stamp: boolean;
  rollup: boolean;
  detailOut?: string;
} {
  const configIdx = argv.indexOf("--config");
  const configPath = configIdx !== -1 ? argv[configIdx + 1] : undefined;
  if (!configPath) {
    console.error(
      "Usage: npx tsx scripts/reconcile-tax-report-vs-broker.ts --config <path> [--rollup] [--stamp] [--detail-out <path>]",
    );
    process.exit(1);
  }

  const detailOutIdx = argv.indexOf("--detail-out");
  const detailOut = detailOutIdx !== -1 ? argv[detailOutIdx + 1] : undefined;
  if (detailOutIdx !== -1 && !detailOut) {
    console.error("--detail-out requires a path argument");
    process.exit(1);
  }

  return {
    configPath,
    stamp: argv.includes("--stamp"),
    rollup: argv.includes("--rollup"),
    detailOut,
  };
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
  const { configPath, stamp, rollup, detailOut } = parseArgs(process.argv.slice(2));
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

  const result = runReconciliation(db, config, { mode: rollup ? "rollup" : "strict" });

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
