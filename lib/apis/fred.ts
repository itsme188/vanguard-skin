/**
 * FRED (Federal Reserve Economic Data) API client.
 *
 * Provides access to 800K+ economic time series from the St. Louis Fed.
 * Used by the chat assistant for macro context (interest rates, inflation, GDP, etc.)
 * and by the benchmark engine for risk-free rate data.
 *
 * API docs: https://fred.stlouisfed.org/docs/api/fred/
 * Free API key: https://fred.stlouisfed.org/docs/api/api_key.html
 */

const FRED_BASE_URL = "https://api.stlouisfed.org/fred";

// ─── Common FRED Series IDs ─────────────────────────────────────

/** Well-known series IDs for quick reference */
export const FRED_SERIES = {
  // Interest rates
  FED_FUNDS_RATE: "FEDFUNDS", // Federal Funds Effective Rate (monthly)
  FED_FUNDS_DAILY: "DFF", // Federal Funds Effective Rate (daily)
  TREASURY_10Y: "DGS10", // 10-Year Treasury Constant Maturity (daily)
  TREASURY_2Y: "DGS2", // 2-Year Treasury
  TREASURY_3M: "DTB3", // 3-Month Treasury Bill (daily)
  TREASURY_1Y: "DTB1YR", // 1-Year Treasury Bill

  // Inflation
  CPI: "CPIAUCSL", // Consumer Price Index (monthly)
  CPI_CORE: "CPILFESL", // Core CPI (ex food & energy, monthly)
  PCE: "PCEPI", // PCE Price Index (monthly)
  BREAKEVEN_10Y: "T10YIE", // 10-Year Breakeven Inflation (daily)

  // Market indicators
  SP500: "SP500", // S&P 500 Index (daily)
  VIX: "VIXCLS", // CBOE Volatility Index (daily)
  WILSHIRE_5000: "WILL5000INDFC", // Wilshire 5000 Total Market Index

  // Credit spreads
  BAA_SPREAD: "BAA10Y", // Baa Corporate Bond Spread over 10Y Treasury
  AAA_SPREAD: "AAA10Y", // Aaa Corporate Bond Spread over 10Y Treasury

  // Economic activity
  GDP: "GDP", // Gross Domestic Product (quarterly)
  UNEMPLOYMENT: "UNRATE", // Unemployment Rate (monthly)
  NONFARM_PAYROLLS: "PAYEMS", // Total Nonfarm Payrolls (monthly)
} as const;

// ─── Types ──────────────────────────────────────────────────────

export interface FredObservation {
  date: string; // YYYY-MM-DD
  value: number | null; // null when FRED reports "."
}

export interface FredSeriesInfo {
  id: string;
  title: string;
  frequency: string;
  units: string;
  seasonal_adjustment: string;
  last_updated: string;
  notes?: string;
}

export interface FredSearchResult {
  series: FredSeriesInfo[];
  count: number;
}

export interface FredSeriesData {
  series: FredSeriesInfo;
  observations: FredObservation[];
}

// ─── API Client ─────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.FRED_API_KEY;
  if (!key) {
    throw new Error(
      "FRED_API_KEY not set. Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html"
    );
  }
  return key;
}

