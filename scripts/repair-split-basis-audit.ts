/**
 * repair-split-basis-audit.ts — generalized pre-split TRANSACTION-basis audit
 * + repair, plus a portfolio-wide sibling sweep for the same disease.
 *
 * USER-RUN ONLY. Nothing schedules this script: it is a deliberate, reviewed
 * repair (dry-run by default) invoked by hand. Never wire it into a cron,
 * launchd plist, the auto-refresh pipeline, or the nightly QA fixer.
 *
 * Finding: qa:security-detail-tax-lots--pre-split-amzn-lots-unadjusted-render-loss
 *
 * ── The disease ────────────────────────────────────────────────────────
 * The canonical CSV transcription of the broker's activity report skipped the
 * broker's "Stock split" lines. So for a security that split, every
 * statement-basis row dated BEFORE the split date still carries the PRE-split
 * share count and the PRE-split per-share price, while everything after it is
 * post-split. The ledger then mixes two share bases: per-share comparisons are
 * wrong by exactly the split ratio, the position never reconciles to the
 * broker's holdings, and tax lots render fake losses (a lot opened at a
 * pre-split price of, say, $1,000/share against a post-split $200 market price
 * looks like an 80% loss that never happened).
 *
 * ── The repair doctrine (product-preserving) ───────────────────────────
 * Same convention as scripts/repair-smh-presplit-basis.ts and
 * scripts/repair-split-basis-2024-year-end.ts — normalize to the POST-split
 * basis and preserve every qty x price product exactly:
 *   transactions.quantity        *= ratio
 *   transactions.price_per_share /= ratio   (NULL price stays NULL)
 *   transactions.amount           UNTOUCHED
 *   transactions.source_key       UNTOUCHED
 * `amount` is the cash that actually moved — a split does not change it — and
 * source_key embeds that amount's cents, so leaving both alone keeps the
 * dedup key valid and a re-import of the same fill a no-op.
 *   e.g. a 4:1 split, 30.318 sh @ $1,094.92:
 *        30.318 x 1094.92 = 33,195.36  ->  121.272 x 273.73 = 33,195.36
 *
 * ── The guard (what the SMH one-off lacked) ────────────────────────────
 * Every write is guarded on a KNOWN value, so the script is safe to re-run:
 *   - transactions: the SUM of `quantity` over the security's pre-split rows
 *     must equal the configured `expectedPreSplitTxnQty` (eps 0.001) before a
 *     rewrite fires. If it already equals expected x ratio, the rows are
 *     ALREADY NORMALIZED and the symbol is a no-op. Anything else is
 *     UNEXPECTED — the symbol is reported and left completely alone.
 *   - prices: the same three-state guard per configured row
 *     (close ~ preSplitClose -> repair; ~ preSplitClose/ratio -> already
 *     normalized; else refuse). Each price-row guard stands ALONE: it is an
 *     exact known-value match, so a refused transaction sum does not veto a
 *     price row that provably still carries its pre-split close (and vice
 *     versa).
 * Known trade-off (inherited from the precedents): re-importing the original
 * un-transcribed CSV writes the pre-split values back. Re-run this script if
 * that ever happens.
 *
 * ── Audit-only checks (never written) ──────────────────────────────────
 *   - pre-split `holdings` rows for the security (expected: 0 — the snapshot
 *     era post-dates these splits). Nonzero -> REVIEW-NEEDED, not touched:
 *     holdings normalization is scripts/repair-split-basis-2024-year-end.ts's
 *     job and needs its own per-row guards.
 *   - LEDGER WALK: the signed position implied by ALL of the security's
 *     transactions (after the hypothetical normalization) minus the latest
 *     nonzero holdings quantity. A nonzero residual means rows are still
 *     MISSING from the ledger — the basis repair is still correct and still
 *     proceeds, the residual is informational.
 *   - SIBLING SWEEP: the same ledger walk, with NO split adjustment, for every
 *     non-option security that has transaction rows and a live position. Every
 *     symbol whose |residual| > 0.001 is listed — that is the fingerprint of
 *     untranscribed rows or an unapplied split, i.e. the undiscovered siblings
 *     of this finding.
 *
 * ── Config lives outside git ───────────────────────────────────────────
 * The affected symbols, split dates and guard quantities are real portfolio
 * data, so they live in data/repair-configs/split-basis-audit.json (the data/
 * tree is gitignored). See CONFIG_EXAMPLE below for the shape.
 *
 * Usage:
 *   npx tsx scripts/repair-split-basis-audit.ts            # dry-run (default)
 *   npx tsx scripts/repair-split-basis-audit.ts --apply    # write
 *   npx tsx scripts/repair-split-basis-audit.ts --db <path>
 *
 * After applying: tax lots are recomputed automatically; recompute valuations
 * with POST /api/compute/valuations.
 */

