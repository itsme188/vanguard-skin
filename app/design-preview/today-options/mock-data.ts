/**
 * Mock data for the Today preview comparison. Same data across all four
 * options so the visual is what differs. Numbers chosen to populate every
 * block so each option can be evaluated under realistic density.
 */

export interface MockHolding {
  symbol: string;
  name: string;
  quantity: number;
  price: number;
  priorClose: number;
  account: string;
}

export interface MockAlert {
  symbol: string;
  levelType: "support" | "resistance" | "stop" | "exit" | "scale_in";
  levelPrice: number;
  triggeredPrice: number;
  triggeredToday: boolean;
  source: string;
  suggestion?: string;
}

export interface MockEvent {
  symbol: string | null;
  title: string;
  time: string | null;
  date: string;
  isToday: boolean;
  weekday: string;
  type: "earnings" | "macro";
  consensus?: string;
  actual?: string;
  impact?: "high" | "medium" | "low";
}

export const MOCK_PORTFOLIO = {
  totalValue: 1899734,
  totalChange: 116965,
  changeLabel: "vs prior month",
  accountCount: 3,
  asOf: "Apr 29",
};

export const MOCK_TODAY_DATE = "Wednesday, April 29, 2026";

export const MOCK_HOLDINGS: MockHolding[] = [
  { symbol: "HOOD", name: "ROBINHOOD MARKETS", quantity: 100, price: 78.42, priorClose: 76.92, account: "IBKR" },
  { symbol: "TER", name: "TERADYNE INC", quantity: 50, price: 403.18, priorClose: 396.05, account: "IBKR" },
  { symbol: "NVDA", name: "NVIDIA CORP", quantity: 80, price: 142.30, priorClose: 144.80, account: "IBKR" },
  { symbol: "PLTR", name: "PALANTIR TECHNOLOGIES", quantity: 200, price: 28.94, priorClose: 28.21, account: "IBKR" },
  { symbol: "GLW", name: "CORNING INC", quantity: 150, price: 47.83, priorClose: 47.10, account: "IBKR" },
  { symbol: "OCUL", name: "OCULAR THERAPEUTIX", quantity: 300, price: 11.45, priorClose: 12.25, account: "IBKR" },
  { symbol: "PL", name: "PLANET LABS", quantity: 250, price: 4.62, priorClose: 4.91, account: "IBKR" },
];

export const MOCK_ALERTS: MockAlert[] = [
  {
    symbol: "TER",
    levelType: "support",
    levelPrice: 400,
    triggeredPrice: 403.18,
    triggeredToday: true,
    source: "Vital Knowledge",
    suggestion: "Consider scaling in given the bounce off 50d MA confluence.",
  },
  {
    symbol: "NVDA",
    levelType: "resistance",
    levelPrice: 145,
    triggeredPrice: 144.80,
    triggeredToday: true,
    source: "TMT Breakout",
    suggestion: "Hot rejection at 145 — typical fade zone with earnings 3 weeks out.",
  },
  {
    symbol: "PLTR",
    levelType: "scale_in",
    levelPrice: 28,
    triggeredPrice: 28.94,
    triggeredToday: false,
    source: "Helene Meisler",
  },
];

export const MOCK_EVENTS_TODAY: MockEvent[] = [
  {
    symbol: null,
    title: "FOMC Statement + Press Conference",
    time: "14:00",
    date: "2026-04-29",
    isToday: true,
    weekday: "Wed",
    type: "macro",
    consensus: "hold at 5.25-5.50%",
    impact: "high",
  },
  {
    symbol: "META",
    title: "Meta Platforms Q1 Earnings (AMC)",
    time: "16:15",
    date: "2026-04-29",
    isToday: true,
    weekday: "Wed",
    type: "earnings",
    consensus: "$4.32 · $36.48B",
  },
];

export const MOCK_WEEK_AHEAD: MockEvent[] = [
  // Mon
  {
    symbol: null,
    title: "ISM Manufacturing PMI",
    time: "10:00",
    date: "2026-04-27",
    isToday: false,
    weekday: "Mon",
    type: "macro",
    consensus: "49.8",
    actual: "50.1",
    impact: "medium",
  },
  {
    symbol: "WHR",
    title: "Whirlpool Q1 (BMO)",
    time: "07:00",
    date: "2026-04-27",
    isToday: false,
    weekday: "Mon",
    type: "earnings",
    consensus: "$1.93 · $4.05B",
    actual: "$1.78 · $4.10B",
  },
  // Tue
  {
    symbol: null,
    title: "Consumer Confidence",
    time: "10:00",
    date: "2026-04-28",
    isToday: false,
    weekday: "Tue",
    type: "macro",
    consensus: "104.0",
    actual: "103.4",
    impact: "low",
  },
  {
    symbol: "TER",
    title: "Teradyne Q1 (AMC)",
    time: "16:00",
    date: "2026-04-28",
    isToday: false,
    weekday: "Tue",
    type: "earnings",
    consensus: "$2.65 · $670M",
    actual: "$2.78 · $686M",
  },
  // Wed (today)
  {
    symbol: null,
    title: "FOMC Statement",
    time: "14:00",
    date: "2026-04-29",
    isToday: true,
    weekday: "Wed",
    type: "macro",
    consensus: "hold",
    impact: "high",
  },
  {
    symbol: "META",
    title: "Meta Platforms Q1 (AMC)",
    time: "16:15",
    date: "2026-04-29",
    isToday: true,
    weekday: "Wed",
    type: "earnings",
    consensus: "$4.32 · $36.48B",
  },
  {
    symbol: "MSFT",
    title: "Microsoft Q3 (AMC)",
    time: "16:30",
    date: "2026-04-29",
    isToday: true,
    weekday: "Wed",
    type: "earnings",
    consensus: "$3.22 · $68.40B",
  },
  // Thu
  {
    symbol: null,
    title: "Q1 GDP Advance",
    time: "08:30",
    date: "2026-04-30",
    isToday: false,
    weekday: "Thu",
    type: "macro",
    consensus: "2.4%",
    impact: "high",
  },
  {
    symbol: "AAPL",
    title: "Apple Q2 (AMC)",
    time: "16:30",
    date: "2026-04-30",
    isToday: false,
    weekday: "Thu",
    type: "earnings",
    consensus: "$1.51 · $94.20B",
  },
  // Fri
  {
    symbol: null,
    title: "PCE Price Index",
    time: "08:30",
    date: "2026-05-01",
    isToday: false,
    weekday: "Fri",
    type: "macro",
    consensus: "0.3%",
    impact: "high",
  },
  {
    symbol: null,
    title: "UMich Sentiment Final",
    time: "10:00",
    date: "2026-05-01",
    isToday: false,
    weekday: "Fri",
    type: "macro",
    consensus: "67.0",
    impact: "low",
  },
];

export const MOCK_NEARBY_LEVELS = [
  { symbol: "AAPL", levelType: "resistance" as const, price: 220, currentPrice: 218.45, distancePct: 0.71 },
  { symbol: "GOOGL", levelType: "support" as const, price: 165, currentPrice: 167.20, distancePct: 1.32 },
  { symbol: "GLW", levelType: "scale_in" as const, price: 49, currentPrice: 47.83, distancePct: 2.45 },
];
