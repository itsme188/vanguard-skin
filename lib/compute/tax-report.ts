import type Database from "better-sqlite3";
import { getClosedTaxLotSales, type TaxLotSaleWithDetails } from "@/lib/queries/tax-lots";
import { getTaxConventionState, isYearAccepted } from "@/lib/compute/tax-convention";

// ─── Types ──────────────────────────────────────────────────────

export interface Form8949Row {
  description: string; // e.g., "100 sh AAPL"
  dateAcquired: string; // MM/DD/YYYY
  dateSold: string; // MM/DD/YYYY
  proceeds: number;
  costBasis: number;
  adjustmentCode: string; // "W" for wash sale, "" otherwise
  adjustmentAmount: number;
  gainOrLoss: number;
  isLongTerm: boolean;
  // Extra fields for UI display
  symbol: string;
  accountName: string;
  holdingPeriodDays: number;
  isWashSale: boolean;
  currency: string; // realized figures are native per security (8949 FX out of scope)
}

export interface WashSaleWarning {
  saleId: number;
  symbol: string;
  saleDate: string;
  purchaseDate: string;
  lossAmount: number;
  description: string;
}

export interface TaxReportResult {
  year: number;
  shortTermRows: Form8949Row[];
  longTermRows: Form8949Row[];
  shortTermTotal: { proceeds: number; costBasis: number; adjustments: number; gainLoss: number };
  longTermTotal: { proceeds: number; costBasis: number; adjustments: number; gainLoss: number };
  washSaleWarnings: WashSaleWarning[];
  /**
   * Sales on non-USD securities excluded from the USD totals above (same
   * convention as TaxLotSummary.excludedNonUsdSales — realized figures are
   * stored native per security and no FX vintage is ever fabricated on tax
   * rows). The row arrays still carry them for the raw 8949 export.
   */
  excludedNonUsdSales: number;
  /**
   * Marker-gated filing readiness (number-trust durable fixes, WS1). True
   * only when EVERY account with any tax_lot_sales activity this year (not
   * just the filing-eligible rows) has a broker-acceptance stamp bound to
   * the current tax-input generation. Fail-closed by construction — see
   * generateTaxReport for the exact guard.
   */
  filingReady: boolean;
  /** Static disclosure about the heuristic wash-sale (W-code) detection; see `washSaleAdvisory`. */
  washSaleAdvisory: string;
  /**
   * The account this report is scoped to (`accounts.name`, matching the Tax
   * Lots page's ?account= filter), or null for all accounts. Echoed back so
   * every downstream surface — card heading, CSV scope note, TXF header,
   * export filename — declares the same scope the numbers were computed
   * under. A partial export must never be able to pass for the full report.
   */
  accountName: string | null;
}

export interface TaxReportOptions {
  /**
   * Narrow the report to one account by `accounts.name` (the Tax Lots page
   * passes its ?account= value straight through). Empty/undefined = all
   * accounts, byte-identical to the pre-filter behaviour.
   */
  accountName?: string | null;
}

/**
 * detectWashSales flags same-security purchases within a 30-day window of a
 * loss sale — a heuristic scan, not a broker-confirmed determination. This
 * travels with every report (UI + CSV) so a reader never mistakes "W" codes
 * for reconciled 1099-B adjustments. The TXF body stays untouched (a
 * trailing comment line is not valid TXF).
 */
export const washSaleAdvisory =
  "W adjustment codes are heuristic estimates (30-day same-security scan) pending 1099-B reconciliation — verify before filing.";

// ─── Date helpers ───────────────────────────────────────────────

function toMMDDYYYY(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return `${m}/${d}/${y}`;
}

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(dateA + "T00:00:00");
  const b = new Date(dateB + "T00:00:00");
  return Math.abs(Math.round((b.getTime() - a.getTime()) / (24 * 3600 * 1000)));
}

// ─── Wash Sale Detection ────────────────────────────────────────

/**
 * Detect potential wash sales by finding purchases of the same security
 * within 30 days before or after a loss sale.
 *
 * Account scope note: `sales` may already be narrowed to one account, but
 * the PURCHASE scan deliberately is not — IRS wash-sale rules look across a
 * taxpayer's accounts, and keeping the scan global also makes the flag for
 * any given sale identical whether or not a filter is active (the
 * conservation identity in tests/compute/tax-report-account-scope.test.ts:
 * a scoped export is the same rows, filtered — never differently computed).
 */
