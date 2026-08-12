/**
 * Parser for factor exposure CSV files.
 * Format: symbol,sector,industry,interest_rate_sensitive,growth_vs_value,...
 *
 * Produces ParsedFactor records (for security_factors table)
 * and updates securities.sector / securities.industry.
 */

import Papa from "papaparse";
import type { ParsedImportResult, ParsedFactor } from "../types";
import { FACTOR_COLUMNS } from "@/lib/factors";

interface FactorCsvRow {
  symbol: string;
  sector?: string;
  industry?: string;
  interest_rate_sensitive?: string;
  growth_vs_value?: string;
  cyclical?: string;
  international_exposure?: string;
  geopolitical_onshoring?: string;
  tariff_exposure?: string;
  ai_exposure?: string;
  crypto_adjacent?: string;
  regulatory_risk?: string;
}

function normalize(val: string | undefined): string | undefined {
  if (!val || val.trim() === "" || val === "0") return undefined;
  const trimmed = val.trim();
  if (trimmed.toLowerCase() === "unknown") return undefined;
  return trimmed;
}

export function parseFactorCsv(
  content: string,
  filename: string
): ParsedImportResult {
  const parsed = Papa.parse<FactorCsvRow>(content, {
    header: true,
    skipEmptyLines: true,
  });

  const factors: ParsedFactor[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const row of parsed.data) {
    const symbol = row.symbol?.trim();
    if (!symbol) continue;

    // Check if this row has any factor data worth storing
    const hasFactors = FACTOR_COLUMNS.some(
      (col) => normalize(row[col]) !== undefined
    );
    const hasSector = normalize(row.sector) !== undefined;
    const hasIndustry = normalize(row.industry) !== undefined;

    if (!hasFactors && !hasSector && !hasIndustry) {
      warnings.push(`${symbol}: no factor data, skipping`);
      continue;
    }

    factors.push({
      symbol,
      sector: normalize(row.sector),
      industry: normalize(row.industry),
      interest_rate_sensitive: normalize(row.interest_rate_sensitive),
      growth_vs_value: normalize(row.growth_vs_value),
      cyclical: normalize(row.cyclical),
      international_exposure: normalize(row.international_exposure),
      geopolitical_onshoring: normalize(row.geopolitical_onshoring),
      tariff_exposure: normalize(row.tariff_exposure),
      ai_exposure: normalize(row.ai_exposure),
      crypto_adjacent: normalize(row.crypto_adjacent),
      regulatory_risk: normalize(row.regulatory_risk),
    });
  }

  for (const e of parsed.errors) {
    errors.push(`CSV parse error at row ${e.row}: ${e.message}`);
  }

  return {
    sourceType: "factor-csv",
    sourceName: filename,
    transactions: [],
    securities: [],
    holdings: [],
    prices: [],
    snapshots: [],
    factors,
    corporateActions: [],
    errors,
    warnings,
  };
}