import type Database from "better-sqlite3";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

// ─── Config ────────────────────────────────────────────────────────────

/** One explicit `prices` row to normalize alongside the transactions. */
export interface SplitBasisPriceRowTarget {
  /** `prices.date` (YYYY-MM-DD). */
  date: string;
  /** The known PRE-split close still stored on that row (the write guard). */
  preSplitClose: number;
}

export interface SplitBasisAuditTarget {
  symbol: string;
  /** First date on the POST-split basis; rows with trade_date < this are stale. */
  splitDate: string;
  /** post_shares / pre_shares — 4 for a 4:1 forward split, 0.1 for a 1:10 reverse. */
  ratio: number;
  /**
   * Known SUM of `transactions.quantity` over the security's pre-split rows
   * (trade_date < splitDate AND quantity IS NOT NULL). The write guard: the
   * rewrite fires only when the live sum still matches this.
   */
  expectedPreSplitTxnQty: number;
  /** Optional explicit `prices` rows to normalize, each with its own guard. */
  priceRows: SplitBasisPriceRowTarget[];
}

/** Shape of data/repair-configs/split-basis-audit.json (gitignored). */
export const CONFIG_EXAMPLE = `[
  {
    "symbol": "AAAA",
    "splitDate": "2020-08-28",
    "ratio": 4,
    "expectedPreSplitTxnQty": 30.318,
    "priceRows": [{ "date": "2025-06-30", "preSplitClose": 1094.92 }]
  }
]`;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates the parsed JSON config into SplitBasisAuditTarget[]. Throws on
 * shape errors. An empty array is legal — that runs the script in sweep-only
 * mode (sibling sweep + nothing to repair), which is how you go looking for
 * new instances of this disease before you know any guard values.
 */
export function parseConfig(raw: unknown): SplitBasisAuditTarget[] {
  if (!Array.isArray(raw)) {
    throw new Error(`config must be a JSON array — expected shape: ${CONFIG_EXAMPLE}`);
  }
  return raw.map((entry, i) => {
    const bad = (why: string) =>
      new Error(`config entry ${i} is malformed (${why}) — expected shape: ${CONFIG_EXAMPLE}`);
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw bad("entry must be an object");
    }
    const e = entry as Record<string, unknown>;

    if (typeof e.symbol !== "string" || e.symbol.trim() === "") throw bad("symbol");
    if (typeof e.splitDate !== "string" || !DATE_PATTERN.test(e.splitDate)) {
      throw bad("splitDate must be YYYY-MM-DD");
    }
    if (typeof e.ratio !== "number" || !Number.isFinite(e.ratio) || !(e.ratio > 0)) {
      throw bad("ratio must be a number > 0");
    }
    // ratio 1 would make the "already normalized" and "needs repair" guards
    // indistinguishable, and normalizes nothing. Reject it loudly.
    if (e.ratio === 1) throw bad("ratio 1 is a no-op — nothing to normalize");
    if (typeof e.expectedPreSplitTxnQty !== "number" || !Number.isFinite(e.expectedPreSplitTxnQty)) {
      throw bad("expectedPreSplitTxnQty must be a number");
    }

    const rawPriceRows = e.priceRows ?? [];
    if (!Array.isArray(rawPriceRows)) throw bad("priceRows must be an array when present");
    const priceRows: SplitBasisPriceRowTarget[] = rawPriceRows.map((p, j) => {
      const pr = p as Record<string, unknown>;
      if (typeof pr.date !== "string" || !DATE_PATTERN.test(pr.date)) {
        throw bad(`priceRows[${j}].date must be YYYY-MM-DD`);
      }
      if (typeof pr.preSplitClose !== "number" || !Number.isFinite(pr.preSplitClose)) {
        throw bad(`priceRows[${j}].preSplitClose must be a number`);
      }
      return { date: pr.date, preSplitClose: pr.preSplitClose };
    });

    return {
      symbol: e.symbol,
      splitDate: e.splitDate,
      ratio: e.ratio,
      expectedPreSplitTxnQty: e.expectedPreSplitTxnQty,
      priceRows,
    };
  });
}

