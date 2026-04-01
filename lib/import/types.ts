export type SourceType =
  | "ibkr-activity"
  | "ibkr-holdings"
  | "monthly-values"
  | "vanguard-cost-basis"
  | "vanguard-export"
  | "vanguard-holdings"
  | "vanguard-pdf"
  | "factor-csv"
  | "unknown";

export interface ParsedTransaction {
  accountName: string;
  tradeDate: string;
  settlementDate?: string;
  type: string;
  symbol?: string;
  securityName?: string;
  quantity?: number;
  amount?: number;
  pricePerShare?: number;
  fees?: number;
  isExternalFlow?: boolean;
  notes?: string;
  sourceKey: string;
}

export interface ParsedSecurity {
  symbol: string;
  name?: string;
  securityType?: string;
  assetClass?: string;
  underlyingSymbol?: string;
  strikePrice?: number;
  expirationDate?: string;
  optionType?: "CALL" | "PUT";
  multiplier?: number;
  maturityDate?: string;
}

export interface ParsedHolding {
  accountName: string;
  symbol: string;
  securityName?: string;
  quantity: number;
  costBasis?: number;
  marketValue?: number;
  asOfDate: string;
  sourceKey: string;
}

export interface ParsedPrice {
  symbol: string;
  date: string;
  closePrice: number;
  source: string;
}

export interface ParsedSnapshot {
  accountName: string;
  monthEndDate: string;
  totalValue: number;
  source: string;
  startingValue?: number;
  markToMarket?: number;
  depositsWithdrawals?: number;
  dividends?: number;
  interest?: number;
  commissions?: number;
  fees?: number;
  otherPnl?: number;
  twr?: number;
  investmentGain?: number;
}

export interface ParsedFactor {
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

export interface ParsedImportResult {
  sourceType: SourceType;
  sourceName: string;
  transactions: ParsedTransaction[];
  securities: ParsedSecurity[];
  holdings: ParsedHolding[];
  prices: ParsedPrice[];
  snapshots: ParsedSnapshot[];
  factors?: ParsedFactor[];
  errors: string[];
  warnings: string[];
}
