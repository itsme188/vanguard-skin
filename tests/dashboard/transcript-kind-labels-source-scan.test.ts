/**
 * Sibling surfaces of the Research-wall TranscriptCard must call an 8-K row
 * what it is, exactly the way the card does.
 *
 * PR #65 fixed the card only. The security-detail transcript list printed the
 * raw `source` token ("edgar_8k") under a heading that said "Earnings
 * Transcripts", with the summary and a sentiment chip rendered for every row;
 * the notes wall counted every row as a "transcript" on the SAME wall as the
 * fixed card. All of them now go through lib/transcripts/presentation.ts.
 *
 * These are SOURCE SCANS, not render tests: this repo has no jsdom/RTL
 * harness, `TranscriptRow` is a private component inside a server page that
 * imports the DB singleton, and NotesView needs a page's worth of props.
 * The card's own render-level assertions live in
 * tests/dashboard/transcript-card-8k-labeling.test.tsx.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function read(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
}

const SECURITY_PAGE = "app/dashboard/security/[id]/page.tsx";
const NOTES_VIEW = "app/dashboard/components/NotesView.tsx";
const TRANSCRIPT_CARD = "app/dashboard/components/TranscriptCard.tsx";

describe("security detail — transcript rows are labeled by kind, never by raw source", () => {
  const src = read(SECURITY_PAGE);

  it("imports the shared presentation helpers", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bkindLabel\b[^}]*\}\s*from\s*["']@\/lib\/transcripts\/presentation["']/,
    );
    expect(src).toMatch(
      /import\s*\{[^}]*\bhasDeskNote\b[^}]*\}\s*from\s*["']@\/lib\/transcripts\/presentation["']/,
    );
  });

  it("never interpolates the raw `source` token into JSX", () => {
    expect(src).not.toMatch(/\{\s*t\.source\s*\}/);
    expect(src).not.toMatch(/\{\s*transcript\.source\s*\}/);
    expect(src).toContain("{kindLabel(t)}");
  });

  it("the section heading no longer calls every cached row a transcript", () => {
    expect(src).toContain("Earnings Transcripts & Filings");
  });

  it("gates the summary and the sentiment chip on a real desk note for filings", () => {
    // One computed flag drives both, so they can never drift apart.
    expect(src).toMatch(/const\s+showAnalysis\s*=\s*!isFilingRow\(t\)\s*\|\|\s*hasDeskNote\(t\)/);
    expect(src).toMatch(/showAnalysis\s*&&\s*t\.sentiment_label/);
    expect(src).toMatch(/showAnalysis\s*&&\s*t\.summary/);
  });

  it("says the same honest thing the card says for a cover-page-only filing", () => {
    const cardCopy = "no call transcript is cached for this quarter";
    expect(read(TRANSCRIPT_CARD)).toContain(cardCopy);
    expect(src).toContain(cardCopy);
  });
});

describe("notes wall — group headers count filings separately from transcripts", () => {
  const src = read(NOTES_VIEW);

  it("imports the shared count label", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\btranscriptCountLabel\b[^}]*\}\s*from\s*["']@\/lib\/transcripts\/presentation["']/,
    );
  });

  it("no longer hard-codes a 'N transcript(s)' count over a mixed group", () => {
    expect(src).not.toMatch(/transcript\$\{[^}]*length\s*!==\s*1/);
    expect(src).not.toMatch(/transcript\{[^}]*length\s*!==\s*1/);
    // Both group headers (notes+transcripts, transcripts-only) use the helper.
    expect(src.match(/transcriptCountLabel\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
