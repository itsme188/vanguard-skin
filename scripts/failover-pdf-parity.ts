/**
 * Provider-failover PDF parity run (design §8 step 2, hard gate).
 *
 *   npx tsx scripts/failover-pdf-parity.ts --record-baseline <dir>   # Anthropic -> <name>.baseline.json
 *   npx tsx scripts/failover-pdf-parity.ts <dir>                     # OpenAI leg vs each baseline
 *
 * <dir> holds `<name>.pdf` files. Real sheets belong in the gitignored
 * tests/fixtures/real/failover/earningsBogeysExtraction/. BOTH modes make
 * real API calls and spend real money; this script is never run by the test
 * suite. It reads the provider keys from the environment and never prints
 * them. Exit code 1 when any sheet fails the exact-figure gate.
 *
 * Run from the repo root (tsx resolves the @/ alias from the cwd's tsconfig).
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  extractFromPdfAnthropic,
  extractFromPdfOpenAI,
  type PdfExtractionRequest,
} from "../lib/ai/pdf-extraction";
import { BOGEYS_OBJECT_SCHEMA } from "../lib/earnings/extract-bogeys-seam";
import { EXTRACTION_PROMPT, parseExtractionResponse, type ExtractedBogey } from "../lib/earnings/extract-bogeys";
import { compareBogeyParity } from "../lib/earnings/bogey-parity";

function unwrap(text: string): string {
  try {
    const p: unknown = JSON.parse(text);
    if (p && typeof p === "object" && !Array.isArray(p) && Array.isArray((p as { bogeys?: unknown }).bogeys)) {
      return JSON.stringify((p as { bogeys: unknown[] }).bogeys);
    }
  } catch {
    // fenced text: the parser handles it
  }
  return text;
}

async function main() {
  const args = process.argv.slice(2);
  const record = args.includes("--record-baseline");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir || !fs.existsSync(dir)) {
    console.error("usage: failover-pdf-parity.ts [--record-baseline] <dir-with-pdfs>");
    process.exit(2);
  }
  const pdfs = fs.readdirSync(dir).filter((f) => f.endsWith(".pdf")).sort();
  if (pdfs.length === 0) {
    console.error(`no .pdf files in ${dir}`);
    process.exit(2);
  }
  let failed = 0;
  for (const file of pdfs) {
    const name = file.replace(/\.pdf$/, "");
    const req: PdfExtractionRequest = {
      feature: "earningsBogeysExtraction",
      pdfBytes: new Uint8Array(fs.readFileSync(path.join(dir, file))),
      schema: BOGEYS_OBJECT_SCHEMA,
      prompt: EXTRACTION_PROMPT,
    };
    const baselinePath = path.join(dir, `${name}.baseline.json`);
    if (record) {
      const res = await extractFromPdfAnthropic(req);
      fs.writeFileSync(baselinePath, JSON.stringify(parseExtractionResponse(res.text), null, 2));
      console.log(`${name}: baseline recorded (${res.modelId})`);
      continue;
    }
    if (!fs.existsSync(baselinePath)) {
      console.error(`${name}: no baseline (${name}.baseline.json) — run with --record-baseline first`);
      failed += 1;
      continue;
    }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as ExtractedBogey[];
    const res = await extractFromPdfOpenAI(req);
    const report = compareBogeyParity(baseline, parseExtractionResponse(unwrap(res.text)));
    console.log(
      `${name}: ${report.pass ? "PASS" : "FAIL"} (${res.modelId}; ${report.figuresCompared} figures compared; ` +
        `missing ${report.missingSymbols.length}, extra ${report.extraSymbols.length}, mismatched ${report.mismatches.length})`,
    );
    if (!report.pass) {
      failed += 1;
      for (const m of report.mismatches) console.log(`  ${m.symbol} ${m.field}: baseline ${m.baseline} vs ${m.candidate}`);
      if (report.missingSymbols.length) console.log(`  missing: ${report.missingSymbols.join(", ")}`);
      if (report.extraSymbols.length) console.log(`  invented: ${report.extraSymbols.join(", ")}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
