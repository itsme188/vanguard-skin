/**
 * SEC EDGAR API client.
 *
 * Provides access to company filings, financial statements, and company facts
 * from the SEC's EDGAR system. Used by the chat assistant for fundamental
 * analysis and by the enrichment pipeline for security metadata.
 *
 * API docs: https://www.sec.gov/edgar/sec-api-documentation
 * No API key required — public data with rate limiting (10 req/sec).
 * User-Agent header required per SEC policy.
 */

const EDGAR_BASE_URL = "https://data.sec.gov";
const EFTS_BASE_URL = "https://efts.sec.gov/LATEST";

const USER_AGENT = "VanguardSkin/2.0 (personal portfolio dashboard)";

// ─── Types ──────────────────────────────────────────────────────

export interface CompanyInfo {
  cik: string; // zero-padded to 10 digits
  name: string;
  ticker?: string;
  sic?: string; // SIC industry code
  sicDescription?: string;
  stateOfIncorporation?: string;
  fiscalYearEnd?: string; // MMDD format
  exchanges?: string[];
}

export interface FilingSummary {
  accessionNumber: string;
  form: string; // "10-K", "10-Q", "8-K", etc.
  filingDate: string; // YYYY-MM-DD
  primaryDocument: string;
  primaryDocDescription?: string;
}

export interface FinancialFact {
  label: string;
  value: number;
  unitOfMeasure: string; // "USD", "shares", "pure" (ratio)
  endDate: string; // YYYY-MM-DD
  filingDate: string;
  form: string; // "10-K", "10-Q"
  frame?: string; // e.g., "CY2024Q4I"
}

export interface CompanyFinancials {
  company: CompanyInfo;
  revenue?: FinancialFact[];
  netIncome?: FinancialFact[];
  totalAssets?: FinancialFact[];
  totalLiabilities?: FinancialFact[];
  stockholdersEquity?: FinancialFact[];
  eps?: FinancialFact[];
  sharesOutstanding?: FinancialFact[];
  operatingIncome?: FinancialFact[];
}

// ─── API Client ─────────────────────────────────────────────────

async function edgarFetch(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Company not found in SEC EDGAR`);
    }
    throw new Error(`SEC EDGAR API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ─── CIK Lookup ─────────────────────────────────────────────────

// Cache ticker → CIK mappings in memory (loaded once)
let tickerMap: Map<string, string> | null = null;

async function loadTickerMap(): Promise<Map<string, string>> {
  if (tickerMap) return tickerMap;

  const data = (await edgarFetch(
    "https://www.sec.gov/files/company_tickers.json"
  )) as Record<string, { cik_str: number; ticker: string; title: string }>;

  tickerMap = new Map();
  for (const entry of Object.values(data)) {
    tickerMap.set(
      entry.ticker.toUpperCase(),
      String(entry.cik_str).padStart(10, "0")
    );
  }
  return tickerMap;
}

/**
 * Look up a company's CIK number from its ticker symbol.
 */
export async function getCik(ticker: string): Promise<string> {
  const map = await loadTickerMap();
  const cik = map.get(ticker.toUpperCase());
  if (!cik) {
    throw new Error(`Ticker "${ticker}" not found in SEC EDGAR`);
  }
  return cik;
}

// ─── Company Info ───────────────────────────────────────────────

/**
 * Get basic company information and recent filings.
 */
export async function getCompanyInfo(ticker: string): Promise<CompanyInfo> {
  const cik = await getCik(ticker);
  const data = (await edgarFetch(
    `${EDGAR_BASE_URL}/submissions/CIK${cik}.json`
  )) as Record<string, unknown>;

  return {
    cik,
    name: data.name as string,
    ticker: (data.tickers as string[])?.[0] || ticker.toUpperCase(),
    sic: data.sic as string | undefined,
    sicDescription: data.sicDescription as string | undefined,
    stateOfIncorporation: data.stateOfIncorporation as string | undefined,
    fiscalYearEnd: data.fiscalYearEnd as string | undefined,
    exchanges: data.exchanges as string[] | undefined,
  };
}

/**
 * Get recent filings for a company.
 */
export async function getRecentFilings(
  ticker: string,
  options?: {
    formType?: string; // "10-K", "10-Q", "8-K"
    limit?: number;
  }
): Promise<FilingSummary[]> {
  const cik = await getCik(ticker);
  const data = (await edgarFetch(
    `${EDGAR_BASE_URL}/submissions/CIK${cik}.json`
  )) as {
    recentFilings?: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[]; primaryDocDescription: string[] };
    filings?: { recent: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[]; primaryDocDescription: string[] } };
  };

  const recent = data.filings?.recent || data.recentFilings;
  if (!recent) return [];

  const filings: FilingSummary[] = [];
  const limit = options?.limit || 10;

  for (let i = 0; i < recent.form.length && filings.length < limit; i++) {
    if (options?.formType && recent.form[i] !== options.formType) continue;
    filings.push({
      form: recent.form[i],
      filingDate: recent.filingDate[i],
      accessionNumber: recent.accessionNumber[i],
      primaryDocument: recent.primaryDocument[i],
      primaryDocDescription: recent.primaryDocDescription?.[i],
    });
  }

  return filings;
}

