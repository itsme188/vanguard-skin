import Anthropic from "@anthropic-ai/sdk";
import type {
  ParsedImportResult,
  ParsedTransaction,
  ParsedSecurity,
  ParsedHolding,
  ParsedPrice,
  ParsedSnapshot,
} from "../types";
import { extractMaturityDate } from "@/lib/bonds";
import { buildOCCSymbol, isOCCFormat, ensureOCCSymbol } from "../occ-symbol";

// ── Claude API response schema ──────────────────────────────────────

export interface ClaudePdfHolding {
  symbol: string;
  name: string;
  category: string; // "Sweep program" | "Mutual funds" | "ETFs" | "Stocks" | "Bonds" | "Options"
  quantity: number;
  price: number | null;
  value: number;
  underlying_symbol?: string;
  strike_price?: number;
  expiration_date?: string;
  option_type?: "CALL" | "PUT";
}

export interface ClaudePdfTransaction {
  settlement_date: string; // MM/DD or YYYY-MM-DD
  trade_date: string;
  symbol: string | null;
  name: string;
  transaction_type: string; // Dividend, Buy, Sell, Reinvestment, Sweep out, Transfer (in), etc.
  quantity: number | null;
  price: number | null;
  commissions: number | null;
  amount: number;
  underlying_symbol?: string;
  strike_price?: number;
  expiration_date?: string;
  option_type?: "CALL" | "PUT";
}

export interface ClaudePdfResponse {
  account_type: string; // "Individual brokerage account" | "Roth IRA brokerage account"
  account_number_masked: string; // e.g. "XXXX1494"
  statement_date: string; // YYYY-MM-DD
  total_value: number;
  prior_value: number | null;
  cash_balance: number;
  income_summary: {
    dividends: number;
    interest: number;
  };
  holdings: ClaudePdfHolding[];
  transactions: ClaudePdfTransaction[];
}

// ── Prompt for Claude ───────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are extracting structured data from a Vanguard monthly brokerage statement PDF.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):

{
  "account_type": "Individual brokerage account" or "Roth IRA brokerage account",
  "account_number_masked": "XXXX####" (the masked account number shown on the statement),
  "statement_date": "YYYY-MM-DD" (the statement date, e.g. "2025-01-31"),
  "total_value": <number> (total account value as of statement date),
  "prior_value": <number or null> (value at prior month-end if shown),
  "cash_balance": <number> (sweep program / money market balance, or 0 if none),
  "income_summary": {
    "dividends": <number>,
    "interest": <number>
  },
  "holdings": [
    {
      "symbol": "<ticker or OCC option symbol>",
      "name": "<full security name>",
      "category": "Sweep program" | "Mutual funds" | "ETFs" | "Stocks" | "Bonds" | "Options",
      "quantity": <number>,
      "price": <number or null>,
      "value": <number> (balance as of statement date),
      "underlying_symbol": "<ticker of the underlying stock, only for options>",
      "strike_price": <number, only for options>,
      "expiration_date": "YYYY-MM-DD" (only for options),
      "option_type": "CALL" or "PUT" (only for options)
    }
  ],
  "transactions": [
    {
      "settlement_date": "YYYY-MM-DD",
      "trade_date": "YYYY-MM-DD",
      "symbol": "<ticker or null>",
      "name": "<security name>",
      "transaction_type": "<type>",
      "quantity": <number or null>,
      "price": <number or null>,
      "commissions": <number or null>,
      "amount": <number> (positive for inflows, negative for outflows),
      "underlying_symbol": "<ticker, only for option transactions>",
      "strike_price": <number, only for option transactions>,
      "expiration_date": "YYYY-MM-DD" (only for option transactions),
      "option_type": "CALL" or "PUT" (only for option transactions)
    }
  ]
}

CRITICAL — COMPLETENESS:
- You MUST extract EVERY SINGLE holding from the statement. Do not skip or truncate.
- The statement may have holdings across multiple pages and multiple sections (Sweep program, Mutual funds, ETFs & ETNs, Stocks, Bonds & CDs, Options).
- Scan ALL pages of the PDF. Holdings typically appear in the "Holdings details" or "Your holdings" section.
- After extraction, verify: the sum of all holdings values should approximately equal total_value. If it doesn't, you likely missed some holdings — go back and extract them.
- A typical brokerage statement has 50-120+ holdings. If you extracted fewer than 40 holdings from a brokerage account, you likely missed a section.

