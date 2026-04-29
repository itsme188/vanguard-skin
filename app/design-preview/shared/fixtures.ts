import type {
  MockAlert,
  MockCalendarEvent,
  MockHolding,
  MockKpi,
  MockOhlcBar,
  MockPortfolio,
  MockSecurityDetail,
} from "./types";

export const mockPortfolio: MockPortfolio = {
  totalValue: 1247392.18,
  todayChange: 9847.22,
  todayChangePct: 0.795,
  cashBalance: 48392.0,
  ytdGainPct: 12.4,
  oneYearGainPct: 18.7,
  numAccounts: 5,
  numPositions: 47,
};

export const mockHoldings: MockHolding[] = [
  {
    symbol: "AAPL",
    name: "Apple Inc.",
    type: "stock",
    account: "IBKR",
    quantity: 184,
    price: 234.1,
    marketValue: 43074.4,
    costBasis: 38640.0,
    todayChangePct: 1.21,
    totalGainPct: 11.48,
    allocationPct: 3.45,
  },
  {
    symbol: "MSFT",
    name: "Microsoft Corp.",
    type: "stock",
    account: "Roth",
    quantity: 90,
    price: 428.55,
    marketValue: 38569.5,
    costBasis: 31500.0,
    todayChangePct: 0.81,
    totalGainPct: 22.44,
    allocationPct: 3.09,
  },
  {
    symbol: "GOOG",
    name: "Alphabet Inc. Cl C",
    type: "stock",
    account: "Vanguard",
    quantity: 165,
    price: 178.2,
    marketValue: 29403.0,
    costBasis: 32175.0,
    todayChangePct: -0.25,
    totalGainPct: -8.62,
    allocationPct: 2.36,
  },
  {
    symbol: "NVDA",
    name: "NVIDIA Corp.",
    type: "stock",
    account: "IBKR",
    quantity: 28,
    price: 892.4,
    marketValue: 24987.2,
    costBasis: 14000.0,
    todayChangePct: 1.42,
    totalGainPct: 78.48,
    allocationPct: 2.0,
  },
  {
    symbol: "GLW",
    name: "Corning Inc.",
    type: "stock",
    account: "Roth",
    quantity: 350,
    price: 42.18,
    marketValue: 14763.0,
    costBasis: 12950.0,
    todayChangePct: 0.74,
    totalGainPct: 14.0,
    allocationPct: 1.18,
  },
  {
    symbol: "TER  260618C00120000",
    name: "TER Jun-18 $120 Call",
    type: "option",
    account: "Vanguard",
    quantity: 5,
    price: 8.75,
    marketValue: 4375.0,
    costBasis: 3850.0,
    todayChangePct: 2.94,
    totalGainPct: 13.64,
    allocationPct: 0.35,
  },
  {
    symbol: "TLT",
    name: "iShares 20+ Yr Treasury ETF",
    type: "etf",
    account: "Vanguard",
    quantity: 220,
    price: 87.45,
    marketValue: 19239.0,
    costBasis: 21340.0,
    todayChangePct: -0.31,
    totalGainPct: -9.85,
    allocationPct: 1.54,
  },
  {
    symbol: "912810TM0",
    name: "US Treasury 4.625% 2053",
    type: "bond",
    account: "Vanguard",
    quantity: 25000,
    price: 94.21,
    marketValue: 23552.5,
    costBasis: 25000.0,
    todayChangePct: 0.18,
    totalGainPct: -5.79,
    allocationPct: 1.89,
  },
];

export const mockAlerts: MockAlert[] = [
  {
    id: 1,
    symbol: "GLW",
    triggeredAt: "2026-04-28T16:31:00",
    levelType: "support",
    triggerPrice: 41.2,
    currentPrice: 42.18,
    source: "Vital Knowledge",
    recommendation:
      "Reclaim of the 41.20 support after this morning's gap-down — consider trimming starter into strength toward 43.50.",
    status: "triggered_today",
  },
  {
    id: 2,
    symbol: "TER",
    triggeredAt: "2026-04-28T16:38:00",
    levelType: "resistance",
    triggerPrice: 85.5,
    currentPrice: 84.92,
    source: "Eliant Capital",
    recommendation:
      "Approach to declared resistance ahead of tomorrow's print — wait for the reaction; don't pre-position.",
    status: "triggered_today",
  },
  {
    id: 3,
    symbol: "MSFT",
    triggeredAt: "2026-04-25T14:22:00",
    levelType: "ma_cross",
    triggerPrice: 425.0,
    currentPrice: 428.55,
    source: "Helene Meisler",
    recommendation:
      "21-DMA reclaim with the broader tape; trend remains constructive into the May seasonal window.",
    status: "older",
  },
];

