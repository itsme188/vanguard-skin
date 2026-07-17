/**
 * Morning-digest "Call transcripts" block (#12 B3).
 *
 * Surfaces earnings-call transcripts fetched in the last 24h (via
 * fetchSameDayTranscripts, #12 B1/B2 — lib/transcripts/same-day.ts) for held
 * or watchlist tickers, so the user sees today's desk-note summary without
 * opening chat. Sibling of the Overnight block (lib/digest/overnight.ts):
 * deterministic, `null` self-quiet, never blocks the digest.
 */

import type Database from "better-sqlite3";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";

interface RecentTranscriptRow {
  ticker: string;
  year: number;
  quarter: number;
  summary: string | null;
  guidance: string | null;
  fetched_at: string;
}

// ~4 rendered lines at typical email-line width; slicing to a char cap with
// a word-boundary cut (never mid-word) is good enough — this is a teaser,
// the full transcript/summary lives in-app.
const SUMMARY_RENDER_CHAR_CAP = 600;

function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  // Only back off to the last space if it doesn't throw away most of the
  // slice (a summary with no spaces near the cap just hard-cuts).
  const cut = (lastSpace > maxChars * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd();
  // Markdown-span safety: the AI summary uses **bold** labels, and
  // briefingToHtml's inline regex needs the closing marker on the same
  // line — a cut inside an open span would render a literal "**" in the
  // email. An odd number of "**" markers means one is dangling: close it.
  const boldMarkers = (cut.match(/\*\*/g) ?? []).length;
  return `${cut}${boldMarkers % 2 === 1 ? "**" : ""}…`;
}

function renderTranscriptSection(row: RecentTranscriptRow): string {
  const lines = [`### ${row.ticker} — Q${row.quarter} ${row.year} call`, ""];

  const summary = row.summary?.trim();
  if (summary) {
    lines.push(truncateAtWordBoundary(summary, SUMMARY_RENDER_CHAR_CAP));
  }

  const guidance = row.guidance?.trim();
  if (guidance) {
    if (summary) lines.push("");
    lines.push(`Guidance: ${guidance}`);
  }

  return lines.join("\n");
}

/**
 * Pure composer, sync (no AI/network calls of its own — it only reads what
 * fetchSameDayTranscripts + summarizeTranscript already cached). Never
 * throws: any DB error is caught, warned, and treated as "nothing to show".
 */
export function composeCallTranscriptsBlock(
  db: Database.Database,
  opts: { now?: Date } = {},
): string | null {
  try {
    const now = opts.now ?? new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    const rows = db
      .prepare(
        `SELECT ticker, year, quarter, summary, guidance, fetched_at
           FROM earnings_transcripts
          WHERE datetime(fetched_at) >= datetime(?)
          ORDER BY datetime(fetched_at) DESC`,
      )
      .all(cutoff) as RecentTranscriptRow[];

    if (rows.length === 0) return null;

    const symbols = Array.from(new Set(rows.map((r) => r.ticker.toUpperCase())));
    const status = getSymbolStatus(db, symbols);
    const covered = rows.filter((r) => {
      const st = status[r.ticker.toUpperCase()];
      return st === "held" || st === "watchlist";
    });

    if (covered.length === 0) return null;

    const sections = covered.map(renderTranscriptSection).join("\n\n");
    return ["## Call transcripts", "", sections].join("\n");
  } catch (err) {
    console.warn(
      "[digest] call-transcripts block failed (omitted):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
