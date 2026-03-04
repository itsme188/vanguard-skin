import Papa from "papaparse";
import type {
  ParsedImportResult,
  ParsedHolding,
  ParsedSecurity,
  ParsedPrice,
} from "../types";

interface VanguardHoldingRow {
  symbol: string;
  name: string;
  type: string;
  price: string;
  quantity: string;
  value: string;
}

export function parseVanguardHoldings(
  content: string,
  filename: string
): ParsedImportResult {
  const parsed = Papa.parse<VanguardHoldingRow>(content, {
    header: true,
    skipEmptyLines: true,
  });

  const today = new Date().toISOString().slice(0, 10);
  const holdings: ParsedHolding[] = [];
  const securitiesMap = new Map<string, ParsedSecurity>();
  const pricesMap = new Map<string, ParsedPrice>();
  const errors: string[] = [];

  for (const row of parsed.data) {
    if (!row.symbol || !row.quantity) continue;

    const quantity = parseFloat(row.quantity);
    const price = parseFloat(row.price);
    const value = parseFloat(row.value);

    if (isNaN(quantity)) continue;

    // Vanguard holdings CSV doesn't specify which account — default to Taxable
    // (the cost basis CSV has per-account breakdown)
    holdings.push({
      accountName: "Vanguard Taxable",
      symbol: row.symbol,
      securityName: row.name,
      quantity,
      marketValue: isNaN(value) ? undefined : value,
      asOfDate: today,
      sourceKey: `vanguard:holding:${row.symbol}:${today}`,
    });

    securitiesMap.set(row.symbol, {
      symbol: row.symbol,
      name: row.name,
      securityType: row.type,
    });

    if (!isNaN(price) && price > 0) {
      pricesMap.set(row.symbol, {
        symbol: row.symbol,
        date: today,
        closePrice: price,
        source: "vanguard-holdings",
      });
    }
  }

  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      errors.push(`CSV parse error at row ${e.row}: ${e.message}`);
    }
  }

  return {
    sourceType: "vanguard-holdings",
    sourceName: filename,
    transactions: [],
    securities: Array.from(securitiesMap.values()),
    holdings,
    prices: Array.from(pricesMap.values()),
    snapshots: [],
    errors,
    warnings: [],
  };
}
