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

const USER_AGENT = `VanguardSkin/2.0 ${process.env.EDGAR_CONTACT_EMAIL || "user@example.com"}`;

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

export interface InsiderTransaction {
  securityTitle: string; // e.g., "Common Stock"
  transactionDate: string; // YYYY-MM-DD
  shares: number;
  pricePerShare: number | null; // null if not reported
  acquiredOrDisposed: "A" | "D"; // A = acquired/bought, D = disposed/sold
  sharesOwnedAfter: number | null;
}

export interface InsiderFiling {
  filingDate: string; // YYYY-MM-DD (when form was filed with SEC)
  accessionNumber: string;
  ownerName: string; // e.g., "Cook Timothy D"
  ownerTitle: string; // e.g., "Chief Executive Officer"
  isDirector: boolean;
  isOfficer: boolean;
  isTenPercentOwner: boolean;
  transactions: InsiderTransaction[];
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

async function edgarFetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/xml, text/xml, */*",
    },
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Filing document not found`);
    }
    throw new Error(`SEC EDGAR error: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

// ─── Form 4 XML Parsing Helpers ─────────────────────────────────

/**
 * Extract text content from a simple XML tag (first occurrence).
 * @internal Exported for testing.
 */
export function xmlText(xml: string, tagName: string): string | null {
  const match = xml.match(new RegExp(`<${tagName}>([^<]*)</${tagName}>`));
  return match ? match[1].trim() : null;
}

/**
 * Extract all occurrences of a tag block (including nested content).
 * @internal Exported for testing.
 */
export function xmlBlocks(xml: string, tagName: string): string[] {
  const blocks: string[] = [];
  const regex = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?</${tagName}>`, "g");
  let match;
  while ((match = regex.exec(xml)) !== null) {
    blocks.push(match[0]);
  }
  return blocks;
}

/**
 * Navigate nested Form 4 XML and extract the <value> content.
 * Form 4 XML nests values: <parent><value>X</value></parent>
 * Supports multi-level: extractNestedValue(block, "transactionAmounts", "transactionShares")
 * @internal Exported for testing.
 */
export function extractNestedValue(block: string, ...tags: string[]): string | null {
  let current = block;
  for (const tag of tags) {
    const match = current.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (!match) return null;
    current = match[1];
  }
  // Look for a <value> sub-element; if found, use it; otherwise use raw text
  const valueMatch = current.match(/<value>([^<]*)<\/value>/);
  return valueMatch ? valueMatch[1].trim() : current.trim() || null;
}

function parseOptionalFloat(s: string | null): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/**
 * Parse a single Form 4 XML document into an InsiderFiling.
 * Returns null if the XML is malformed or has no reporting owner.
 * @internal Exported for testing.
 */
export function parseForm4Xml(
  xml: string,
  filingDate: string,
  accessionNumber: string
): InsiderFiling | null {
  // Extract reporting owner info
  const ownerBlock = xmlBlocks(xml, "reportingOwner")[0];
  if (!ownerBlock) return null;

  const ownerName = xmlText(ownerBlock, "rptOwnerName");
  if (!ownerName) return null;

  // Relationship flags — check for both "1" and "true"
  const isDirectorRaw = xmlText(ownerBlock, "isDirector");
  const isOfficerRaw = xmlText(ownerBlock, "isOfficer");
  const isTenPctRaw = xmlText(ownerBlock, "isTenPercentOwner");

  const isDirector = isDirectorRaw === "1" || isDirectorRaw === "true";
  const isOfficer = isOfficerRaw === "1" || isOfficerRaw === "true";
  const isTenPercentOwner = isTenPctRaw === "1" || isTenPctRaw === "true";

  const ownerTitle = xmlText(ownerBlock, "officerTitle") || "";

  // Extract non-derivative transactions (stock buys/sells)
  const transactions: InsiderTransaction[] = [];
  const txnBlocks = xmlBlocks(xml, "nonDerivativeTransaction");

  for (const txnBlock of txnBlocks) {
    const securityTitle =
      extractNestedValue(txnBlock, "securityTitle") || "Common Stock";
    const transactionDate =
      extractNestedValue(txnBlock, "transactionDate") || filingDate;
    const sharesStr = extractNestedValue(
      txnBlock,
      "transactionAmounts",
      "transactionShares"
    );
    const priceStr = extractNestedValue(
      txnBlock,
      "transactionAmounts",
      "transactionPricePerShare"
    );
    const codeStr = extractNestedValue(
      txnBlock,
      "transactionAmounts",
      "transactionAcquiredDisposedCode"
    );
    const sharesAfterStr = extractNestedValue(
      txnBlock,
      "postTransactionAmounts",
      "sharesOwnedFollowingTransaction"
    );

    const shares = parseFloat(sharesStr || "0");
    if (shares === 0) continue; // skip zero-share entries

    transactions.push({
      securityTitle,
      transactionDate,
      shares,
      pricePerShare: parseOptionalFloat(priceStr),
      acquiredOrDisposed: (codeStr === "D" ? "D" : "A") as "A" | "D",
      sharesOwnedAfter: parseOptionalFloat(sharesAfterStr),
    });
  }

  return {
    filingDate,
    accessionNumber,
    ownerName,
    ownerTitle,
    isDirector,
    isOfficer,
    isTenPercentOwner,
    transactions,
  };
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

// ─── Insider Trading (Form 4) ───────────────────────────────────

/**
 * Get recent insider transactions (Form 4 filings) for a company.
 * Fetches Form 4 filings from SEC EDGAR and parses the XML documents
 * to extract insider buy/sell transaction details.
 *
 * Only includes non-derivative (stock) transactions — options/warrants
 * in the derivative table are excluded.
 */
export async function getInsiderTransactions(
  ticker: string,
  options?: {
    limit?: number; // max filings to fetch (default 10, max 20)
    transactionType?: "buy" | "sell" | "all"; // filter direction
  }
): Promise<InsiderFiling[]> {
  const limit = Math.min(options?.limit || 10, 20);
  const txnFilter = options?.transactionType || "all";

  // Step 1: Get recent Form 4 filings via the submissions endpoint
  const filings = await getRecentFilings(ticker, {
    formType: "4",
    limit: limit + 5, // fetch extra in case some fail to parse
  });

  if (filings.length === 0) {
    return [];
  }

  // Step 2: Fetch and parse each filing's XML document
  const cik = await getCik(ticker);
  const cikNum = parseInt(cik); // URL uses un-padded CIK
  const results: InsiderFiling[] = [];

  for (const filing of filings) {
    if (results.length >= limit) break;

    try {
      // Accession number: "0001193125-26-001234" → "000119312526001234" in URLs
      const accessionNoDashes = filing.accessionNumber.replace(/-/g, "");
      let docName = filing.primaryDocument;

      // The submissions API often returns XSLT-rendered paths like
      // "xslF345X05/primarydocument.xml" — strip the directory prefix
      // to get the raw XML at the filing root
      if (docName.includes("/")) {
        docName = docName.split("/").pop()!;
      }

      // If primary doc isn't XML, try the standard Form 4 naming convention
      if (!docName.endsWith(".xml")) {
        docName = `${accessionNoDashes}.xml`;
      }

      const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionNoDashes}/${docName}`;
      const xml = await edgarFetchText(docUrl);

      // Quick check: does this look like Form 4 XML?
      if (!xml.includes("ownershipDocument") && !xml.includes("reportingOwner")) {
        continue;
      }

      const parsed = parseForm4Xml(xml, filing.filingDate, filing.accessionNumber);

      if (parsed && parsed.transactions.length > 0) {
        // Apply transaction type filter
        if (txnFilter !== "all") {
          const filterCode = txnFilter === "buy" ? "A" : "D";
          parsed.transactions = parsed.transactions.filter(
            (t) => t.acquiredOrDisposed === filterCode
          );
        }
        if (parsed.transactions.length > 0) {
          results.push(parsed);
        }
      }
    } catch {
      // Skip individual filing parse errors (malformed docs, 404s, etc.)
      continue;
    }
  }

  return results;
}

