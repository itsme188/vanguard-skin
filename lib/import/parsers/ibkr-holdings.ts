import Papa from "papaparse";
import type { ParsedImportResult, ParsedHolding, ParsedSecurity } from "../types";

interface IbkrHoldingRow {
  account: string;
  symbol: string;
  name: string;
  type: string;
  quantity: string;
  price: string;
  cost_basis: string;
  balance: string;
}

export function parseIbkrHoldings(
  content: string,
  filename: string
): ParsedImportResult {
  const parsed = Papa.parse<IbkrHoldingRow>(content, {
    header: true,
    skipEmptyLines: true,
  });

  const today = new Date().toISOString().slice(0, 10);
  const holdings: ParsedHolding[] = [];
  const securitiesMap = new Map<string, ParsedSecurity>();
  const errors: string[] = [];

  for (const row of parsed.data) {
    if (!row.symbol || !row.quantity) continue;

    const quantity = parseFloat(row.quantity);
    const costBasis = parseFloat(row.cost_basis);
    const marketValue = parseFloat(row.balance);

    if (isNaN(quantity)) continue;

    holdings.push({
      accountName: "IBKR",
      symbol: row.symbol,
      securityName: row.name,
      quantity,
      costBasis: isNaN(costBasis) ? undefined : costBasis,
      marketValue: isNaN(marketValue) ? undefined : marketValue,
      asOfDate: today,
      sourceKey: `ibkr:holding:${row.symbol}:${today}`,
    });

    securitiesMap.set(row.symbol, {
      symbol: row.symbol,
      name: row.name,
      securityType: row.type,
    });
  }

  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      errors.push(`CSV parse error at row ${e.row}: ${e.message}`);
    }
  }

  return {
    sourceType: "ibkr-holdings",
    sourceName: filename,
    transactions: [],
    securities: Array.from(securitiesMap.values()),
    holdings,
    prices: [],
    snapshots: [],
    corporateActions: [],
    errors,
    warnings: [],
  };
}
