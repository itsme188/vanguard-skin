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
  source: string;
  summary: string | null;
  guidance: string | null;
  fetched_at: string;
}

// Same source-preference order as getCachedTranscript (lib/queries/transcripts)
// — the upgrade path (thin-8-K fix in lib/transcripts/same-day.ts) can land an
// edgar_8k row and its alpha_vantage upgrade inside the same 24h digest
// window; the reader must collapse them to the best one, not render the same
// call twice.
const SOURCE_RANK: Record<string, number> = {
  api_ninjas: 1,
  alpha_vantage: 2,
  motley_fool: 3,
  edgar_8k: 4,
};

function dedupeBestSource(rows: RecentTranscriptRow[]): RecentTranscriptRow[] {
  const best = new Map<string, RecentTranscriptRow>();
  for (const row of rows) {
    const key = `${row.ticker.toUpperCase()}:${row.year}:${row.quarter}`;
    const cur = best.get(key);
    // Rows arrive fetched_at DESC, so on equal rank the newer row wins by
    // being seen first.
    if (!cur || (SOURCE_RANK[row.source] ?? 9) < (SOURCE_RANK[cur.source] ?? 9)) {
      best.set(key, row);
    }
  }
  return rows.filter((row) => best.get(`${row.ticker.toUpperCase()}:${row.year}:${row.quarter}`) === row);
}

/**
 * The AI desk note sometimes uses its own markdown headings (an H1 title +
 * H2 section headers) despite the prompt asking for bold labels — rendered
 * verbatim they compete with the digest's own `##`/`###` structure. Demote
 * at RENDER time (cached rows keep their original text): a LEADING title
 * heading is dropped outright (it duplicates this block's own
 * "### TICKER — Qn YYYY call" header); any other heading line becomes a
 * `**bold**` line.
 */
function demoteEmbeddedHeadings(summary: string): string {
  const lines = summary.split("\n");
  const out: string[] = [];
  let seenContent = false;
  let droppedTitle = false;
  for (const line of lines) {
    const m = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (m) {
      // Only the very FIRST heading, before any body content, is a title —
      // a second heading before content (e.g. "## Guidance" right after the
      // title) is a section header and must be demoted, not dropped.
      if (!seenContent && !droppedTitle) {
        droppedTitle = true;
        continue;
      }
      out.push(`**${m[1]}**`);
      seenContent = true;
      continue;
    }
    if (line.trim().length > 0) seenContent = true;
    out.push(line);
  }
  // Trim any blank lines left behind by a dropped leading title.
  while (out.length > 0 && out[0].trim() === "") out.shift();
  return out.join("\n");
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

  // Demote BEFORE truncation so the bold-marker balancing in
  // truncateAtWordBoundary sees the final marker set.
  const summary = row.summary ? demoteEmbeddedHeadings(row.summary).trim() : undefined;
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

    const rows = dedupeBestSource(
      db
        .prepare(
          `SELECT ticker, year, quarter, source, summary, guidance, fetched_at
             FROM earnings_transcripts
            WHERE datetime(fetched_at) >= datetime(?)
            ORDER BY datetime(fetched_at) DESC`,
        )
        .all(cutoff) as RecentTranscriptRow[],
    );

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
