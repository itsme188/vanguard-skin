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
  call_date: string | null;
  security_id: number | null;
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
  // call_date / security_id coalescing across sibling rows (the AV upgrade
  // lacks both; the 8-K row — often fetched days earlier, OUTSIDE the digest
  // window — carries them) happens in the SELECT's correlated subqueries, so
  // rows arrive here already metadata-complete.
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

// Fallback cap for extractive (non-desk-note) summaries; slicing to a char
// cap with a word-boundary cut (never mid-word) is good enough — the full
// transcript lives in-app.
const SUMMARY_RENDER_CHAR_CAP = 600;

// Compact desk-note mode (user decision 2026-07-20): the email shows the
// Guidance section + a one-line Tone digest, and points into the app for the
// rest. Reactions/commentary carry the morning email; the transcript block is
// a notice with the two takeaways that age well.
const GUIDANCE_SECTION_CHAR_CAP = 900;
const TONE_LINE_CHAR_CAP = 220;

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

/** "2026-07-16" → "Thu 7/16". Date-only math pinned to UTC noon so the
 *  weekday never shifts with the composing machine's timezone. */
function formatCallDate(isoDate: string): string | null {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: "UTC",
  }).format(d);
  return `${weekday} ${Number(m[2])}/${Number(m[3])}`;
}

/** Pull one `**Label**` section's body out of a (heading-demoted) desk note.
 *  A section runs from its label line to the next lone bold-label line. */
function extractDeskNoteSection(demotedSummary: string, label: string): string | null {
  const lines = demotedSummary.split("\n");
  const isLabelLine = (l: string) => /^\*\*[^*]+\*\*:?\s*$/.test(l.trim());
  const wanted = label.toLowerCase();
  const start = lines.findIndex((l) => {
    const t = l.trim().toLowerCase();
    return t === `**${wanted}**` || t === `**${wanted}**:`;
  });
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (isLabelLine(lines[i])) break;
    body.push(lines[i]);
  }
  const text = body.join("\n").trim();
  return text.length > 0 ? text : null;
}

function renderTranscriptSection(row: RecentTranscriptRow, linkBase: string | null): string {
  const date = row.call_date ? formatCallDate(row.call_date) : null;
  const header = `### ${row.ticker} — Q${row.quarter} ${row.year} call${date ? ` (${date})` : ""}`;
  const lines = [header, ""];

  // Demote BEFORE section extraction/truncation so heading-styled desk notes
  // (## Guidance) and bold-labeled ones look identical to the parser, and the
  // bold-marker balancing in truncateAtWordBoundary sees the final marker set.
  const summary = row.summary ? demoteEmbeddedHeadings(row.summary).trim() : undefined;
  const guidanceSection = summary ? extractDeskNoteSection(summary, "guidance") : null;

  if (summary && guidanceSection) {
    // Compact desk-note mode.
    lines.push(`**Guidance**\n${truncateAtWordBoundary(guidanceSection, GUIDANCE_SECTION_CHAR_CAP)}`);
    const tone = extractDeskNoteSection(summary, "tone");
    if (tone) {
      lines.push("", `Tone: ${truncateAtWordBoundary(tone.replace(/\s+/g, " "), TONE_LINE_CHAR_CAP)}`);
    }
  } else if (summary) {
    lines.push(truncateAtWordBoundary(summary, SUMMARY_RENDER_CHAR_CAP));
  }
  // The raw `guidance` column is deliberately NOT rendered: extractGuidance
  // keyword-matches transcript paragraphs and on real calls captures the
  // safe-harbor boilerplate + opening Q&A (7/20 NFLX digest). The desk
  // note's own Guidance section is the only guidance surface.

  const label = guidanceSection ? "Full transcript + desk note" : "Full transcript";
  if (summary) lines.push("");
  if (linkBase && row.security_id) {
    const base = linkBase.replace(/\/+$/, "");
    lines.push(`${label} → [${row.ticker} in Portfolio Desk](${base}/dashboard/security/${row.security_id})`);
  } else {
    lines.push(`${label} in Portfolio Desk`);
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
  opts: { now?: Date; linkBase?: string | null } = {},
): string | null {
  try {
    const now = opts.now ?? new Date();
    // Same deep-link base the Pushover notifications use (Mesh-reachable from
    // the phone). Absent → plain-text pointer, never a dead localhost link.
    const linkBase =
      opts.linkBase !== undefined ? opts.linkBase : (process.env.PUSHOVER_LINK_BASE ?? null);
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    const rows = dedupeBestSource(
      db
        .prepare(
          `SELECT et.ticker, et.year, et.quarter, et.source, et.summary, et.guidance,
                  COALESCE(et.call_date,
                           (SELECT t2.call_date FROM earnings_transcripts t2
                             WHERE t2.ticker = et.ticker AND t2.year = et.year
                               AND t2.quarter = et.quarter AND t2.call_date IS NOT NULL
                             ORDER BY datetime(t2.fetched_at) DESC LIMIT 1)) AS call_date,
                  COALESCE(et.security_id,
                           (SELECT t3.security_id FROM earnings_transcripts t3
                             WHERE t3.ticker = et.ticker AND t3.year = et.year
                               AND t3.quarter = et.quarter AND t3.security_id IS NOT NULL
                             ORDER BY datetime(t3.fetched_at) DESC LIMIT 1)) AS security_id,
                  et.fetched_at
             FROM earnings_transcripts et
            WHERE datetime(et.fetched_at) >= datetime(?)
            ORDER BY datetime(et.fetched_at) DESC`,
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

    const sections = covered.map((row) => renderTranscriptSection(row, linkBase)).join("\n\n");
    return ["## Call transcripts", "", sections].join("\n");
  } catch (err) {
    console.warn(
      "[digest] call-transcripts block failed (omitted):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
