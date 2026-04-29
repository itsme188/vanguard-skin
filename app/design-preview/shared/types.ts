export type Direction = "light-paper" | "terminal" | "modern-brokerage";

export type AssetType = "stock" | "option" | "bond" | "etf";

export interface MockHolding {
  symbol: string;
  name: string;
  type: AssetType;
  account: string;
  quantity: number;
  price: number;
  marketValue: number;
  costBasis: number;
  todayChangePct: number;
  totalGainPct: number;
  allocationPct: number;
}

export interface MockAlert {
  id: number;
  symbol: string;
  triggeredAt: string;
  levelType: "support" | "resistance" | "ma_cross";
  triggerPrice: number;
  currentPrice: number;
  source: string;
  recommendation: string;
  status: "pending" | "triggered_today" | "older";
}

export interface MockCalendarEvent {
  id: number;
  date: string;
  symbol?: string;
  eventType: "earnings" | "fomc" | "cpi" | "jobs" | "gdp" | "ism" | "fed_speak";
  title: string;
  releaseTime?: string;
  expectedImpact: "high" | "medium" | "low";
  consensus?: string;
  actual?: string;
  reactionPct?: number;
  isHeld: boolean;
}

export interface MockOhlcBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface MockSecurityDetail {
  symbol: string;
  name: string;
  type: AssetType;
  price: number;
  todayChange: number;
  todayChangePct: number;
  bars: MockOhlcBar[];
  positions: { account: string; quantity: number; costBasis: number; marketValue: number; gainPct: number }[];
  levels: { type: "support" | "resistance"; price: number; source: string; active: boolean }[];
  pendingEarnings?: { date: string; releaseTime: string; consensus: string };
}

export interface MockKpi {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
  sublabel?: string;
}

export interface MockPortfolio {
  totalValue: number;
  todayChange: number;
  todayChangePct: number;
  cashBalance: number;
  ytdGainPct: number;
  oneYearGainPct: number;
  numAccounts: number;
  numPositions: number;
}