// ─── Tolerances ────────────────────────────────────────────────────────

/** Share-count tolerance for every quantity guard and the ledger residual. */
export const QTY_EPS = 0.001;
/** Price tolerance, same as scripts/repair-split-basis-2024-year-end.ts. */
export const PRICE_EPS = 0.005;

// ─── Ledger-walk transaction types (LOWER(type)-compared) ──────────────

/**
 * Position-INCREASING types. Mirrors `computeTaxLots`'s buy list (via
 * scripts/audit-ibkr-ledger-vs-broker.ts, which copied it verbatim);
 * SELL_TO_OPEN is lot-creating in the engine, so it lives here.
 */
export const POSITION_ADD_TYPES = new Set([
  "buy",
  "reinvestment",
  "buy_to_open",
  "sell_to_open",
  "transfer_in",
]);

/**
 * Position-DECREASING types. The engine's sell list plus `transfer_out`:
 * tax-lots deliberately excludes outbound transfers (they are settled through
 * donation_leg_links), but this walk reconciles against the BROKER's share
 * count, and shares that transfer out physically leave the position.
 */
export const POSITION_SUBTRACT_TYPES = new Set([
  "sell",
  "sell_to_close",
  "buy_to_close",
  "buy_to_cover",
  "redemption",
  "expired",
  "exercised",
  "assigned",
  "transfer_out",
]);

/** Cash-only types — recognized and deliberately ignored by the share walk. */
export const CASH_ONLY_TYPES = new Set([
  "dividend",
  "interest",
  "tax_withheld",
  "deposit",
  "withdrawal",
  "fee",
  "commission",
  "return_of_capital",
]);

/**
 * Engine-owned synthetic rows. RECONCILE_CLOSE is never user activity, so it
 * is excluded from the walk rather than treated as a sell — counting it would
 * mask the very ledger hole it was generated to paper over.
 */
export const ENGINE_SYNTHETIC_TYPES = new Set(["reconcile_close"]);

// ─── Ledger walk ───────────────────────────────────────────────────────

/** One (type, pre/post-split) bucket of a security's quantity-carrying rows. */
export interface LedgerLeg {
  type: string;
  /** Summed `transactions.quantity` for the bucket (always positive-signed data). */
  quantity: number;
  rowCount: number;
  /** True when the bucket's rows are dated before the configured split date. */
  preSplit: boolean;
}

export interface UnrecognizedLeg {
  type: string;
  rows: number;
  quantity: number;
}

export interface LedgerWalk {
  /** Shares added by position-increasing rows (after any split adjustment). */
  added: number;
  /** Shares removed by position-decreasing rows (after any split adjustment). */
  subtracted: number;
  /** added - subtracted: the position the transaction history implies. */
  walked: number;
  /** Latest nonzero holdings quantity, summed across accounts. */
  latestHoldingsQty: number;
  /** walked - latestHoldingsQty. Zero (within QTY_EPS) means the ledger ties. */
  residual: number;
  ties: boolean;
  /** Types that carry a quantity but are neither position nor cash types. */
  unrecognized: UnrecognizedLeg[];
  ignoredCashOnlyRows: number;
  engineSyntheticRows: number;
}

/**
 * Walks a security's quantity-carrying transaction legs into an implied
 * position and compares it to the broker's latest holdings.
 *
 * `preSplitFactor` scales the pre-split legs — pass the split ratio to walk
 * the ledger AS IF the basis repair had already been applied, or 1 for a raw
 * walk (the sibling sweep).
 */
export function walkLedger(
  legs: LedgerLeg[],
  preSplitFactor: number,
  latestHoldingsQty: number
): LedgerWalk {
  let added = 0;
  let subtracted = 0;
  let ignoredCashOnlyRows = 0;
  let engineSyntheticRows = 0;
  const unrecognized = new Map<string, UnrecognizedLeg>();

  for (const leg of legs) {
    const factor = leg.preSplit ? preSplitFactor : 1;
    const qty = leg.quantity * factor;
    const type = leg.type.toLowerCase();

    if (POSITION_ADD_TYPES.has(type)) {
      added += qty;
    } else if (POSITION_SUBTRACT_TYPES.has(type)) {
      subtracted += qty;
    } else if (CASH_ONLY_TYPES.has(type)) {
      ignoredCashOnlyRows += leg.rowCount;
    } else if (ENGINE_SYNTHETIC_TYPES.has(type)) {
      engineSyntheticRows += leg.rowCount;
    } else {
      const prior = unrecognized.get(type);
      if (prior) {
        prior.rows += leg.rowCount;
        prior.quantity += qty;
      } else {
        unrecognized.set(type, { type, rows: leg.rowCount, quantity: qty });
      }
    }
  }

  const walked = added - subtracted;
  const residual = walked - latestHoldingsQty;
  return {
    added,
    subtracted,
    walked,
    latestHoldingsQty,
    residual,
    ties: Math.abs(residual) <= QTY_EPS,
    unrecognized: [...unrecognized.values()].sort((a, b) => a.type.localeCompare(b.type)),
    ignoredCashOnlyRows,
    engineSyntheticRows,
  };
}

