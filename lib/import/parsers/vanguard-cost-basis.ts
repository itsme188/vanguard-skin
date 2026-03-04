import Papa from "papaparse";
import type { ParsedImportResult, ParsedHolding, ParsedSecurity } from "../types";

interface VanguardCostBasisRow {
  symbol: string;
  name: string;
  type: string;
  account: string;
  cost_basis_method: string;
  quantity: string;
  cost_per_share: string;
  total_cost: string;
  market_value: string;
  short_term_gain_loss: string;
  long_term_gain_loss: string;
  total_gain_loss: string;
  percent_gain_loss: string;
}

const ACCOUNT_MAP: Record<string, string> = {
  Brokerage: "Vanguard Taxable",
  "Roth IRA": "Vanguard Roth IRA",
};

export function parseVanguardCostBasis(
  content: string,
  filename: string
): ParsedImportResult {
  const parsed = Papa.parse<VanguardCostBasisRow>(content, {
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
    const totalCost = parseFloat(row.total_cost);
    const marketValue = parseFloat(row.market_value);
    const accountName = ACCOUNT_MAP[row.account] || row.account;

    if (isNaN(quantity)) continue;

    holdings.push({
      accountName,
      symbol: row.symbol,
      securityName: row.name,
      quantity,
      costBasis: isNaN(totalCost) ? undefined : totalCost,
      marketValue: isNaN(marketValue) ? undefined : marketValue,
      asOfDate: today,
      sourceKey: `vanguard:costbasis:${accountName}:${row.symbol}:${today}`,
    });

    if (!securitiesMap.has(row.symbol)) {
      securitiesMap.set(row.symbol, {
        symbol: row.symbol,
        name: row.name,
        securityType: row.type,
      });
    }
  }

  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      errors.push(`CSV parse error at row ${e.row}: ${e.message}`);
    }
  }

  return {
    sourceType: "vanguard-cost-basis",
    sourceName: filename,
    transactions: [],
    securities: Array.from(securitiesMap.values()),
    holdings,
    prices: [],
    snapshots: [],
    errors,
    warnings: [],
  };
}
