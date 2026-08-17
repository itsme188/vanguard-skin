export type SourceType =
  | "ibkr-activity"
  | "ibkr-holdings"
  | "monthly-values"
  | "vanguard-cost-basis"
  | "vanguard-export"
  | "vanguard-holdings"
  | "vanguard-pdf"
  | "factor-csv"
  | "canonical-csv"
  | "daf-contributions"
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

export interface ParsedCorporateAction {
  accountName: string;
  symbol: string; // raw statement symbol (suffix-normalized later, at commit)
  actionType: "SPLIT" | "REVERSE_SPLIT";
  effectiveDate: string; // YYYY-MM-DD from the Date/Time column
  ratioNumerator: number;
  ratioDenominator: number;
  quantityDelta: number | null; // statement Quantity column
  sourceKey: string; // ibkr:ca:split:<date>:<symbol>:<num>:<den>
}

export interface ParsedDonation {
  sourceKey: string; // daf:contribution:{received_date}:{symbol|USD}:{qty|amount}:{createdAtRaw}
  kind: "stock" | "cash";
  symbolRaw: string | null; // null for cash
  quantity: number | null;
  fmvUsd: number;
  unitValuation: number | null;
  createdDate: string | null; // ET date of "created at"
  receivedDate: string; // ET date of "received at" — the tax date
  completedDate: string | null;
  createdAtRaw: string | null; // verbatim provider timestamp (identity component)
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
  corporateActions: ParsedCorporateAction[];
  donations?: ParsedDonation[];
  errors: string[];
  warnings: string[];
}
