/**
 * One-time script to generate the PDF test fixture from a real Vanguard statement.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/generate-pdf-fixture.ts <path-to-pdf>
 *
 * Example:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/generate-pdf-fixture.ts \
 *     ~/Desktop/Portfolio\ -\ Dashboard/data/vanguard/01-2025\ roth.pdf
 *
 * This will:
 * 1. Read the PDF file
 * 2. Send it to Claude API for extraction
 * 3. Save the response as tests/fixtures/vanguard-pdf-claude-response.json
 */

import fs from "node:fs";
import path from "node:path";
import { callClaudeForPdfExtraction } from "../lib/import/parsers/vanguard-pdf";

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error("Usage: npx tsx scripts/generate-pdf-fixture.ts <path-to-pdf>");
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required");
    process.exit(1);
  }

  const resolvedPath = path.resolve(pdfPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: File not found: ${resolvedPath}`);
    process.exit(1);
  }

  console.log(`Reading PDF: ${resolvedPath}`);
  const pdfBuffer = fs.readFileSync(resolvedPath);
  console.log(`PDF size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

  console.log("Sending to Claude API...");
  const response = await callClaudeForPdfExtraction(pdfBuffer);

  console.log(`Extracted:`);
  console.log(`  Account: ${response.account_type}`);
  console.log(`  Date: ${response.statement_date}`);
  console.log(`  Value: $${response.total_value.toLocaleString()}`);
  console.log(`  Holdings: ${response.holdings.length}`);
  console.log(`  Transactions: ${response.transactions.length}`);

  const outPath = path.join(
    __dirname,
    "..",
    "tests",
    "fixtures",
    "vanguard-pdf-claude-response.json"
  );

  fs.writeFileSync(outPath, JSON.stringify(response, null, 2) + "\n");
  console.log(`\nSaved fixture to: ${outPath}`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