// ─── Earnings 8-K Press Releases ────────────────────────────────

export interface Earnings8KFiling {
  accessionNumber: string;
  filingDate: string; // YYYY-MM-DD
  pressReleaseText: string; // Extracted press release content
  filingUrl: string; // Direct URL to filing on SEC website
}

/**
 * Strip HTML tags and decode common entities from EDGAR filing documents.
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, "\t")
    .replace(/<\/th>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Get recent 8-K earnings press releases (Item 2.02) for a company.
 *
 * Item 2.02 ("Results of Operations and Financial Condition") is the standard
 * item for quarterly earnings announcements. The actual press release is
 * typically attached as Exhibit 99.1.
 */
export async function getEarnings8KFilings(
  ticker: string,
  options?: {
    limit?: number;
    /**
     * When true, return the full press-release text (capped at ~60K chars
     * to keep things sane for the LLM). Default false keeps the old
     * 5000-char summary behavior for back-compat with callers that feed
     * this into list views or small-context contexts.
     */
    fullText?: boolean;
  }
): Promise<Earnings8KFiling[]> {
  const limit = Math.min(options?.limit || 4, 10);
  const fullText = !!options?.fullText;

  // Get recent 8-K filings
  const filings = await getRecentFilings(ticker, {
    formType: "8-K",
    limit: limit * 3, // fetch extra to filter for Item 2.02
  });

  if (filings.length === 0) return [];

  const cik = await getCik(ticker);
  const cikNum = parseInt(cik);
  const results: Earnings8KFiling[] = [];

  for (const filing of filings) {
    if (results.length >= limit) break;

    try {
      const accessionNoDashes = filing.accessionNumber.replace(/-/g, "");
      const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionNoDashes}/${filing.primaryDocument}`;

      const docText = await edgarFetchText(docUrl);

      // Check if this 8-K contains Item 2.02 (Results of Operations)
      const isEarnings =
        docText.includes("2.02") ||
        docText.includes("Item\u00a02.02") ||
        docText.includes("Results of Operations");

      if (!isEarnings) continue;

      // Try to get Exhibit 99.1 (the actual press release) from the filing index
      const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionNoDashes}/`;
      let pressRelease = "";

      try {
        const indexHtml = await edgarFetchText(indexUrl);

        // Look for exhibit 99 links (99.1, 99.01, ex99, etc.)
        const exMatch = indexHtml.match(
          /href="([^"]*(?:ex99|exhibit99|ex-99|press)[^"]*\.htm[l]?)"/i
        );

        if (exMatch) {
          const exUrl = exMatch[1].startsWith("http")
            ? exMatch[1]
            : `${indexUrl}${exMatch[1]}`;
          const exHtml = await edgarFetchText(exUrl);
          pressRelease = stripHtmlTags(exHtml);
        }
      } catch {
        // If we can't get the exhibit, use the main 8-K document
      }

      // If no exhibit found, extract from the main document
      if (!pressRelease) {
        pressRelease = stripHtmlTags(docText);
      }

      // Truncation policy:
      //   - Default (fullText=false): 5000-char summary, back-compat for
      //     list views and small-context callers.
      //   - fullText=true: cap at 60K chars so the chat tool can pass
      //     the body through to Claude (Sonnet handles this easily). Some
      //     8-K exhibits exceed 200K chars, which blows context without
      //     a cap.
      const cap = fullText ? 60_000 : 5000;
      if (pressRelease.length > cap) {
        pressRelease = pressRelease.slice(0, cap) +
          `\n\n[Truncated at ${cap.toLocaleString()} chars — full text: ${`https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionNoDashes}/${filing.primaryDocument}`}]`;
      }

      results.push({
        accessionNumber: filing.accessionNumber,
        filingDate: filing.filingDate,
        pressReleaseText: pressRelease,
        filingUrl: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionNoDashes}/${filing.primaryDocument}`,
      });
    } catch {
      continue;
    }
  }

  return results;
}

// ─── 10-K / 10-Q Section Extraction ─────────────────────────────

export interface LatestFilingRef {
  cik: string;
  accessionNumber: string;
  filingDate: string;
  primaryDocument: string;
  form: "10-K" | "10-Q";
  filingUrl: string;
}

/**
 * Locate the most recent 10-K or 10-Q filing for a ticker and return the
 * identifiers needed to fetch its primary document.
 */
export async function getLatestAnnualOrQuarterlyFiling(
  ticker: string,
  filingType: "10-K" | "10-Q",
): Promise<LatestFilingRef | null> {
  const cik = await getCik(ticker);
  const filings = await getRecentFilings(ticker, { formType: filingType, limit: 1 });
  if (filings.length === 0) return null;

  const [filing] = filings;
  const cikNum = parseInt(cik);
  const accessionNoDashes = filing.accessionNumber.replace(/-/g, "");
  const filingUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionNoDashes}/${filing.primaryDocument}`;
  return {
    cik,
    accessionNumber: filing.accessionNumber,
    filingDate: filing.filingDate,
    primaryDocument: filing.primaryDocument,
    form: filingType,
    filingUrl,
  };
}

/**
 * Fetch the primary filing document (HTML) for a 10-K or 10-Q. Callers are
 * expected to strip tags and extract the relevant section via
 * `stripFilingHtml` + `extractItemSection` before sending to an LLM.
 */
export async function fetchFilingPrimaryDoc(
  ref: LatestFilingRef,
): Promise<string> {
  return edgarFetchText(ref.filingUrl);
}

/**
 * Strip tags + decode entities from a filing HTML. Mirrors `stripHtmlTags`
 * used for 8-K press releases but exported so the section extractor can
 * reuse it without dragging the 8-K code path in.
 */
export function stripFilingHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/td>/gi, "\t")
    .replace(/<\/th>/gi, "\t")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Regex-locate a named section in stripped 10-K / 10-Q text.
 *
 * For 10-K the mapping is:
 *   risk_factors → "Item 1A. Risk Factors" ... until "Item 1B" or "Item 2"
 *   mda          → "Item 7." (MD&A) ... until "Item 7A" or "Item 8"
 *
 * For 10-Q the mapping is:
 *   risk_factors → "Item 1A. Risk Factors" ... until next "Item" (Part II)
 *   mda          → "Item 2." (MD&A of Part I) ... until "Item 3"
 *
 * Table-of-contents matches are suppressed by requiring the heading be
 * followed by at least 600 chars before the next "Item" heading — TOC
 * entries have nothing between consecutive headings.
 *
 * Returns null when the section can't be located.
 */
