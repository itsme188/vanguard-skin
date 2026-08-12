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

// Map Vanguard account numbers to our account names (for direct-export format)
const ACCOUNT_NUMBER_MAP: Record<string, string> = {
  "76501494": "Vanguard Taxable",
  "34133612": "Vanguard Roth IRA",
};

// Vanguard direct-export uses " - " for null values
function parseVanguardNum(val: string | undefined): number {
  if (!val || val.trim() === "-" || val.trim() === "") return NaN;
  return parseFloat(val.replace(/[$,]/g, ""));
}

function isDirectExportFormat(content: string): boolean {
  const lines = content.split("\n").slice(0, 5);
  return lines.some((l) => l.startsWith("Account,Symbol/CUSIP,Description,Position type"));
}

function parseDirectExport(content: string, filename: string): ParsedImportResult {
  // Skip preamble lines — find the header row
  const lines = content.split("\n");
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].startsWith("Account,Symbol/CUSIP,Description,Position type")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return {
      sourceType: "vanguard-cost-basis",
      sourceName: filename,
      transactions: [], securities: [], holdings: [], prices: [], snapshots: [],
      corporateActions: [],
      errors: ["Could not find header row in Vanguard cost basis export"],
      warnings: [],
    };
  }

  const csvContent = lines.slice(headerIdx).join("\n");
  const parsed = Papa.parse<Record<string, string>>(csvContent, {
    header: true,
    skipEmptyLines: true,
  });

  const today = new Date().toISOString().slice(0, 10);
  const securitiesMap = new Map<string, ParsedSecurity>();
  const errors: string[] = [];

  // Aggregate per (account, symbol) since this format has per-lot rows
  const holdingAgg = new Map<string, { accountName: string; symbol: string; name: string; quantity: number; totalCost: number; marketValue: number }>();

  for (const row of parsed.data) {
    const acctNum = row["Account"]?.trim();
    const symbolCusip = row["Symbol/CUSIP"]?.trim();
    const description = row["Description"]?.trim();
    const quantity = parseVanguardNum(row["Quantity"]);
    const totalCost = parseVanguardNum(row["Total cost"]);

    if (!acctNum || !symbolCusip || isNaN(quantity)) continue;

    // Find the market value column (name varies with date)
    const marketValueCol = Object.keys(row).find((k) => k.startsWith("Market value"));
    const marketValue = marketValueCol ? parseVanguardNum(row[marketValueCol]) : NaN;

    const accountName = ACCOUNT_NUMBER_MAP[acctNum] || `Vanguard ${acctNum}`;
    const key = `${accountName}:${symbolCusip}`;

    const existing = holdingAgg.get(key);
    if (existing) {
      existing.quantity += quantity;
      if (!isNaN(totalCost)) existing.totalCost += totalCost;
      if (!isNaN(marketValue)) existing.marketValue += marketValue;
    } else {
      holdingAgg.set(key, {
        accountName,
        symbol: symbolCusip,
        name: description,
        quantity,
        totalCost: isNaN(totalCost) ? 0 : totalCost,
        marketValue: isNaN(marketValue) ? 0 : marketValue,
      });
    }

    if (!securitiesMap.has(symbolCusip)) {
      securitiesMap.set(symbolCusip, {
        symbol: symbolCusip,
        name: description,
      });
    }
  }

  // Cost basis parser no longer emits holdings — the YTD export CSVs are the
  // single source of truth for positions. Cost basis is computed from transactions
  // via the FIFO tax lots engine.
  const holdings: ParsedHolding[] = [];

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
    corporateActions: [],
    errors,
    warnings: [],
  };
}

export function parseVanguardCostBasis(
  content: string,
  filename: string
): ParsedImportResult {
  // Detect which format we're dealing with
  if (isDirectExportFormat(content)) {
    return parseDirectExport(content, filename);
  }

  // Original format: symbol,name,type,account,cost_basis_method,...
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
    corporateActions: [],
    errors,
    warnings: [],
  };
}