/**
 * True when the DB has the donations tables. Lets the ledger walk run against
 * a minimal fixture schema while still excluding routing-artifact legs on the
 * live DB.
 */
function hasDonationLegLinks(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'donation_leg_links'")
    .get() as { name: string } | undefined;
  return row != null;
}

/**
 * Routing-artifact legs are the SAME shares as their paired 'out' leg, kept
 * (never deleted) only so the import stays idempotent. Counting both would
 * double-subtract a donation.
 */
function artifactExclusionSql(db: Database.Database): string {
  return hasDonationLegLinks(db)
    ? "AND t.id NOT IN (SELECT transaction_id FROM donation_leg_links WHERE role = 'routing_artifact')"
    : "";
}

/** Quantity-carrying legs for ONE security, bucketed by type and split side. */
export function fetchLedgerLegs(
  db: Database.Database,
  securityId: number,
  splitDate: string | null
): LedgerLeg[] {
  const preExpr = splitDate ? "CASE WHEN t.trade_date < ? THEN 1 ELSE 0 END" : "0";
  const params: unknown[] = splitDate ? [splitDate, securityId] : [securityId];
  const rows = db
    .prepare(
      `SELECT t.type AS type,
              ${preExpr} AS pre_split,
              SUM(t.quantity) AS quantity,
              COUNT(*) AS row_count
         FROM transactions t
        WHERE t.security_id = ?
          AND t.quantity IS NOT NULL
          AND t.quantity != 0
          ${artifactExclusionSql(db)}
        GROUP BY t.type, pre_split`
    )
    .all(...params) as { type: string; pre_split: number; quantity: number; row_count: number }[];

  return rows.map((r) => ({
    type: r.type,
    quantity: r.quantity,
    rowCount: r.row_count,
    preSplit: r.pre_split === 1,
  }));
}

/**
 * Latest nonzero holdings quantity per security, summed across accounts.
 * Uses `latestHoldingsPredicate` (per-(account, security) MAX(as_of_date)) —
 * never a global MAX.
 */
