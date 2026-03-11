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

// ── OCC symbol utilities ────────────────────────────────────────────

/**
 * Build an OCC-format option symbol from component parts.
 * Format: AAPL  250321C00150000
 *   - Underlying padded to 6 chars
 *   - YYMMDD expiration
 *   - C or P
 *   - Strike × 1000, padded to 8 digits
 */
function buildOCCSymbol(
  underlying: string,
  expirationDate: string,  // YYYY-MM-DD
  optionType: "CALL" | "PUT",
  strike: number
): string {
  const paddedUnderlying = underlying.slice(0, 6).padEnd(6, " ");
  const [year, month, day] = expirationDate.split("-");
  const occDate = `${year.slice(2)}${month}${day}`;
  const cpFlag = optionType === "CALL" ? "C" : "P";
  const occStrike = Math.round(strike * 1000).toString().padStart(8, "0");
  return `${paddedUnderlying}${occDate}${cpFlag}${occStrike}`;
}

/**
 * Check whether a symbol is already in OCC format (has spaces + date digits).
 */
function isOCCFormat(symbol: string): boolean {
  // OCC symbols are 21 chars: 6-char underlying (may have spaces) + 6-digit date + C/P + 8-digit strike
  return /^.{6}\d{6}[CP]\d{8}$/.test(symbol);
}

/**
 * If an option has a bare ticker as symbol but full metadata available,
 * convert it to OCC format. Returns the corrected symbol.
 */
function ensureOCCSymbol(
  symbol: string,
  underlyingSymbol: string | undefined,
  expirationDate: string | undefined,
  optionType: "CALL" | "PUT" | undefined,
  strikePrice: number | undefined
): string {
  // Already OCC format — leave it alone
  if (isOCCFormat(symbol)) return symbol;

  // Have enough metadata to build OCC
  if (underlyingSymbol && expirationDate && optionType && strikePrice != null) {
    return buildOCCSymbol(underlyingSymbol, expirationDate, optionType, strikePrice);
  }

  // Not OCC and not enough metadata — return as-is (will log a warning)
  return symbol;
}

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
    model: "claude-sonnet-4-20250514",
    max_tokens: 64000,
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
      ? "option"
      : h.category === "Bonds"
        ? "bond"
        : h.category === "ETFs"
          ? "etf"
          : h.category === "Mutual funds"
            ? "mutual_fund"
            : "stock";

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

    if (securityType === "bond") {
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
        sec.securityType = "option";
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
    if (coveragePct < 80) {
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

// ── Holdings-only retry prompt ───────────────────────────────────────

const HOLDINGS_ONLY_PROMPT = `You are extracting ONLY the holdings from a Vanguard monthly brokerage statement PDF.

A previous extraction attempt missed many holdings. You MUST extract ALL of them this time.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):

{
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
  ]
}

CRITICAL:
- IGNORE the transaction activity pages entirely. Only extract from the holdings/balance sections.
- The holdings section may span MANY pages. Read EVERY page.
- Sections include: Sweep program, Mutual funds, ETFs & ETNs, Stocks, Bonds & CDs, Options.
- For OPTIONS: use OCC-style symbol (underlying padded to 6 chars + YYMMDD + C/P + strike*1000 padded to 8 digits).
- The account has 50-120+ holdings. If you have fewer than that, you missed some pages.`;

async function callClaudeForHoldingsOnly(
  pdfBuffer: Buffer
): Promise<{ holdings: ClaudePdfHolding[] }> {
  const client = new Anthropic();
  const base64Pdf = pdfBuffer.toString("base64");

  const stream = client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 64000,
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
            text: HOLDINGS_ONLY_PROMPT,
          },
        ],
      },
    ],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "max_tokens") {
    throw new Error("Holdings-only extraction was truncated (hit max_tokens).");
  }

  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude API (holdings retry)");
  }

  let jsonText = textBlock.text.trim();
  if (jsonText.startsWith("```")) {
    jsonText = jsonText
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "");
  }

  return JSON.parse(jsonText) as { holdings: ClaudePdfHolding[] };
}

// ── Full parse entry point (used by import engine) ──────────────────

export async function parseVanguardPdf(
  pdfBuffer: Buffer,
  filename: string
): Promise<ParsedImportResult> {
  const response = await callClaudeForPdfExtraction(pdfBuffer);

  // Check if holdings extraction was complete
  if (response.total_value > 0) {
    const holdingsTotal = response.holdings.reduce(
      (sum, h) => sum + (h.value || 0),
      0
    );
    const coveragePct = (holdingsTotal / response.total_value) * 100;

    if (coveragePct < 80) {
      // Holdings extraction was incomplete — make a focused second call
      console.log(
        `[vanguard-pdf] Incomplete holdings: ${response.holdings.length} holdings = ` +
        `$${holdingsTotal.toLocaleString()} (${coveragePct.toFixed(0)}% of ` +
        `$${response.total_value.toLocaleString()}). Retrying with holdings-only extraction...`
      );

      const retry = await callClaudeForHoldingsOnly(pdfBuffer);

      if (retry.holdings.length > response.holdings.length) {
        console.log(
          `[vanguard-pdf] Retry extracted ${retry.holdings.length} holdings ` +
          `(was ${response.holdings.length}). Using retry results.`
        );
        response.holdings = retry.holdings;
      } else {
        console.log(
          `[vanguard-pdf] Retry got ${retry.holdings.length} holdings ` +
          `(same or fewer than ${response.holdings.length}). Keeping original.`
        );
      }
    }
  }

  return parseClaudePdfResponse(response, filename);
}
