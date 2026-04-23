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

export interface SecurityFactor {
  security_id: number;
  interest_rate_sensitive: string | null;
  growth_vs_value: string | null;
  cyclical: string | null;
  international_exposure: string | null;
  geopolitical_onshoring: string | null;
  tariff_exposure: string | null;
  ai_exposure: string | null;
  crypto_adjacent: string | null;
  regulatory_risk: string | null;
  factor_source: string | null;
  updated_at: string | null;
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

export type ChatScope = "all" | "ibkr" | "vanguard-taxable" | "vanguard-roth-ira" | "macro";

export const SCOPE_LABELS: Record<ChatScope, string> = {
  all: "All Accounts",
  ibkr: "IBKR",
  "vanguard-taxable": "Vanguard Taxable",
  "vanguard-roth-ira": "Vanguard Roth IRA",
  macro: "Macro",
};

export const VALID_SCOPES: ChatScope[] = ["all", "ibkr", "vanguard-taxable", "vanguard-roth-ira", "macro"];

// ── Calendar Events ──────────────────────────────────────────

export type CalendarEventSource = "wsh" | "claude_macro" | "manual" | "apple_calendar" | "finnhub";

export type CalendarEventType =
  // Company events (from WSH)
  | "earnings"
  | "analyst_meeting"
  | "conference"
  | "split"
  // Macro events (from Claude)
  | "fomc"
  | "cpi"
  | "jobs"
  | "gdp"
  | "pmi"
  | "retail_sales"
  | "housing"
  | "other_macro"
  // Catch-all
  | "other";

export type EventImpact = "high" | "medium" | "low";

export interface CalendarEvent {
  id: number;
  source: CalendarEventSource;
  event_type: CalendarEventType;
  event_date: string;
  event_time: string | null;
  title: string;
  description: string | null;
  security_id: number | null;
  symbol: string | null;
  ib_con_id: number | null;
  expected_impact: EventImpact | null;
  consensus_estimate: string | null;
  previous_value: string | null;
  raw_json: string | null;
  source_key: string;
  week_of: string | null;
  fetched_at: string;
  created_at: string;
  // Migration 041 — living-record enrichment. All nullable; unpopulated
  // rows behave exactly as they did pre-sprint.
  release_time: string | null;
  actual_value: string | null;
  consensus_value: string | null;
  reaction_snapshot: string | null;
  enriched_at: string | null;
}

export interface CalendarBriefing {
  id: number;
  week_of: string;
  title: string;
  content: string;
  event_count: number;
  model: string | null;
  generated_at: string;
}

// ── Trade Reviews ──────────────────────────────────────────

export interface TradeReview {
  id: number;
  account_id: number;
  period_start: string;
  period_end: string;
  import_batch_id: number | null;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  total_realized_pnl: number;
  avg_holding_days: number | null;
  best_trade_pnl: number | null;
  best_trade_symbol: string | null;
  worst_trade_pnl: number | null;
  worst_trade_symbol: string | null;
  avg_win: number | null;
  avg_loss: number | null;
  profit_factor: number | null;
  review_markdown: string;
  trade_grades: string | null;
  patterns_identified: string | null;
  strengths: string | null;
  weaknesses: string | null;
  cumulative_patterns: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  generated_at: string;
  created_at: string;
}

export interface TradeRoundtrip {
  id: number;
  review_id: number;
  account_id: number;
  security_id: number;
  symbol: string;
  entry_date: string;
  entry_price: number;
  entry_quantity: number;
  entry_cost: number;
  exit_date: string;
  exit_price: number;
  exit_quantity: number;
  exit_proceeds: number;
  holding_days: number;
  realized_pnl: number;
  return_pct: number;
  grade: string | null;
  entry_thesis: string | null;
  exit_assessment: string | null;
  what_went_well: string | null;
  what_went_wrong: string | null;
  sale_transaction_id: number | null;
}

// ─── Security levels + alerts ──────────────────────────────────────

export type LevelType = "support" | "resistance" | "entry" | "exit" | "stop" | "scale_in";
export type LevelDirection = "bullish" | "bearish";
export type LevelActionHint = "new_position" | "scale_in" | "trim" | "close" | "watch";
export type LevelSource = "user" | "newsletter" | "technical" | "claude";
export type LevelTimeframe = "day" | "week" | "month";
export type LevelReviewStatus = "auto_approved" | "pending_review" | "rejected";
export type LevelPriceSource =
  | "static"
  | "sma_9"
  | "sma_21"
  | "sma_50"
  | "sma_200"
  | "ema_9"
  | "ema_21";
export type AlertResponse = "pending" | "acted" | "ignored" | "dismissed";

export interface SecurityLevel {
  id: number;
  security_id: number;
  level_type: LevelType;
  price: number;
  price_source: LevelPriceSource;
  direction: LevelDirection | null;
  action_hint: LevelActionHint | null;
  source: LevelSource;
  source_article_id: number | null;
  source_author: string | null;
  thesis: string | null;
  timeframe: LevelTimeframe | null;
  expires_at: string | null;
  group_id: string | null;
  set_date: string;
  is_active: number;
  triggered_at: string | null;
  triggered_price: number | null;
  notes: string | null;
  review_status: LevelReviewStatus;
  created_at: string;
  updated_at: string;
}

export interface LevelAlert {
  id: number;
  level_id: number;
  security_id: number;
  triggered_at: string;
  triggered_price: number;
  suggested_action: string | null;
  position_context: string | null;
  user_response: AlertResponse;
  user_response_at: string | null;
  user_response_note: string | null;
  created_at: string;
}