function buildSyntheticBars(start: number, days: number): MockOhlcBar[] {
  const bars: MockOhlcBar[] = [];
  let price = start;
  const end = new Date("2026-04-28");
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const drift = (Math.sin(i / 4) * 0.6 + Math.cos(i / 11) * 0.4) * (start * 0.012);
    const open = price;
    const close = open + drift;
    const high = Math.max(open, close) + Math.abs(drift) * 0.4;
    const low = Math.min(open, close) - Math.abs(drift) * 0.4;
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
    });
    price = close;
  }
  return bars;
}

export const mockSecurityDetail: MockSecurityDetail = {
  symbol: "GLW",
  name: "Corning Inc.",
  type: "stock",
  price: 42.18,
  todayChange: 0.31,
  todayChangePct: 0.74,
  bars: buildSyntheticBars(38.5, 90),
  positions: [
    { account: "Roth", quantity: 350, costBasis: 12950.0, marketValue: 14763.0, gainPct: 14.0 },
    { account: "IBKR", quantity: 200, costBasis: 8200.0, marketValue: 8436.0, gainPct: 2.88 },
  ],
  levels: [
    { type: "support", price: 41.2, source: "Vital Knowledge", active: true },
    { type: "support", price: 39.5, source: "Eliant Capital", active: true },
    { type: "resistance", price: 43.5, source: "Vital Knowledge", active: true },
    { type: "resistance", price: 45.8, source: "Helene Meisler", active: false },
  ],
  pendingEarnings: { date: "2026-04-29", releaseTime: "08:00 ET", consensus: "EPS $0.51 / Rev $3.82B" },
};

export const mockCalendarEvents: MockCalendarEvent[] = [
  {
    id: 1,
    date: "2026-04-28",
    symbol: "GLW",
    eventType: "earnings",
    title: "Corning earnings (BMO)",
    releaseTime: "08:00 ET",
    expectedImpact: "high",
    consensus: "EPS $0.51",
    actual: "EPS $0.54",
    reactionPct: 2.1,
    isHeld: true,
  },
  {
    id: 2,
    date: "2026-04-28",
    eventType: "fed_speak",
    title: "Powell speech — Stanford GSB",
    releaseTime: "13:30 ET",
    expectedImpact: "medium",
    isHeld: false,
  },
  {
    id: 3,
    date: "2026-04-29",
    symbol: "TER",
    eventType: "earnings",
    title: "Teradyne earnings (AMC)",
    releaseTime: "16:15 ET",
    expectedImpact: "high",
    consensus: "EPS $0.62",
    isHeld: true,
  },
  {
    id: 4,
    date: "2026-04-30",
    eventType: "fomc",
    title: "FOMC rate decision",
    releaseTime: "14:00 ET",
    expectedImpact: "high",
    consensus: "Hold at 4.25–4.50%",
    isHeld: false,
  },
  {
    id: 5,
    date: "2026-04-30",
    symbol: "MSFT",
    eventType: "earnings",
    title: "Microsoft earnings (AMC)",
    releaseTime: "16:00 ET",
    expectedImpact: "high",
    consensus: "EPS $3.22",
    isHeld: true,
  },
  {
    id: 6,
    date: "2026-05-01",
    eventType: "ism",
    title: "ISM Manufacturing PMI",
    releaseTime: "10:00 ET",
    expectedImpact: "medium",
    consensus: "49.2",
    isHeld: false,
  },
  {
    id: 7,
    date: "2026-05-02",
    eventType: "jobs",
    title: "Nonfarm Payrolls",
    releaseTime: "08:30 ET",
    expectedImpact: "high",
    consensus: "+185k",
    isHeld: false,
  },
];

export const mockOverviewKpis: MockKpi[] = [
  {
    label: "Portfolio",
    value: "$1,247,392",
    delta: "+$9,847 today (+0.79%)",
    deltaTone: "up",
    sublabel: "5 accounts · 47 positions",
  },
  { label: "Cash", value: "$48,392", sublabel: "3.88% of portfolio" },
  { label: "YTD", value: "+12.4%", deltaTone: "up", sublabel: "vs SPY +9.8%" },
  { label: "1-Year", value: "+18.7%", deltaTone: "up", sublabel: "vs SPY +14.2%" },
  { label: "Sharpe", value: "1.42", sublabel: "12-mo, rf 4.5%" },
  { label: "Max Drawdown", value: "−7.8%", deltaTone: "down", sublabel: "Mar 2026" },
];

export const directionMeta: Record<
  "light-paper" | "terminal" | "modern-brokerage",
  { name: string; tagline: string; mood: string }
> = {
  "light-paper": {
    name: "Light Paper",
    tagline: "Warm off-white pages, dark data modules embedded",
    mood: "Stripe Dashboard meets a Bloomberg widget pasted onto a notebook",
  },
  terminal: {
    name: "Pure Terminal",
    tagline: "Dense data, mono everything, no rounded corners",
    mood: "Trading desk at 4:01 PM",
  },
  "modern-brokerage": {
    name: "Modern Brokerage",
    tagline: "Generous spacing, soft cards, friendly tone",
    mood: "Public.com / Wealthfront grown up",
  },
};