export function fetchLatestHoldingsQtyBySecurity(db: Database.Database): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT h.security_id AS security_id, SUM(h.quantity) AS qty
         FROM holdings h
        WHERE ${latestHoldingsPredicate({ keyBy: "account_security" })}
        GROUP BY h.security_id`
    )
    .all() as { security_id: number; qty: number }[];
  return new Map(rows.map((r) => [r.security_id, r.qty]));
}

// ─── Report shapes ─────────────────────────────────────────────────────

export type TxnBasisStatus =
  | "security-not-found"
  | "no-pre-split-rows"
  | "needs-repair"
  | "already-normalized"
  | "unexpected-sum";

export type PriceBasisStatus =
  | "row-missing"
  | "needs-repair"
  | "already-normalized"
  | "unexpected-value";

export interface TxnRowPlan {
  id: number;
  tradeDate: string;
  type: string;
  oldQuantity: number;
  newQuantity: number;
  oldPrice: number | null;
  newPrice: number | null;
}

export interface PriceRowReport {
  date: string;
  status: PriceBasisStatus;
  message: string;
  oldClose: number | null;
  newClose: number | null;
  changed: boolean;
}

export interface SymbolReport {
  symbol: string;
  securityId: number | null;
  splitDate: string;
  ratio: number;
  status: TxnBasisStatus;
  message: string;
  expectedPreSplitTxnQty: number;
  actualPreSplitTxnQty: number;
  preSplitRowCount: number;
  rowPlans: TxnRowPlan[];
  /** True when the transaction rows were rewritten (apply) or would be (dry run). */
  changed: boolean;
  priceRows: PriceRowReport[];
  /** Audit-only: pre-split `holdings` rows. Expected 0; nonzero = REVIEW-NEEDED. */
  preSplitHoldingsRows: number;
  holdingsReview: "ok" | "review-needed";
  /** Audit-only ledger walk (null when the security is missing). */
  ledger: LedgerWalk | null;
}

export interface SiblingFinding {
  symbol: string;
  securityId: number;
  securityType: string | null;
  walked: number;
  latestHoldingsQty: number;
  residual: number;
  unrecognized: UnrecognizedLeg[];
  /** True when this symbol is one of the configured targets (a known case). */
  configured: boolean;
}

export interface AuditReport {
  applied: boolean;
  targets: SymbolReport[];
  /** Non-option securities whose position does not reconcile to their ledger. */
  siblings: SiblingFinding[];
  /** How many securities the sibling sweep examined. */
  siblingsScanned: number;
}

// ─── Core ──────────────────────────────────────────────────────────────

interface PreSplitTxnRow {
  id: number;
  trade_date: string;
  type: string;
  quantity: number;
  price_per_share: number | null;
}

/**
 * Audits (and with `apply: true` repairs) the pre-split transaction basis for
 * every configured target, then sweeps the whole portfolio for siblings.
 *
 * Every write is guarded on a known pre-split value, so:
 *   - a repaired DB re-reports as "already-normalized" and writes nothing
 *     (idempotent), and
 *   - a symbol whose live data matches neither guard state is refused
 *     outright rather than half-rewritten.
 *
 * All writes for all targets run inside ONE transaction.
 */
export function auditAndRepair(
  db: Database.Database,
  targets: SplitBasisAuditTarget[],
  opts: { apply: boolean }
): AuditReport {
  const reports: SymbolReport[] = [];
  // Holdings are never written by this script, so one read serves every target.
  const latestHoldings = fetchLatestHoldingsQtyBySecurity(db);

  const run = () => {
    for (const t of targets) {
      reports.push(auditOneTarget(db, t, opts.apply, latestHoldings));
    }
  };
  db.transaction(run)();

  const { siblings, scanned } = sweepSiblings(db, targets);
  return { applied: opts.apply, targets: reports, siblings, siblingsScanned: scanned };
}

function auditOneTarget(
  db: Database.Database,
  t: SplitBasisAuditTarget,
  apply: boolean,
  latestHoldings: Map<number, number>
): SymbolReport {
  const base: SymbolReport = {
    symbol: t.symbol,
    securityId: null,
    splitDate: t.splitDate,
    ratio: t.ratio,
    status: "security-not-found",
    message: `no non-option security with symbol ${t.symbol} — skipped`,
    expectedPreSplitTxnQty: t.expectedPreSplitTxnQty,
    actualPreSplitTxnQty: 0,
    preSplitRowCount: 0,
    rowPlans: [],
    changed: false,
    priceRows: [],
    preSplitHoldingsRows: 0,
    holdingsReview: "ok",
    ledger: null,
  };

  // Option rows never carry an underlying's split basis, and an OCC symbol
  // never equals a plain ticker anyway — excluding them keeps a stray
  // same-symbol option row from resolving as the target.
  const sec = db
    .prepare(
      `SELECT id, security_type FROM securities
        WHERE UPPER(symbol) = UPPER(?)
          AND (security_type IS NULL OR LOWER(security_type) != 'option')`
    )
    .get(t.symbol) as { id: number; security_type: string | null } | undefined;
  if (!sec) return base;

  const report: SymbolReport = { ...base, securityId: sec.id };

  // ── 1. transactions: guarded, product-preserving rewrite ─────────────
  const rows = db
    .prepare(
      `SELECT id, trade_date, type, quantity, price_per_share
         FROM transactions
        WHERE security_id = ? AND trade_date < ? AND quantity IS NOT NULL
        ORDER BY trade_date, id`
    )
    .all(sec.id, t.splitDate) as PreSplitTxnRow[];

  const sum = rows.reduce((acc, r) => acc + r.quantity, 0);
  report.preSplitRowCount = rows.length;
  report.actualPreSplitTxnQty = sum;

  const normalizedSum = t.expectedPreSplitTxnQty * t.ratio;
  if (rows.length === 0) {
    report.status = "no-pre-split-rows";
    report.message = `no transaction rows before ${t.splitDate} — nothing to normalize`;
  } else if (Math.abs(sum - normalizedSum) <= QTY_EPS) {
    report.status = "already-normalized";
    report.message =
      `pre-split quantity sum ${fmt(sum)} already equals expected x ratio ` +
      `(${fmt(t.expectedPreSplitTxnQty)} x ${t.ratio}) — no-op`;
  } else if (Math.abs(sum - t.expectedPreSplitTxnQty) > QTY_EPS) {
    report.status = "unexpected-sum";
    report.message =
      `UNEXPECTED pre-split quantity sum ${fmt(sum)} across ${rows.length} row(s) — ` +
      `guard expects ${fmt(t.expectedPreSplitTxnQty)} (pre-split) or ` +
      `${fmt(normalizedSum)} (already normalized). Refusing to touch these transaction rows.`;
  } else {
    report.status = "needs-repair";
    report.message =
      `pre-split quantity sum ${fmt(sum)} matches the guard — normalizing ` +
      `${rows.length} row(s) to the post-split basis (x${t.ratio})`;
    report.changed = true;
    report.rowPlans = rows.map((r) => ({
      id: r.id,
      tradeDate: r.trade_date,
      type: r.type,
      oldQuantity: r.quantity,
      newQuantity: r.quantity * t.ratio,
      oldPrice: r.price_per_share,
      newPrice: r.price_per_share != null ? r.price_per_share / t.ratio : null,
    }));

    if (apply) {
      const update = db.prepare(
        `UPDATE transactions SET quantity = ?, price_per_share = ? WHERE id = ?`
      );
      for (const plan of report.rowPlans) {
        update.run(plan.newQuantity, plan.newPrice, plan.id);
      }
    }
  }

  // ── 2. prices: same three-state guard, per configured row ────────────
  for (const pr of t.priceRows) {
    report.priceRows.push(auditPriceRow(db, sec.id, t.ratio, pr, apply));
  }

  // ── 3. audit-only: pre-split holdings rows ───────────────────────────
  const holdingCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM holdings WHERE security_id = ? AND as_of_date < ?`
      )
      .get(sec.id, t.splitDate) as { n: number }
  ).n;
  report.preSplitHoldingsRows = holdingCount;
  report.holdingsReview = holdingCount > 0 ? "review-needed" : "ok";

  // ── 4. audit-only: ledger walk ───────────────────────────────────────
  // When the rows still need repair we walk them AS IF normalized; once they
  // are normalized (already, or by this run's apply) the raw rows are correct
  // and the factor is 1. An UNEXPECTED symbol is walked raw — its basis is
  // unknown, so no hypothetical is honest.
  const preSplitFactor =
    report.status === "needs-repair" && !apply ? t.ratio : 1;
  const legs = fetchLedgerLegs(db, sec.id, t.splitDate);
  report.ledger = walkLedger(legs, preSplitFactor, latestHoldings.get(sec.id) ?? 0);

  return report;
}

