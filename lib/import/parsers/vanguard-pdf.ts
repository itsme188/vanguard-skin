import Anthropic from "@anthropic-ai/sdk";
import type {
  ParsedImportResult,
  ParsedTransaction,
  ParsedSecurity,
  ParsedHolding,
  ParsedPrice,
  ParsedSnapshot,
} from "../types";

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
    max_tokens: 16000,
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

    holdings.push({
      accountName,
      symbol: h.symbol,
      securityName: h.name,
      quantity: h.quantity,
      marketValue: h.value,
      asOfDate: statementDate,
      sourceKey: `vanguard-pdf:holding:${accountName}:${h.symbol}:${statementDate}`,
    });

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

    const sec: ParsedSecurity = {
      symbol: h.symbol,
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

    securitiesMap.set(h.symbol, sec);

    if (h.price != null && h.price > 0) {
      prices.push({
        symbol: h.symbol,
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

    transactions.push({
      accountName,
      tradeDate,
      settlementDate,
      type: txnType,
      symbol: t.symbol ?? undefined,
      securityName: t.name,
      quantity: t.quantity ?? undefined,
      amount: t.amount,
      pricePerShare: t.price ?? undefined,
      fees: t.commissions ?? undefined,
      sourceKey: `vanguard-pdf:txn:${accountName}:${tradeDate}:${t.symbol ?? "cash"}:${txnType}:${t.amount}`,
    });

    // Register securities from transactions too (including option metadata)
    if (t.symbol && !securitiesMap.has(t.symbol)) {
      const isOptionTxn = t.option_type != null;
      const sec: ParsedSecurity = {
        symbol: t.symbol,
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

      securitiesMap.set(t.symbol, sec);
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

// ── Full parse entry point (used by import engine) ──────────────────

export async function parseVanguardPdf(
  pdfBuffer: Buffer,
  filename: string
): Promise<ParsedImportResult> {
  const response = await callClaudeForPdfExtraction(pdfBuffer);
  return parseClaudePdfResponse(response, filename);
}