function detectWashSales(
  db: Database.Database,
  sales: TaxLotSaleWithDetails[],
  year: number
): WashSaleWarning[] {
  const warnings: WashSaleWarning[] = [];

  // Get all tax lot acquisitions (purchases) for securities that had sales
  const securityIds = [...new Set(sales.map((s) => s.security_id))];
  if (securityIds.length === 0) return [];

  const purchases = db
    .prepare(
      `SELECT tl.security_id, s.symbol, tl.acquisition_date, tl.quantity_acquired
       FROM tax_lots tl
       JOIN securities s ON s.id = tl.security_id
       WHERE tl.security_id IN (${securityIds.map(() => "?").join(",")})
         AND tl.is_from_opening_snapshot = 0
       ORDER BY tl.acquisition_date`
    )
    .all(...securityIds) as {
    security_id: number;
    symbol: string;
    acquisition_date: string;
    quantity_acquired: number;
  }[];

  // Build purchase lookup by security
  const purchasesBySecId = new Map<number, typeof purchases>();
  for (const p of purchases) {
    if (!purchasesBySecId.has(p.security_id)) {
      purchasesBySecId.set(p.security_id, []);
    }
    purchasesBySecId.get(p.security_id)!.push(p);
  }

  // Check each loss sale
  for (const sale of sales) {
    if (sale.realized_gain_loss >= 0) continue; // only check losses

    const secPurchases = purchasesBySecId.get(sale.security_id);
    if (!secPurchases) continue;

    for (const purchase of secPurchases) {
      // Skip if the purchase IS the same lot being sold
      if (purchase.acquisition_date === sale.acquisition_date) continue;

      const daysFromSale = daysBetween(sale.sale_date, purchase.acquisition_date);
      if (daysFromSale <= 30) {
        // Purchase is within 30-day wash sale window
        warnings.push({
          saleId: sale.id,
          symbol: sale.symbol,
          saleDate: sale.sale_date,
          purchaseDate: purchase.acquisition_date,
          lossAmount: sale.realized_gain_loss,
          description: `Sold ${sale.symbol} at loss on ${sale.sale_date}, repurchased on ${purchase.acquisition_date} (${daysFromSale} days)`,
        });
        break; // One warning per sale is enough
      }
    }
  }

  return warnings;
}

// ─── Form 8949 Generation ───────────────────────────────────────

