import type Database from "better-sqlite3";
import { getClosedTaxLotSales, type TaxLotSaleWithDetails } from "@/lib/queries/tax-lots";

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
}

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
  year: number
): TaxReportResult {
  const sales = getClosedTaxLotSales(db, year);
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

    const row: Form8949Row = {
      description: `${sale.quantity_sold} sh ${sale.symbol}`,
      dateAcquired: toMMDDYYYY(sale.acquisition_date),
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
    };

    if (sale.is_long_term === 1) {
      longTermRows.push(row);
    } else {
      shortTermRows.push(row);
    }
  }

  // Compute totals
  function sumRows(rows: Form8949Row[]) {
    return {
      proceeds: rows.reduce((s, r) => s + r.proceeds, 0),
      costBasis: rows.reduce((s, r) => s + r.costBasis, 0),
      adjustments: rows.reduce((s, r) => s + r.adjustmentAmount, 0),
      gainLoss: rows.reduce((s, r) => s + r.gainOrLoss, 0),
    };
  }

  return {
    year,
    shortTermRows,
    longTermRows,
    shortTermTotal: sumRows(shortTermRows),
    longTermTotal: sumRows(longTermRows),
    washSaleWarnings: washWarnings,
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

  return lines.join("\n");
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

  // TXF header
  lines.push("V042"); // TXF version 042
  lines.push(`APortfolio Desk`);
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