function auditPriceRow(
  db: Database.Database,
  securityId: number,
  ratio: number,
  target: SplitBasisPriceRowTarget,
  apply: boolean
): PriceRowReport {
  const row = db
    .prepare(`SELECT id, close_price, source FROM prices WHERE security_id = ? AND date = ?`)
    .get(securityId, target.date) as
    | { id: number; close_price: number; source: string | null }
    | undefined;

  if (!row) {
    return {
      date: target.date,
      status: "row-missing",
      message: `no prices row on ${target.date} — skipped`,
      oldClose: null,
      newClose: null,
      changed: false,
    };
  }

  const newClose = target.preSplitClose / ratio;
  if (Math.abs(row.close_price - newClose) <= PRICE_EPS) {
    return {
      date: target.date,
      status: "already-normalized",
      message: `already normalized (${row.close_price})`,
      oldClose: row.close_price,
      newClose: row.close_price,
      changed: false,
    };
  }
  if (Math.abs(row.close_price - target.preSplitClose) > PRICE_EPS) {
    return {
      date: target.date,
      status: "unexpected-value",
      message:
        `UNEXPECTED close ${row.close_price} (guard expects ${target.preSplitClose} ` +
        `or ${newClose}) — refusing to touch`,
      oldClose: row.close_price,
      newClose: null,
      changed: false,
    };
  }

  if (apply) {
    db.prepare(`UPDATE prices SET close_price = ? WHERE id = ?`).run(newClose, row.id);
  }
  return {
    date: target.date,
    status: "needs-repair",
    message: `${row.close_price} -> ${newClose} (${row.source ?? "?"})`,
    oldClose: row.close_price,
    newClose,
    changed: true,
  };
}