export function generateTaxReport(
  db: Database.Database,
  year: number,
  opts?: TaxReportOptions
): TaxReportResult {
  // Account scope is owned here, not by the route or the card: the Tax Lots
  // page filters its tables on the same `account_name` string, so computing
  // the report from that identical predicate is what keeps the TAX REPORT
  // card, the tables and the CSV/TXF downloads describing one population.
  const accountName = opts?.accountName ? opts.accountName : null;

  // filingOnly: exclude premium-rollover option closes and engine-synthesized
  // RECONCILE_CLOSE rows from anything destined for a filing surface (Task 5).
  const allSales = getClosedTaxLotSales(db, year, { filingOnly: true });
  const sales =
    accountName == null ? allSales : allSales.filter((s) => s.account_name === accountName);
  const washWarnings = detectWashSales(db, sales, year);

  // Build wash sale lookup: saleId → warning
  const washBySaleId = new Map<number, WashSaleWarning>();
  for (const w of washWarnings) {
    washBySaleId.set(w.saleId, w);
  }

  const shortTermRows: Form8949Row[] = [];
  const longTermRows: Form8949Row[] = [];

  for (const sale of sales) {
    const wash = washBySaleId.get(sale.id);
    const isWash = !!wash;

    // Short round-trip lots (is_short=1): the sale row's own "sale_date" IS
    // the cover trade (the disposition IRS cares about) — the acquisition
    // side is the SELL_TO_OPEN, which is not a purchase for 8949 purposes.
    // Both 8949 date columns carry the cover date. holdingPeriodDays below
    // is unchanged (already signed negative for shorts at the source).
    const row: Form8949Row = {
      description: `${sale.quantity_sold} sh ${sale.symbol}`,
      dateAcquired: sale.is_short === 1 ? toMMDDYYYY(sale.sale_date) : toMMDDYYYY(sale.acquisition_date),
      dateSold: toMMDDYYYY(sale.sale_date),
      proceeds: sale.proceeds,
      costBasis: sale.cost_basis_allocated,
      adjustmentCode: isWash ? "W" : "",
      adjustmentAmount: isWash ? Math.abs(sale.realized_gain_loss) : 0,
      gainOrLoss: isWash
        ? 0 // Wash sale: loss is disallowed
        : sale.realized_gain_loss,
      isLongTerm: sale.is_long_term === 1,
      symbol: sale.symbol,
      accountName: sale.account_name,
      holdingPeriodDays: sale.holding_period_days,
      isWashSale: isWash,
      currency: sale.currency,
    };

    if (sale.is_long_term === 1) {
      longTermRows.push(row);
    } else {
      shortTermRows.push(row);
    }
  }

  // Compute totals — USD rows only. Realized figures are native per
  // security (a KRW won amount must never sum behind a $ glyph); non-USD
  // rows stay in the row arrays for the raw export and are disclosed via
  // excludedNonUsdSales, mirroring getTaxLotSummary.
  function sumRows(rows: Form8949Row[]) {
    const usd = rows.filter((r) => r.currency === "USD");
    return {
      proceeds: usd.reduce((s, r) => s + r.proceeds, 0),
      costBasis: usd.reduce((s, r) => s + r.costBasis, 0),
      adjustments: usd.reduce((s, r) => s + r.adjustmentAmount, 0),
      gainLoss: usd.reduce((s, r) => s + r.gainOrLoss, 0),
    };
  }
  const excludedNonUsdSales =
    shortTermRows.filter((r) => r.currency !== "USD").length +
    longTermRows.filter((r) => r.currency !== "USD").length;

  // filingReady, fail-closed against the EXPLICIT account universe (Codex
  // plan review #12): derived straight from tax_lot_sales for the year —
  // NOT from `sales` above, which is already filingOnly-filtered. An
  // account whose only 2025 activity is a RECONCILE_CLOSE row must still
  // be broker-accepted before the year is "ready"; and an empty universe
  // must never satisfy `.every()` vacuously (isYearAccepted's own
  // accountIds.every check would return true on an empty array).
  //
  // Under an account filter the universe narrows to THAT account — the gate
  // is per (account, tax-year) by construction, so a Roth-scoped export
  // clears exactly when the Roth account is broker-accepted for the year,
  // and a Taxable acceptance can never launder it. Nothing is bypassed: an
  // account name that matches nothing yields an empty universe, which the
  // length guard below fails closed.
  const state = getTaxConventionState(db);
  const accountIds = (
    db
      .prepare(
        `SELECT DISTINCT tl.account_id FROM tax_lot_sales tls
           JOIN tax_lots tl ON tl.id = tls.tax_lot_id
           ${accountName == null ? "" : "JOIN accounts a ON a.id = tl.account_id"}
          WHERE tls.sale_date >= ? AND tls.sale_date <= ?
            ${accountName == null ? "" : "AND a.name = ?"}`
      )
      .all(
        ...(accountName == null
          ? [`${year}-01-01`, `${year}-12-31`]
          : [`${year}-01-01`, `${year}-12-31`, accountName])
      ) as { account_id: number }[]
  ).map((r) => r.account_id);
  const filingReady =
    accountIds.length > 0 &&
    state.recomputeCurrent &&
    isYearAccepted(state, year, accountIds);

  return {
    year,
    shortTermRows,
    longTermRows,
    shortTermTotal: sumRows(shortTermRows),
    longTermTotal: sumRows(longTermRows),
    washSaleWarnings: washWarnings,
    excludedNonUsdSales,
    filingReady,
    washSaleAdvisory,
    accountName,
  };
}

// ─── CSV Export ──────────────────────────────────────────────────