async function fredFetch(endpoint: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${FRED_BASE_URL}/${endpoint}`);
  url.searchParams.set("api_key", getApiKey());
  url.searchParams.set("file_type", "json");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`FRED API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ─── Public Functions ───────────────────────────────────────────

/**
 * Get time series data for a FRED series.
 * Returns observations within the specified date range.
 */
export async function getSeriesData(
  seriesId: string,
  options?: {
    startDate?: string; // YYYY-MM-DD
    endDate?: string; // YYYY-MM-DD
    limit?: number;
    sort?: "asc" | "desc";
  }
): Promise<FredSeriesData> {
  const params: Record<string, string> = {};

  // Fetch series info and observations in parallel
  const [infoData, obsData] = await Promise.all([
    fredFetch("series", { series_id: seriesId }),
    fredFetch("series/observations", {
      series_id: seriesId,
      ...(options?.startDate && { observation_start: options.startDate }),
      ...(options?.endDate && { observation_end: options.endDate }),
      ...(options?.limit && { limit: String(options.limit) }),
      sort_order: options?.sort || "desc",
      ...params,
    }),
  ]);

  const info = infoData as { seriess: Array<Record<string, string>> };
  const obs = obsData as {
    observations: Array<{ date: string; value: string }>;
  };

  const seriesInfo: FredSeriesInfo = {
    id: info.seriess[0]?.id || seriesId,
    title: info.seriess[0]?.title || seriesId,
    frequency: info.seriess[0]?.frequency || "Unknown",
    units: info.seriess[0]?.units || "Unknown",
    seasonal_adjustment: info.seriess[0]?.seasonal_adjustment || "Unknown",
    last_updated: info.seriess[0]?.last_updated || "",
    notes: info.seriess[0]?.notes,
  };

  const observations: FredObservation[] = obs.observations.map((o) => ({
    date: o.date,
    value: o.value === "." ? null : parseFloat(o.value),
  }));

  return { series: seriesInfo, observations };
}

/**
 * Search for FRED series by keywords.
 */
export async function searchSeries(
  query: string,
  options?: {
    limit?: number;
    orderBy?: "search_rank" | "popularity" | "last_updated";
  }
): Promise<FredSearchResult> {
  const data = await fredFetch("series/search", {
    search_text: query,
    limit: String(options?.limit || 10),
    order_by: options?.orderBy || "search_rank",
  });

  const result = data as {
    count: number;
    seriess: Array<Record<string, string>>;
  };

  return {
    count: result.count,
    series: result.seriess.map((s) => ({
      id: s.id,
      title: s.title,
      frequency: s.frequency,
      units: s.units,
      seasonal_adjustment: s.seasonal_adjustment,
      last_updated: s.last_updated,
      notes: s.notes,
    })),
  };
}

/**
 * Get the latest value for a FRED series.
 * Convenience wrapper for common use cases like "current fed funds rate".
 */
export async function getLatestValue(
  seriesId: string
): Promise<{ date: string; value: number | null; title: string }> {
  const data = await getSeriesData(seriesId, { limit: 1, sort: "desc" });
  const latest = data.observations[0];
  return {
    date: latest?.date || "",
    value: latest?.value ?? null,
    title: data.series.title,
  };
}

/**
 * Get risk-free rate for Sharpe ratio / alpha calculations.
 * Uses 3-month Treasury bill rate by default.
 * Returns annualized rate as a decimal (e.g., 0.05 = 5%).
 */
export async function getRiskFreeRate(
  options?: {
    seriesId?: string; // default: DTB3 (3-month T-bill)
    asOfDate?: string; // YYYY-MM-DD, default: latest
  }
): Promise<{ rate: number; date: string; series: string }> {
  const seriesId = options?.seriesId || FRED_SERIES.TREASURY_3M;
  const endDate = options?.asOfDate || new Date().toISOString().slice(0, 10);

  // Fetch last 30 days to ensure we get at least one observation
  const startDate = new Date(
    new Date(endDate).getTime() - 30 * 24 * 3600 * 1000
  )
    .toISOString()
    .slice(0, 10);

  const data = await getSeriesData(seriesId, {
    startDate,
    endDate,
    limit: 5,
    sort: "desc",
  });

  // Find the latest non-null observation
  const latest = data.observations.find((o) => o.value !== null);
  if (!latest || latest.value === null) {
    throw new Error(`No risk-free rate data available for ${seriesId}`);
  }

  return {
    rate: latest.value / 100, // FRED reports as percentage, convert to decimal
    date: latest.date,
    series: data.series.title,
  };
}
