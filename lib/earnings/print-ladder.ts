/**
 * The one-sheet ladder, extracted (live print v2 slice E) so the post-print
 * sheet and the pre-print worksheet share ONE implementation rather than two
 * drifting copies of a 60-line loop.
 *
 * Three rungs, capped, never a loop (2026-08-07 decision, worksheet.ts):
 *   1. render as composed
 *   2. >2 pages → re-render with the FLEXIBLE block dropped (Past prints on the
 *      pre-print sheet; the bogeys-by-source table on the post-print one)
 *   3. still >2 → re-render compact (smaller font, tighter spacing)
 *   still >2 → print it anyway. Content NEVER truncates to hit a page count.
 *
 * A 0-page count means the renderer produced something unparseable; 0 is not
 * "fits on one sheet" in any sense worth trusting, so it throws.
 *
 * This function THROWS on any failure — rendering, page-counting or lp. The
 * caller owns the downgrade policy (the worksheet and the post-print sheet both
 * fall back to a monospace road; that decision does not belong here).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countPdfPages, printPdfViaLp, renderHtmlToPdf } from "@/lib/earnings/print-pdf";

export interface PrintLadderSeams {
  renderPdf?: typeof renderHtmlToPdf;
  printPdf?: typeof printPdfViaLp;
}

export const MAX_SHEET_PAGES = 2;

export async function printHtmlOneSheet(opts: {
  compose: (o: { dropFlexible: boolean; compact: boolean }) => string;
  symbol: string;
  title: string;
  printer: string | null;
  seams?: PrintLadderSeams;
}): Promise<{ pages: number }> {
  const renderPdf = opts.seams?.renderPdf ?? renderHtmlToPdf;
  const printPdf = opts.seams?.printPdf ?? printPdfViaLp;

  const render = async (rung: { dropFlexible: boolean; compact: boolean }) => {
    const pdf = await renderPdf(opts.compose(rung));
    const pages = countPdfPages(pdf);
    if (pages === 0) throw new Error("unparseable PDF (no /Type /Page objects)");
    return { pdf, pages };
  };

  let out = await render({ dropFlexible: false, compact: false });
  if (out.pages > MAX_SHEET_PAGES) {
    out = await render({ dropFlexible: true, compact: false });
    if (out.pages > MAX_SHEET_PAGES) {
      out = await render({ dropFlexible: true, compact: true });
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "vgs-sheet-"));
  const pdfPath = join(dir, `${opts.symbol}-sheet.pdf`);
  try {
    writeFileSync(pdfPath, out.pdf);
    await printPdf(pdfPath, { printer: opts.printer, title: opts.title });
  } finally {
    // Best-effort: a cleanup throw must NOT propagate — lp has already accepted
    // the job, and re-entering a caller's fallback would mean double paper.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[print-ladder] temp-dir cleanup failed for ${dir}:`, err);
    }
  }
  return { pages: out.pages };
}