// ─── Financial Facts (XBRL) ────────────────────────────────────

// Map of XBRL concept names to human-readable labels
const FINANCIAL_CONCEPTS: Record<string, { label: string; concepts: string[] }> = {
  revenue: {
    label: "Revenue",
    concepts: [
      "us-gaap:Revenues",
      "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
      "us-gaap:SalesRevenueNet",
    ],
  },
  netIncome: {
    label: "Net Income",
    concepts: [
      "us-gaap:NetIncomeLoss",
      "us-gaap:ProfitLoss",
    ],
  },
  totalAssets: {
    label: "Total Assets",
    concepts: ["us-gaap:Assets"],
  },
  totalLiabilities: {
    label: "Total Liabilities",
    concepts: ["us-gaap:Liabilities"],
  },
  stockholdersEquity: {
    label: "Stockholders' Equity",
    concepts: [
      "us-gaap:StockholdersEquity",
      "us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
  },
  eps: {
    label: "Earnings Per Share (Diluted)",
    concepts: ["us-gaap:EarningsPerShareDiluted"],
  },
  sharesOutstanding: {
    label: "Shares Outstanding",
    concepts: [
      "us-gaap:CommonStockSharesOutstanding",
      "dei:EntityCommonStockSharesOutstanding",
    ],
  },
  operatingIncome: {
    label: "Operating Income",
    concepts: [
      "us-gaap:OperatingIncomeLoss",
    ],
  },
};

/**
 * Get key financial data for a company from XBRL filings.
 * Returns recent annual and quarterly data points.
 */
export async function getCompanyFinancials(
  ticker: string,
  options?: {
    annualOnly?: boolean; // only 10-K data
    limit?: number; // max data points per metric
  }
): Promise<CompanyFinancials> {
  const cik = await getCik(ticker);
  const company = await getCompanyInfo(ticker);

  const data = (await edgarFetch(
    `${EDGAR_BASE_URL}/api/xbrl/companyfacts/CIK${cik}.json`
  )) as { facts: Record<string, Record<string, { units: Record<string, Array<Record<string, unknown>>> }>> };

  const limit = options?.limit || 8;
  const result: CompanyFinancials = { company };

  for (const [key, config] of Object.entries(FINANCIAL_CONCEPTS)) {
    const facts = extractFacts(data.facts, config.concepts, {
      label: config.label,
      annualOnly: options?.annualOnly,
      limit,
    });
    if (facts.length > 0) {
      (result as unknown as Record<string, unknown>)[key] = facts;
    }
  }

  return result;
}

function extractFacts(
  facts: Record<string, Record<string, { units: Record<string, Array<Record<string, unknown>>> }>>,
  conceptNames: string[],
  options: { label: string; annualOnly?: boolean; limit: number }
): FinancialFact[] {
  for (const conceptName of conceptNames) {
    const [taxonomy, concept] = conceptName.split(":");
    const conceptData = facts[taxonomy]?.[concept];
    if (!conceptData) continue;

    // Try USD first, then shares, then pure
    for (const unit of ["USD", "shares", "USD/shares", "pure"]) {
      const entries = conceptData.units[unit];
      if (!entries || entries.length === 0) continue;

      let filtered = entries.filter((e) => {
        if (options.annualOnly && e.form !== "10-K") return false;
        // Only include entries with an end date (not instantaneous unless it's a balance sheet item)
        return e.end != null;
      });

      // Sort by end date descending
      filtered.sort((a, b) =>
        (b.end as string).localeCompare(a.end as string)
      );

      // Deduplicate by end date (keep latest filing)
      const seen = new Set<string>();
      filtered = filtered.filter((e) => {
        const key = `${e.end}-${e.form}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return filtered.slice(0, options.limit).map((e) => ({
        label: options.label,
        value: e.val as number,
        unitOfMeasure: unit,
        endDate: e.end as string,
        filingDate: e.filed as string,
        form: e.form as string,
        frame: e.frame as string | undefined,
      }));
    }
  }

  return [];
}

/**
 * Full-text search for companies by name or ticker.
 */
export async function searchCompanies(
  query: string,
  limit: number = 5
): Promise<Array<{ cik: string; name: string; ticker: string }>> {
  const data = (await edgarFetch(
    `${EFTS_BASE_URL}/search-index?q=${encodeURIComponent(query)}&dateRange=custom&startdt=2020-01-01&forms=10-K&from=0&size=${limit}`
  )) as { hits?: { hits?: Array<{ _source: { entity_name: string; file_num: string; ticker: string } }> } };

  // Fallback: use the ticker map for simple ticker lookups
  if (!data.hits?.hits?.length) {
    const map = await loadTickerMap();
    const upper = query.toUpperCase();
    const results: Array<{ cik: string; name: string; ticker: string }> = [];

    for (const [ticker, cik] of map.entries()) {
      if (ticker.includes(upper) || ticker === upper) {
        results.push({ cik, name: ticker, ticker });
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  return (data.hits.hits || []).map((h) => ({
    cik: h._source.file_num,
    name: h._source.entity_name,
    ticker: h._source.ticker,
  }));
}