Rules:
- Convert all dates from MM/DD to YYYY-MM-DD using the statement year
- For holdings, use the "Balance on [statement date]" column as the value
- For mutual funds that appear twice (e.g. CASH and non-CASH share classes), include both as separate entries
- For OPTIONS: set category to "Options", extract underlying_symbol (e.g. "APP" for CALL APPLOVIN CORP), strike_price, expiration_date (YYYY-MM-DD), and option_type ("CALL" or "PUT"). Use an OCC-style symbol like "APP   250221C00135000" (underlying padded to 6 chars + YYMMDD + C/P + strike*1000 padded to 8 digits). Quantity is in contracts (not shares).
- Combine the sweep program balance as cash_balance
- For transaction amounts: dividends are positive, purchases are negative, sales are positive
- Skip sweep out/sweep in transactions (these are just cash movements to/from money market)
- Include all transaction types: Dividend, Reinvestment, Buy, Sell, Buy to open, Sell to close, Transfer (in), Transfer (out), Expired, Exercised, Interest charge, Foreign Tax Withheld
- For option transactions, also include underlying_symbol, strike_price, expiration_date, and option_type
- If a field is not applicable or not shown, use null`;

// ── Claude API call ─────────────────────────────────────────────────

export async function callClaudeForPdfExtraction(
  pdfBuffer: Buffer
): Promise<ClaudePdfResponse> {
  const client = new Anthropic();

  const base64Pdf = pdfBuffer.toString("base64");

  // Use streaming to avoid 10-minute timeout on large PDFs
  const stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 64000,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64Pdf,
            },
          },
          {
            type: "text",
            text: EXTRACTION_PROMPT,
          },
        ],
      },
    ],
  });

  const message = await stream.finalMessage();

  // Check for output truncation
  if (message.stop_reason === "max_tokens") {
    throw new Error(
      `Claude API response was truncated (hit max_tokens limit of 64000). ` +
      `The PDF may be too large for a single extraction call.`
    );
  }

  // Extract JSON from the response
  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude API");
  }

  // Strip markdown code fences if Claude wrapped the JSON
  let jsonText = textBlock.text.trim();
  if (jsonText.startsWith("```")) {
    jsonText = jsonText
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }

  try {
    return JSON.parse(jsonText) as ClaudePdfResponse;
  } catch {
    throw new Error(
      `Failed to parse Claude response as JSON: ${jsonText.slice(0, 200)}`
    );
  }
}

// ── Response → ParsedImportResult ───────────────────────────────────

function resolveAccountName(accountType: string): string {
  if (accountType.toLowerCase().includes("roth")) return "Vanguard Roth IRA";
  return "Vanguard Taxable";
}

function normalizeDate(date: string, statementYear: string): string {
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  // MM/DD format — add year
  if (/^\d{2}\/\d{2}$/.test(date)) {
    const [month, day] = date.split("/");
    return `${statementYear}-${month}-${day}`;
  }
  return date;
}

function mapTransactionType(vanguardType: string): string {
  const typeMap: Record<string, string> = {
    "Dividend": "DIVIDEND",
    "Reinvestment": "REINVESTMENT",
    "Buy": "BUY",
    "Buy to open": "BUY_TO_OPEN",
    "Sell": "SELL",
    "Sell to close": "SELL_TO_CLOSE",
    "Transfer (in)": "TRANSFER_IN",
    "Transfer (out)": "TRANSFER_OUT",
    "Expired": "EXPIRED",
    "EXPIRED": "EXPIRED",
    "Exercised": "EXERCISED",
    "EXERCISED": "EXERCISED",
    "Interest charge": "INTEREST",
    "Foreign Tax Withheld": "TAX_WITHHELD",
    "Sweep out": "SWEEP",
    "Sweep in": "SWEEP",
  };
  return typeMap[vanguardType] ?? vanguardType.toUpperCase().replace(/\s+/g, "_");
}

