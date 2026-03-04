import Papa from "papaparse";
import type { ParsedImportResult, ParsedSnapshot } from "../types";

interface MonthlyValueRow {
  date: string;
  month: string;
  year: string;
  [key: string]: string;
}

// Map CSV column names to account names
const ACCOUNT_COLUMN_MAP: Record<string, string> = {
  ibkr: "IBKR",
  vanguard_taxable: "Vanguard Taxable",
  vanguard_roth: "Vanguard Roth IRA",
};

export function parseMonthlyValues(
  content: string,
  filename: string
): ParsedImportResult {
  const parsed = Papa.parse<MonthlyValueRow>(content, {
    header: true,
    skipEmptyLines: true,
  });

  const snapshots: ParsedSnapshot[] = [];
  const errors: string[] = [];

  // Find account columns (anything beyond date, month, year)
  const headers = parsed.meta.fields || [];
  const accountColumns = headers.filter(
    (h) => !["date", "month", "year"].includes(h)
  );

  for (const row of parsed.data) {
    if (!row.date) continue;

    for (const col of accountColumns) {
      const value = parseFloat(row[col]);
      if (isNaN(value)) continue;

      const accountName = ACCOUNT_COLUMN_MAP[col] || col;

      snapshots.push({
        accountName,
        monthEndDate: row.date,
        totalValue: value,
        source: "monthly-values",
      });
    }
  }

  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      errors.push(`CSV parse error at row ${e.row}: ${e.message}`);
    }
  }

  return {
    sourceType: "monthly-values",
    sourceName: filename,
    transactions: [],
    securities: [],
    holdings: [],
    prices: [],
    snapshots,
    errors,
    warnings: [],
  };
}
