export interface Account {
  id: number;
  name: string;
}

export interface Security {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
  asset_class: string | null;
  source_key: string | null;
  underlying_symbol: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  option_type: "CALL" | "PUT" | null;
  multiplier: number;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  ib_con_id: number | null;
}

export interface Transaction {
  id: number;
  account_id: number;
  security_id: number | null;
  import_batch_id: number | null;
  trade_date: string;
  settlement_date: string | null;
  type: string;
  quantity: number | null;
  amount: number | null;
  price_per_share: number | null;
  fees: number;
  is_external_flow: number;
  source_key: string | null;
  notes: string | null;
}

export interface Holding {
  id: number;
  account_id: number;
  security_id: number;
  quantity: number;
  cost_basis: number | null;
  as_of_date: string;
  import_batch_id: number | null;
  source_key: string | null;
}

export interface ImportBatch {
  id: number;
  filename: string | null;
  source_type: string;
  status: string;
  record_count: number;
  summary: string | null;
  created_at: string;
}

export interface MonthlySnapshot {
  id: number;
  account_id: number;
  month_end_date: string;
  total_value: number;
  source: string;
  notes: string | null;
  starting_value: number | null;
  mark_to_market: number | null;
  deposits_withdrawals: number | null;
  dividends: number | null;
  interest: number | null;
  commissions: number | null;
  fees: number | null;
  other_pnl: number | null;
  twr: number | null;
  investment_gain: number | null;
  import_batch_id: number | null;
  created_at: string;
}

export interface Price {
  id: number;
  security_id: number;
  date: string;
  close_price: number;
  source: string;
  import_batch_id: number | null;
}

export interface TaxLot {
  id: number;
  account_id: number;
  security_id: number;
  acquisition_transaction_id: number | null;
  acquisition_date: string;
  acquisition_price: number;
  quantity_acquired: number;
  quantity_remaining: number;
  cost_basis: number;
  is_from_opening_snapshot: number;
  created_at: string;
}

export interface TaxLotSale {
  id: number;
  tax_lot_id: number;
  sale_transaction_id: number;
  quantity_sold: number;
  sale_price: number;
  proceeds: number;
  cost_basis_allocated: number;
  realized_gain_loss: number;
  is_long_term: number;
  holding_period_days: number;
  sale_date: string;
  created_at: string;
}

export type TranscriptSource = "edgar_8k" | "motley_fool" | "api_ninjas";

export interface EarningsTranscript {
  id: number;
  security_id: number | null;
  ticker: string;
  year: number;
  quarter: number;
  call_date: string | null;
  source: TranscriptSource;
  transcript: string | null;
  summary: string | null;
  guidance: string | null;
  risk_factors: string | null;
  sentiment_score: number | null;
  sentiment_label: string | null;
  participants: string | null; // JSON array
  accession_number: string | null;
  filing_url: string | null;
  source_key: string;
  fetched_at: string;
  created_at: string;
}

export type NoteType = "journal" | "earnings" | "trade_thesis";
export type NoteSentiment = "bullish" | "bearish" | "neutral" | "cautious" | "confident";

export interface Note {
  id: number;
  note_type: NoteType;
  content: string;
  security_id: number | null;
  transaction_id: number | null;
  event_date: string;
  tags: string | null;
  sentiment: NoteSentiment | null;
  created_at: string;
  updated_at: string;
}