export function parseClaudePdfResponse(
  response: ClaudePdfResponse,
  filename: string
): ParsedImportResult {
  const accountName = resolveAccountName(response.account_type);
  const statementDate = response.statement_date;
  const statementYear = statementDate.slice(0, 4);

  const securitiesMap = new Map<string, ParsedSecurity>();
  const holdings: ParsedHolding[] = [];
  const prices: ParsedPrice[] = [];
  const transactions: ParsedTransaction[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // Process holdings
  for (const h of response.holdings) {
    if (!h.symbol) continue;

    const isOption = h.category === "Options" || h.option_type != null;
    const securityType = isOption
      ? "Option"
      : h.category === "Bonds"
        ? "Bond"
        : h.category === "ETFs"
          ? "ETF"
          : h.category === "Mutual funds"
            ? "Mutual Fund"
            : "Stock";

    // For options, ensure we use OCC-format symbol (not bare ticker)
    // This prevents collisions where "INTC" stock and "INTC" option share the same symbol
    let effectiveSymbol = h.symbol;
    if (isOption) {
      const corrected = ensureOCCSymbol(
        h.symbol, h.underlying_symbol, h.expiration_date, h.option_type, h.strike_price
      );
      if (corrected !== h.symbol) {
        warnings.push(
          `Option ${h.name}: converted bare ticker "${h.symbol}" to OCC symbol "${corrected}"`
        );
      }
      effectiveSymbol = corrected;
    }

    holdings.push({
      accountName,
      symbol: effectiveSymbol,
      securityName: h.name,
      quantity: h.quantity,
      marketValue: h.value,
      asOfDate: statementDate,
      sourceKey: `vanguard-pdf:holding:${accountName}:${effectiveSymbol}:${statementDate}`,
    });

    const sec: ParsedSecurity = {
      symbol: effectiveSymbol,
      name: h.name,
      securityType,
    };

    if (isOption) {
      sec.underlyingSymbol = h.underlying_symbol;
      sec.strikePrice = h.strike_price;
      sec.expirationDate = h.expiration_date;
      sec.optionType = h.option_type;
      sec.multiplier = 100;
    }

    if (securityType === "Bond") {
      sec.maturityDate = extractMaturityDate(h.name) ?? undefined;
    }

    securitiesMap.set(effectiveSymbol, sec);

    if (h.price != null && h.price > 0) {
      prices.push({
        symbol: effectiveSymbol,
        date: statementDate,
        closePrice: h.price,
        source: "vanguard-pdf",
      });
    }
  }

  // Process transactions
  for (const t of response.transactions) {
    const txnType = mapTransactionType(t.transaction_type);

    // Skip sweep transactions
    if (txnType === "SWEEP") continue;

    const tradeDate = normalizeDate(t.trade_date, statementYear);
    const settlementDate = normalizeDate(t.settlement_date, statementYear);

    // For option transactions, ensure OCC-format symbol
    const isOptionTxn = t.option_type != null;
    let txnSymbol = t.symbol ?? undefined;
    if (isOptionTxn && txnSymbol) {
      const corrected = ensureOCCSymbol(
        txnSymbol, t.underlying_symbol, t.expiration_date, t.option_type, t.strike_price
      );
      if (corrected !== txnSymbol) {
        warnings.push(
          `Option txn ${t.name}: converted bare ticker "${txnSymbol}" to OCC symbol "${corrected}"`
        );
      }
      txnSymbol = corrected;
    }

    transactions.push({
      accountName,
      tradeDate,
      settlementDate,
      type: txnType,
      symbol: txnSymbol,
      securityName: t.name,
      quantity: t.quantity ?? undefined,
      amount: t.amount,
      pricePerShare: t.price ?? undefined,
      fees: t.commissions ?? undefined,
      sourceKey: `vanguard-pdf:txn:${accountName}:${tradeDate}:${txnSymbol ?? "cash"}:${txnType.toLowerCase()}:${t.amount}`,
    });

    // Register securities from transactions too (including option metadata)
    if (txnSymbol && !securitiesMap.has(txnSymbol)) {
      const sec: ParsedSecurity = {
        symbol: txnSymbol,
        name: t.name,
      };

      if (isOptionTxn) {
        sec.securityType = "Option";
        sec.underlyingSymbol = t.underlying_symbol;
        sec.strikePrice = t.strike_price;
        sec.expirationDate = t.expiration_date;
        sec.optionType = t.option_type;
        sec.multiplier = 100;
      }

      securitiesMap.set(txnSymbol, sec);
    }
  }

  // Monthly snapshot
  const snapshots: ParsedSnapshot[] = [
    {
      accountName,
      monthEndDate: statementDate,
      totalValue: response.total_value,
      source: "vanguard-pdf",
      dividends: response.income_summary.dividends,
      interest: response.income_summary.interest,
    },
  ];

  // Completeness validation: compare extracted holdings total vs statement total
  const extractedTotal = response.holdings.reduce((sum, h) => sum + (h.value || 0), 0);
  const statementTotal = response.total_value;
  if (statementTotal > 0) {
    const coveragePct = (extractedTotal / statementTotal) * 100;
    if (coveragePct < 95) {
      warnings.push(
        `Incomplete extraction: holdings sum to $${extractedTotal.toLocaleString()} ` +
        `(${coveragePct.toFixed(0)}% of statement total $${statementTotal.toLocaleString()}). ` +
        `${holdings.length} holdings extracted — some may be missing. ` +
        `Consider undoing this import and re-importing the PDF.`
      );
    }
  }

  return {
    sourceType: "vanguard-pdf",
    sourceName: filename,
    transactions,
    securities: Array.from(securitiesMap.values()),
    holdings,
    prices,
    snapshots,
    errors,
    warnings,
  };
}

// ── Focused holdings extraction (no transactions) ───────────────────

const FOCUSED_HOLDINGS_PROMPT = `You are extracting structured data from a Vanguard monthly brokerage statement PDF.

IMPORTANT: Extract the account summary and ALL holdings. Do NOT extract transactions — set "transactions" to an empty array.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):

{
  "account_type": "Individual brokerage account" or "Roth IRA brokerage account",
  "account_number_masked": "XXXX####",
  "statement_date": "YYYY-MM-DD",
  "total_value": <number>,
  "prior_value": <number or null>,
  "cash_balance": <number>,
  "income_summary": { "dividends": <number>, "interest": <number> },
  "holdings": [
    {
      "symbol": "<ticker, CUSIP for bonds, or OCC option symbol>",
      "name": "<full security name>",
      "category": "Sweep program" | "Mutual funds" | "ETFs" | "Stocks" | "Bonds" | "Options",
      "quantity": <number>,
      "price": <number or null>,
      "value": <number> (balance as of statement date),
      "underlying_symbol": "<ticker, only for options>",
      "strike_price": <number, only for options>,
      "expiration_date": "YYYY-MM-DD" (only for options),
      "option_type": "CALL" or "PUT" (only for options)
    }
  ],
  "transactions": []
}

CRITICAL — COMPLETENESS (READ THIS CAREFULLY):
- The holdings section spans 8-15 PAGES. You MUST read EVERY page until you reach "Transaction activity".
- The statement has these sections IN THIS ORDER. Extract from ALL of them:
  1. **Sweep program** — money market fund (e.g. VANGUARD FEDERAL MONEY MARKET FUND)
  2. **Mutual funds** — symbols like VEMBX, VEXPX, VHGEX, VIPSX, VMBSX, VSMAX, VVIAX. Some appear twice (CASH and non-CASH share classes) — include BOTH.
  3. **ETFs** — symbols like VTI, VGT, VDC, VEU, VHT, VNQ, SPY, QQQ, ACWV, EIS, IDEV, INDA, BBH, XLV
  4. **Stocks and options** — This is the LONGEST section (5-10 pages!). It contains stocks (AAPL, AMZN, GOOG, META, MSFT, etc.) MIXED with options (CALL/PUT entries with strike prices). Do NOT stop partway through. Keep reading until you see "Bonds" or "Long market value" / "Short market value" totals.
  5. **Bonds** — Treasury Bills and Notes identified by CUSIP (e.g. 912797QG5, 91282CFV8). Use the CUSIP as the symbol.
- After the last section there are subtotals: "Long market value", "Short market value", then a final total that should match total_value.
- A typical brokerage statement has **80-120+ holdings**. If you extracted fewer than 60, you definitely missed pages — go back and check.
- After extraction, VERIFY: sum of all holdings values ≈ total_value. If the sum is off by more than 5%, you missed holdings.

Rules:
- Convert all dates from MM/DD to YYYY-MM-DD using the statement year
- Use the "Balance on [statement date]" column (the rightmost balance column) as the value
- For mutual funds appearing twice (CASH and non-CASH share classes), include both as separate entries with the same symbol
- For OPTIONS: set category to "Options". Extract underlying_symbol, strike_price, expiration_date, option_type. Use OCC-style symbol: underlying padded to 6 chars + YYMMDD + C/P + strike×1000 padded to 8 digits. Example: "APP   250221C00135000". Quantity is in contracts.
- For BONDS: use the CUSIP as the symbol. Set category to "Bonds". The price is a percentage of par.
- Securities with no price (showing "-") are unpriced — set price to null but still include them with value 0.
- For short positions (negative quantity like TSLA -25), include them with negative quantity.
- Set cash_balance to the sweep program balance
- If a field is not applicable or not shown, use null`;

function buildRetryPrompt(totalValue: number, foundSum: number, foundCount: number, foundCategories: string[]): string {
  const missing = totalValue - foundSum;
  const coveragePct = ((foundSum / totalValue) * 100).toFixed(0);
  const allCategories = ["Sweep program", "Mutual funds", "ETFs", "Stocks", "Options", "Bonds"];
  const missingCategories = allCategories.filter(c => !foundCategories.includes(c));

  return `You are extracting holdings from a Vanguard monthly brokerage statement PDF.

A PREVIOUS ATTEMPT ONLY FOUND ${foundCount} holdings totaling $${foundSum.toLocaleString()} (${coveragePct}% of the account total $${totalValue.toLocaleString()}).
That means approximately $${missing.toLocaleString()} in holdings value is MISSING.
${missingCategories.length > 0 ? `\nSections that appear to be MISSING or INCOMPLETE: ${missingCategories.join(", ")}` : ""}
${foundCategories.length > 0 ? `Sections that were found: ${foundCategories.join(", ")}` : ""}

You MUST do better. Read EVERY page of the holdings section carefully.

Return ONLY valid JSON (no markdown):
{
  "holdings": [
    {
      "symbol": "<ticker, CUSIP for bonds, or OCC option symbol>",
      "name": "<full security name>",
      "category": "Sweep program" | "Mutual funds" | "ETFs" | "Stocks" | "Bonds" | "Options",
      "quantity": <number>,
      "price": <number or null>,
      "value": <number>,
      "underlying_symbol": "<ticker, only for options>",
      "strike_price": <number, only for options>,
      "expiration_date": "YYYY-MM-DD" (only for options),
      "option_type": "CALL" or "PUT" (only for options)
    }
  ]
}

CRITICAL:
- IGNORE transaction pages. Only extract from "Balances and holdings" section.
- The holdings span 8-15 pages across sections: Sweep program → Mutual funds → ETFs → Stocks and options → Bonds.
- "Stocks and options" is the LONGEST section (5-10 pages). Read ALL of it.
- For BONDS: use CUSIP as symbol (e.g. 912797QG5). Category = "Bonds".
- For OPTIONS: use OCC symbol format (underlying padded to 6 + YYMMDD + C/P + strike×1000 padded to 8).
- Include BOTH share classes for mutual funds (CASH and non-CASH).
- Include short positions with negative quantity.
- Target: 80-120+ holdings totaling ~$${totalValue.toLocaleString()}.
- VERIFY your sum matches the account total before responding.`;
}

/** Generic Claude API call with a given prompt against a PDF. */
async function callClaudeWithPdf<T>(pdfBuffer: Buffer, prompt: string): Promise<T> {
  const client = new Anthropic();
  const base64Pdf = pdfBuffer.toString("base64");

  const stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 64000,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64Pdf,
            },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude API response was truncated (hit max_tokens limit).");
  }

  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude API");
  }

  let jsonText = textBlock.text.trim();
  if (jsonText.startsWith("```")) {
    jsonText = jsonText
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }

  return JSON.parse(jsonText) as T;
}