/**
 * Audit-only portfolio sweep: every non-option security that has
 * quantity-carrying transaction rows AND a latest nonzero holding gets the
 * same ledger walk with NO split adjustment. A |residual| over QTY_EPS means
 * the position does not reconcile to its transaction history — the fingerprint
 * of untranscribed rows or an unapplied split.
 *
 * Runs AFTER any repair writes, so a symbol this run just fixed reports its
 * post-repair state.
 */
export function sweepSiblings(
  db: Database.Database,
  targets: SplitBasisAuditTarget[]
): { siblings: SiblingFinding[]; scanned: number } {
  const configured = new Set(targets.map((t) => t.symbol.toUpperCase()));
  const latestBySecurity = fetchLatestHoldingsQtyBySecurity(db);

  const rows = db
    .prepare(
      `SELECT s.id AS security_id, s.symbol AS symbol, s.security_type AS security_type,
              t.type AS type, SUM(t.quantity) AS quantity, COUNT(*) AS row_count
         FROM transactions t
         JOIN securities s ON s.id = t.security_id
        WHERE t.quantity IS NOT NULL
          AND t.quantity != 0
          AND (s.security_type IS NULL OR LOWER(s.security_type) != 'option')
          ${artifactExclusionSql(db)}
        GROUP BY s.id, t.type`
    )
    .all() as {
    security_id: number;
    symbol: string;
    security_type: string | null;
    type: string;
    quantity: number;
    row_count: number;
  }[];

  const bySecurity = new Map<
    number,
    { symbol: string; securityType: string | null; legs: LedgerLeg[] }
  >();
  for (const r of rows) {
    if (!latestBySecurity.has(r.security_id)) continue; // no live position
    let entry = bySecurity.get(r.security_id);
    if (!entry) {
      entry = { symbol: r.symbol, securityType: r.security_type, legs: [] };
      bySecurity.set(r.security_id, entry);
    }
    entry.legs.push({
      type: r.type,
      quantity: r.quantity,
      rowCount: r.row_count,
      preSplit: false,
    });
  }

  const siblings: SiblingFinding[] = [];
  for (const [securityId, entry] of bySecurity) {
    const walk = walkLedger(entry.legs, 1, latestBySecurity.get(securityId) ?? 0);
    if (walk.ties) continue;
    siblings.push({
      symbol: entry.symbol,
      securityId,
      securityType: entry.securityType,
      walked: walk.walked,
      latestHoldingsQty: walk.latestHoldingsQty,
      residual: walk.residual,
      unrecognized: walk.unrecognized,
      configured: configured.has(entry.symbol.toUpperCase()),
    });
  }
  siblings.sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
  return { siblings, scanned: bySecurity.size };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

// ─── Report printing ───────────────────────────────────────────────────

export function formatReport(report: AuditReport): string {
  const out: string[] = [];
  const mode = report.applied ? "[APPLY]" : "[DRY RUN]";

  out.push(`\n── Pre-split transaction-basis audit ${mode} ──`);
  if (report.targets.length === 0) {
    out.push("  (no targets configured — sweep-only mode)");
  }

  for (const t of report.targets) {
    out.push(`\n  ${t.symbol}  split ${t.splitDate}  ratio x${t.ratio}  [${t.status}]`);
    out.push(`    ${t.message}`);
    for (const p of t.rowPlans) {
      out.push(
        `    txn ${p.id} (${p.type} ${p.tradeDate}): ${fmt(p.oldQuantity)} sh @ ` +
          `${p.oldPrice ?? "—"} -> ${fmt(p.newQuantity)} sh @ ` +
          `${p.newPrice != null ? p.newPrice.toFixed(6) : "—"} (amount + source_key unchanged)`
      );
    }
    for (const pr of t.priceRows) {
      out.push(`    prices ${pr.date}: [${pr.status}] ${pr.message}`);
    }
    out.push(
      `    holdings before ${t.splitDate}: ${t.preSplitHoldingsRows} row(s)` +
        (t.holdingsReview === "review-needed"
          ? " — REVIEW-NEEDED (pre-split holdings rows are NOT touched by this script)"
          : "")
    );
    if (t.ledger) {
      const l = t.ledger;
      out.push(
        `    ledger walk: +${fmt(l.added)} / -${fmt(l.subtracted)} = ${fmt(l.walked)} vs ` +
          `holdings ${fmt(l.latestHoldingsQty)} -> residual ${fmt(l.residual)} ` +
          (l.ties ? "(TIES)" : "(does NOT tie — rows still missing from the ledger)")
      );
      if (l.unrecognized.length > 0) {
        out.push(
          `      unrecognized quantity-carrying types (excluded from the walk): ` +
            l.unrecognized.map((u) => `${u.type} x${u.rows} (${fmt(u.quantity)} sh)`).join(", ")
        );
      }
      if (l.engineSyntheticRows > 0) {
        out.push(
          `      ${l.engineSyntheticRows} engine-owned RECONCILE_CLOSE row(s) excluded ` +
            `(never treated as broker activity)`
        );
      }
    }
  }

  out.push(
    `\n── Sibling sweep (audit-only) — ${report.siblings.length} of ` +
      `${report.siblingsScanned} scanned securities do not reconcile ──`
  );
  if (report.siblings.length === 0) {
    out.push("  Every scanned position ties to its transaction history.");
  }
  for (const s of report.siblings) {
    out.push(
      `  ${s.symbol.padEnd(8)} ledger ${fmt(s.walked)} vs holdings ` +
        `${fmt(s.latestHoldingsQty)} -> residual ${fmt(s.residual)}` +
        (s.configured ? "  [configured target — known]" : "")
    );
    out.push(
      `           position does not reconcile to transaction history ` +
        `(possible untranscribed rows or unapplied split)`
    );
    if (s.unrecognized.length > 0) {
      out.push(
        `           unrecognized types: ` +
          s.unrecognized.map((u) => `${u.type} x${u.rows} (${fmt(u.quantity)} sh)`).join(", ")
      );
    }
  }

  return out.join("\n");
}

// ─── CLI entry point ───────────────────────────────────────────────────

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-split-basis-audit.ts") ||
    process.argv[1].endsWith("repair-split-basis-audit.js"));

