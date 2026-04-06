/**
 * Batch-convert raw brokerage files to canonical CSV format using Claude API.
 *
 * Usage:
 *   npx tsx scripts/preprocess-to-canonical.ts <input-dir> [output-dir]
 *
 * Input directory should contain raw PDFs/CSVs from brokerages.
 * Output directory defaults to <input-dir>/canonical/
 *
 * Requires ANTHROPIC_API_KEY in environment or .env.local
 */

import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

// ── Load env ────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (!process.env[key]) process.env[key] = value;
      }
    }
  }
}

loadEnv();

// ── Config ──────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".csv", ".txt"]);

const SYSTEM_PROMPT = `You are a financial data extraction expert. Convert raw brokerage documents into standardized CSV format for the Vanguard Skin portfolio dashboard.

Output rules:
- Output ONLY CSV content, no markdown fences, no explanations
- If multiple CSV types are needed, prefix each with a comment line: # filename.csv
- All dates: YYYY-MM-DD
- Transaction types: UPPERCASE (BUY, SELL, DIVIDEND, REINVESTMENT, INTEREST, TAX_WITHHELD, TRANSFER, TRANSFER_IN, TRANSFER_OUT, DEPOSIT, WITHDRAWAL, FEE, COMMISSION, BUY_TO_OPEN, SELL_TO_CLOSE, SELL_TO_OPEN, BUY_TO_CLOSE, BUY_TO_COVER, EXERCISED, ASSIGNED, EXPIRED, REDEMPTION, EXCHANGE, CORPORATE_ACTION, SPINOFF, MERGER, SPLIT, RETURN_OF_CAPITAL, SHORT_SELL)
- Security types: Stock, Bond, ETF, Option, Mutual Fund
- Options: OCC format (symbol padded to 6 chars + YYMMDD + C/P + strike x1000 padded to 8)
- Numbers: no currency symbols, no commas

CSV Formats:

1. Transactions:
account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes

2. Holdings:
account,as_of_date,symbol,security_name,security_type,quantity,cost_basis,market_value

3. Prices:
symbol,date,close_price

4. Monthly Snapshots:
account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr`;

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const inputDir = process.argv[2];
  const outputDir = process.argv[3] || path.join(inputDir || "", "canonical");

  if (!inputDir) {
    console.error("Usage: npx tsx scripts/preprocess-to-canonical.ts <input-dir> [output-dir]");
    console.error("\nExample:");
    console.error("  npx tsx scripts/preprocess-to-canonical.ts ~/Desktop/statements");
    process.exit(1);
  }

  if (!fs.existsSync(inputDir)) {
    console.error(`Input directory not found: ${inputDir}`);
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not found in environment or .env.local");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  // Find all supported files
  const files = fs.readdirSync(inputDir)
    .filter(f => SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .sort();

  if (files.length === 0) {
    console.error(`No supported files found in ${inputDir}`);
    console.error("Supported: .pdf, .csv, .txt");
    process.exit(1);
  }

  // Create output dir
  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`\nInput:  ${inputDir} (${files.length} files)`);
  console.log(`Output: ${outputDir}\n`);

  let processed = 0;
  let failed = 0;

  for (const file of files) {
    const filePath = path.join(inputDir, file);
    const ext = path.extname(file).toLowerCase();
    const baseName = path.basename(file, ext);

    process.stdout.write(`Processing ${file}...`);

    try {
      let content: Anthropic.ContentBlockParam[];

      if (ext === ".pdf") {
        const pdfBuffer = fs.readFileSync(filePath);
        const base64 = pdfBuffer.toString("base64");
        content = [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          },
          {
            type: "text",
            text: `Convert all financial data in this document to canonical CSV format. Use the account name from the statement. Extract transactions AND holdings if both are present.`,
          },
        ];
      } else {
        const textContent = fs.readFileSync(filePath, "utf-8");
        content = [
          {
            type: "text",
            text: `Convert this financial data to canonical CSV format:\n\n${textContent}`,
          },
        ];
      }

      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 16384,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      });

      const outputText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map(b => b.text)
        .join("\n");

      // Split output into multiple files if it contains # filename.csv markers
      const sections = splitSections(outputText, baseName);

      for (const [sectionName, sectionContent] of sections) {
        const outputPath = path.join(outputDir, sectionName);
        fs.writeFileSync(outputPath, sectionContent.trim() + "\n");
      }

      console.log(` \x1b[32m✓\x1b[0m (${sections.length} file${sections.length !== 1 ? "s" : ""})`);
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(` \x1b[31m✗\x1b[0m ${msg}`);
      failed++;
    }
  }

  console.log(`\nDone: ${processed} processed, ${failed} failed`);
  console.log(`Output: ${outputDir}`);

  if (processed > 0) {
    console.log("\nNext steps:");
    console.log(`  1. Review the output CSVs in ${outputDir}`);
    console.log(`  2. Validate: npx tsx scripts/validate-canonical-csv.ts ${outputDir}/<file>.csv`);
    console.log(`  3. Import: drag files into the Import tab`);
  }
}

function splitSections(text: string, defaultName: string): [string, string][] {
  const lines = text.split("\n");
  const sections: [string, string][] = [];
  let currentName = `${defaultName}.csv`;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^#\s*(.+\.csv)\s*$/);
    if (match) {
      if (currentLines.length > 0) {
        sections.push([currentName, currentLines.join("\n")]);
      }
      currentName = match[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push([currentName, currentLines.join("\n")]);
  }

  return sections.filter(([, content]) => content.trim().length > 0);
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});