export function generateForm8949CSV(report: TaxReportResult): string {
  const header = [
    "Term",
    "Description",
    "Date Acquired",
    "Date Sold",
    "Proceeds",
    "Cost Basis",
    "Adj Code",
    "Adj Amount",
    "Gain or Loss",
    "Account",
  ].join(",");

  function escapeCSV(value: string | number): string {
    const str = typeof value === "number" ? value.toFixed(2) : value;
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function rowToCSV(row: Form8949Row, term: string): string {
    return [
      term,
      escapeCSV(row.description),
      row.dateAcquired,
      row.dateSold,
      row.proceeds.toFixed(2),
      row.costBasis.toFixed(2),
      row.adjustmentCode,
      row.adjustmentAmount > 0 ? row.adjustmentAmount.toFixed(2) : "",
      row.gainOrLoss.toFixed(2),
      escapeCSV(row.accountName),
    ].join(",");
  }

  const lines = [header];

  // Short-term first
  for (const row of report.shortTermRows) {
    lines.push(rowToCSV(row, "Short-Term"));
  }
  if (report.shortTermRows.length > 0) {
    lines.push(
      `Short-Term Totals,,,,${report.shortTermTotal.proceeds.toFixed(2)},${report.shortTermTotal.costBasis.toFixed(2)},,${report.shortTermTotal.adjustments > 0 ? report.shortTermTotal.adjustments.toFixed(2) : ""},${report.shortTermTotal.gainLoss.toFixed(2)},`
    );
  }

  // Long-term
  for (const row of report.longTermRows) {
    lines.push(rowToCSV(row, "Long-Term"));
  }
  if (report.longTermRows.length > 0) {
    lines.push(
      `Long-Term Totals,,,,${report.longTermTotal.proceeds.toFixed(2)},${report.longTermTotal.costBasis.toFixed(2)},,${report.longTermTotal.adjustments > 0 ? report.longTermTotal.adjustments.toFixed(2) : ""},${report.longTermTotal.gainLoss.toFixed(2)},`
    );
  }

  // Scope disclosure: a single-account file holds a SUBSET of the year's
  // dispositions, so the file itself says so — the filename slug alone can
  // be lost to a rename. Emitted only when filtered, so the all-accounts
  // CSV is byte-identical to before.
  if (report.accountName) {
    lines.push(
      `Note: PARTIAL EXPORT — ${escapeCSV(report.accountName)} only. Not the complete Form 8949 for ${report.year}.`
    );
  }

  // Trailing disclosure footer (CSV/UI only — a trailing comment line is
  // not valid TXF, so the TXF body stays untouched). Stays the LAST line.
  lines.push(`Note: ${report.washSaleAdvisory}`);

  return lines.join("\n");
}

// ─── Filename builder ────────────────────────────────────────────

/**
 * Account name -> filename-safe slug: lowercase, non-alphanumeric runs
 * collapsed to one hyphen, trimmed. Returns "" when nothing usable survives
 * (the caller then falls back to the unscoped name rather than emitting a
 * dangling separator). Never produces a path separator.
 */
export function slugifyAccountName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Single-sourced export filename for both the CSV and TXF downloads.
 * Appends "-NOT-FOR-FILING" unless the report is marker-gated filingReady
 * (see generateTaxReport). The route's Content-Disposition and
 * TaxReportCard's client-side download both call this — never re-derive
 * the name inline (Codex plan review #12).
 *
 * `accountName` (the Tax Lots ?account= filter) inserts an account slug
 * before the marker — form-8949-2022-vanguard-roth-ira-NOT-FOR-FILING.csv —
 * so a single-account file can never sit on disk looking like the full
 * year's Form 8949. The marker itself is unchanged: it still keys purely on
 * filingReady, which generateTaxReport derives per (account, tax-year).
 */
export function buildTaxReportFilename(
  kind: "csv" | "txf",
  year: number,
  filingReady: boolean,
  accountName?: string | null
): string {
  const slug = accountName ? slugifyAccountName(accountName) : "";
  const base =
    (kind === "csv" ? `form-8949-${year}` : `tax-report-${year}`) + (slug ? `-${slug}` : "");
  return filingReady ? `${base}.${kind}` : `${base}-NOT-FOR-FILING.${kind}`;
}

// ─── TXF Export (TurboTax Tax Exchange Format) ──────────────────

/**
 * Generate TXF file for TurboTax import.
 *
 * TXF format: line-based records with type codes.
 * Code 321 = Short-term sale (Form 8949 Part I)
 * Code 323 = Long-term sale (Form 8949 Part II)
 *
 * Each record: header line (V + version), type line (TD + code),
 * then data lines (D + date, N + description, $ + amount, etc.)
 */
export function generateTXF(report: TaxReportResult): string {
  const lines: string[] = [];

  // TXF header. The `A` record is the free-text source name — when the
  // report is account-scoped it carries that scope, so a partial file
  // announces itself inside TurboTax too. (No trailing comment line: that
  // is not valid TXF, so the record BODY stays untouched.)
  lines.push("V042"); // TXF version 042
  lines.push(
    report.accountName
      ? `APortfolio Desk — PARTIAL EXPORT: ${report.accountName} only`
      : `APortfolio Desk`
  );
  lines.push(`D${toMMDDYYYY(`${report.year}-12-31`)}`);
  lines.push("^"); // end of header

  function emitSale(row: Form8949Row, typeCode: number) {
    lines.push(`TD`);
    lines.push(`N${typeCode}`);
    lines.push(`C1`); // copy 1
    lines.push(`L1`); // line 1
    lines.push(`P${row.description}`);
    lines.push(`D${row.dateAcquired}`);
    lines.push(`D${row.dateSold}`);
    lines.push(`$${row.costBasis.toFixed(2)}`);
    lines.push(`$${row.proceeds.toFixed(2)}`);
    if (row.adjustmentCode === "W") {
      lines.push(`$${row.adjustmentAmount.toFixed(2)}`);
    }
    lines.push("^"); // end of record
  }

  // Short-term sales (code 321)
  for (const row of report.shortTermRows) {
    emitSale(row, 321);
  }

  // Long-term sales (code 323)
  for (const row of report.longTermRows) {
    emitSale(row, 323);
  }

  return lines.join("\n");
}