if (isMain) {
  (async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { computeTaxLots } = await import("@/lib/compute/tax-lots");
    const path = await import("node:path");
    const fs = await import("node:fs");

    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const dbFlagIdx = args.indexOf("--db");
    const dataDir = process.env.VANGUARD_DB_DIR || path.default.join(process.cwd(), "data");
    const dbPath =
      dbFlagIdx !== -1 && args[dbFlagIdx + 1]
        ? args[dbFlagIdx + 1]
        : path.default.join(dataDir, "vanguard.db");

    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
      return;
    }

    const configPath = path.default.join(dataDir, "repair-configs", "split-basis-audit.json");
    if (!fs.default.existsSync(configPath)) {
      console.error(
        `Config not found at ${configPath}\n` +
          `The affected symbols + guard values are real portfolio data and live ` +
          `outside git. Create the file as a JSON array of targets:\n${CONFIG_EXAMPLE}\n` +
          `(ratio = post_shares / pre_shares; expectedPreSplitTxnQty is the known SUM of ` +
          `transactions.quantity over the security's rows before splitDate, used as the ` +
          `write guard. An empty array [] runs the sibling sweep only.)`
      );
      process.exit(1);
      return;
    }

    let targets: SplitBasisAuditTarget[];
    try {
      targets = parseConfig(JSON.parse(fs.default.readFileSync(configPath, "utf-8")));
    } catch (err) {
      console.error(`Bad config at ${configPath}: ${(err as Error).message}`);
      process.exit(1);
      return;
    }

    // 60s lock wait — the live app's background sync can hold the write lock
    // past better-sqlite3's 5s default.
    const db = new BetterSqlite3(dbPath, { timeout: 60000 });
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    const plan = auditAndRepair(db, targets, { apply: false });
    console.log(formatReport(plan));

    const anythingToDo =
      plan.targets.some((t) => t.changed) ||
      plan.targets.some((t) => t.priceRows.some((p) => p.changed));

    if (!anythingToDo) {
      console.log("\nNothing to repair — all configured rows are already normalized or refused.");
      db.close();
      return;
    }
    if (!apply) {
      console.log("\nDry-run (default). Re-run with --apply to write.");
      db.close();
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.default.join(dataDir, "backups");
    fs.default.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.default.join(
      backupDir,
      `pre-split-basis-audit-${timestamp}.db`
    );
    db.prepare(`VACUUM INTO ?`).run(backupPath);
    console.log(`\nBackup: ${backupPath}`);

    const applied = auditAndRepair(db, targets, { apply: true });
    console.log(formatReport(applied));

    const lots = computeTaxLots(db);
    console.log(`\nTax lots recomputed (${lots.lotsCreated} lots).`);
    console.log("Recompute valuations: POST /api/compute/valuations");
    db.close();
  })();
}