/**
 * Merge holdings from multiple extraction attempts into a deduplicated union.
 * Different Claude API calls often extract different subsets of holdings from
 * the same PDF. Merging by symbol yields better coverage than any single attempt.
 * For duplicate symbols, keeps the entry with the higher reported value.
 */
function mergeHoldings(
  ...attempts: ClaudePdfHolding[][]
): ClaudePdfHolding[] {
  const merged = new Map<string, ClaudePdfHolding>();
  for (const holdings of attempts) {
    for (const h of holdings) {
      const key = h.symbol;
      const existing = merged.get(key);
      if (!existing || (h.value || 0) > (existing.value || 0)) {
        merged.set(key, h);
      }
    }
  }
  return Array.from(merged.values());
}

/**
 * Extract holdings from a PDF with multi-attempt validation.
 * Returns a ClaudePdfResponse with holdings populated and transactions empty.
 * Retries up to 2 times if coverage < 95%, merging unique holdings across
 * all attempts for maximum coverage.
 */
export async function extractHoldingsFromPdf(
  pdfBuffer: Buffer
): Promise<ClaudePdfResponse> {
  // Attempt 1: Focused holdings extraction (no transactions)
  const response = await callClaudeWithPdf<ClaudePdfResponse>(pdfBuffer, FOCUSED_HOLDINGS_PROMPT);
  response.transactions = []; // Ensure empty

  const attempt1Holdings = [...response.holdings];
  let holdingsSum = response.holdings.reduce((s, h) => s + (h.value || 0), 0);
  let coverage = response.total_value > 0 ? holdingsSum / response.total_value : 1;

  console.log(
    `[holdings] Attempt 1: ${response.holdings.length} holdings, ` +
    `$${holdingsSum.toLocaleString()} / $${response.total_value.toLocaleString()} ` +
    `(${(coverage * 100).toFixed(0)}% coverage)`
  );

  if (coverage >= 0.95) return response;

  // Attempt 2: Retry with context about what was missed
  const foundCategories = Array.from(new Set(response.holdings.map(h => h.category)));
  const retryPrompt = buildRetryPrompt(response.total_value, holdingsSum, response.holdings.length, foundCategories);
  const retry1 = await callClaudeWithPdf<{ holdings: ClaudePdfHolding[] }>(pdfBuffer, retryPrompt);
  const retry1Sum = retry1.holdings.reduce((s, h) => s + (h.value || 0), 0);

  console.log(
    `[holdings] Attempt 2: ${retry1.holdings.length} holdings, $${retry1Sum.toLocaleString()}`
  );

  // Merge attempts 1+2 for better coverage
  const merged12 = mergeHoldings(attempt1Holdings, retry1.holdings);
  const merged12Sum = merged12.reduce((s, h) => s + (h.value || 0), 0);
  coverage = response.total_value > 0 ? merged12Sum / response.total_value : 1;

  console.log(
    `[holdings] Merged (1+2): ${merged12.length} holdings, ` +
    `$${merged12Sum.toLocaleString()} (${(coverage * 100).toFixed(0)}% coverage)`
  );

  if (coverage >= 0.95) {
    response.holdings = merged12;
    return response;
  }

  // Attempt 3: One more retry with updated context
  const mergedCategories = Array.from(new Set(merged12.map(h => h.category)));
  const retryPrompt2 = buildRetryPrompt(response.total_value, merged12Sum, merged12.length, mergedCategories);
  const retry2 = await callClaudeWithPdf<{ holdings: ClaudePdfHolding[] }>(pdfBuffer, retryPrompt2);
  const retry2Sum = retry2.holdings.reduce((s, h) => s + (h.value || 0), 0);

  console.log(
    `[holdings] Attempt 3: ${retry2.holdings.length} holdings, $${retry2Sum.toLocaleString()}`
  );

  // Merge all three attempts
  const mergedAll = mergeHoldings(attempt1Holdings, retry1.holdings, retry2.holdings);
  const mergedAllSum = mergedAll.reduce((s, h) => s + (h.value || 0), 0);
  const finalCoverage = response.total_value > 0 ? mergedAllSum / response.total_value : 1;

  console.log(
    `[holdings] Merged (1+2+3): ${mergedAll.length} holdings, ` +
    `$${mergedAllSum.toLocaleString()} (${(finalCoverage * 100).toFixed(0)}% coverage)`
  );

  response.holdings = mergedAll;
  return response;
}

// ── Full parse entry point (used by import engine) ──────────────────

export async function parseVanguardPdf(
  pdfBuffer: Buffer,
  filename: string
): Promise<ParsedImportResult> {
  // Step 1: Extract holdings with multi-attempt validation (no transactions)
  const response = await extractHoldingsFromPdf(pdfBuffer);

  // Step 2: Extract transactions in a separate call
  console.log(`[vanguard-pdf] Extracting transactions separately...`);
  try {
    const txnResponse = await callClaudeForPdfExtraction(pdfBuffer);
    response.transactions = txnResponse.transactions;
  } catch (err) {
    console.error(`[vanguard-pdf] Transaction extraction failed: ${err}. Continuing with holdings only.`);
    response.transactions = [];
  }

  return parseClaudePdfResponse(response, filename);
}