export function extractItemSection(
  text: string,
  filingType: "10-K" | "10-Q",
  section: "risk_factors" | "mda",
): string | null {
  const heading =
    section === "risk_factors"
      ? /Item\s+1A\.?\s*(?:[-—–:]\s*)?Risk\s+Factors/i
      : filingType === "10-K"
        ? /Item\s+7\.?\s*(?:[-—–:]\s*)?Management[^\n]{0,40}Discussion/i
        : /Item\s+2\.?\s*(?:[-—–:]\s*)?Management[^\n]{0,40}Discussion/i;

  const nextHeading =
    section === "risk_factors"
      ? /Item\s+1B\.?|Item\s+2\.?|Unresolved\s+Staff\s+Comments|Properties/i
      : filingType === "10-K"
        ? /Item\s+7A\.?|Item\s+8\.?|Quantitative\s+and\s+Qualitative/i
        : /Item\s+3\.?|Quantitative\s+and\s+Qualitative/i;

  // Find the best match by scanning all heading positions and picking one
  // where enough body text follows before the next heading (filters out TOC).
  const headingGlobal = new RegExp(heading.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = headingGlobal.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const rest = text.slice(start);
    const nextMatch = rest.match(nextHeading);
    const end = nextMatch ? start + (nextMatch.index ?? 0) : text.length;
    const body = text.slice(start, end).trim();
    if (body.length >= 600) {
      return body;
    }
  }
  return null;
}

// ─── Company Search ─────────────────────────────────────────────

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
