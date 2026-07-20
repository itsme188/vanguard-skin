/**
 * Overnight block for the MORNING digest — deterministic Asia/BTC scoreboard
 * plus an optional 1-2 sentence commentary extracted from Vital Knowledge's
 * Dawn edition. Spec: docs/superpowers/specs/2026-07-15-overnight-digest-block-design.md
 *
 * Everything degrades, nothing blocks: a failed symbol drops its line, a
 * market on holiday renders "closed", a missing Dawn or a Claude failure
 * yields numbers-only, and total failure omits the block. The digest itself
 * must never fail because of this section.
 */

import type Database from "better-sqlite3";
import {
  fetchYahooDailyCloses,
  fetchYahooRolling24hPct,
  type DailyClose,
} from "@/lib/quotes/yahoo-daily";
import { todayET, addDays, calendarDaysBetween } from "@/lib/calendar/date-utils";
import { classifyEdition } from "./editions";
import { generateTextForFeature } from "@/lib/ai/generate";

export interface OvernightInstrument {
  symbol: string;
  label: string;
  /**
   * "rolling24h" for 24/7 assets: latest hourly price vs ~24h earlier. The
   * default daily-close pair measures only the partial UTC day at digest
   * time for an always-open market (7/20: chip −0.1% vs VK's "dipped 75bp").
   * The Worker mirror (workers/cron/src/overnight.ts) deliberately KEEPS the
   * daily pair for BTC — its one-spark-request design sits at 49/50 of the
   * free-tier subrequest cap, and the cloud block only runs when the Mac is
   * asleep.
   */
  window?: "rolling24h";
}

/** Fixed display order per user spec: Korea → bitcoin → Japan → China. */
export const OVERNIGHT_INSTRUMENTS: OvernightInstrument[] = [
  { symbol: "^KS11", label: "KOSPI" },
  { symbol: "BTC-USD", label: "Bitcoin", window: "rolling24h" },
  { symbol: "^N225", label: "Nikkei" },
  { symbol: "^HSI", label: "Hang Seng" },
];

export type OvernightMove =
  | { label: string; pct: number; closed?: undefined }
  | { label: string; closed: true };

/** A latest close older than this (calendar days vs today ET) means the
 *  market didn't trade overnight — their holiday. 3 tolerates a weekend +
 *  Monday-morning composition; matches the levels stale-price posture. */
const HOLIDAY_STALE_DAYS = 3;

/** Trailing fetch window — wide enough to always contain 2 closes across
 *  Golden Week-length holidays without ever being confused for freshness
 *  (freshness is judged by the latest close's date, not the window). */
const FETCH_WINDOW_DAYS = 10;

export async function fetchOvernightMoves(
  opts: {
    fetcher?: typeof fetchYahooDailyCloses;
    /** Rolling-24h fetcher for `window: "rolling24h"` instruments. */
    fetch24h?: (symbol: string) => Promise<number | null>;
    /** YYYY-MM-DD (ET). Injectable for tests. */
    today?: string;
  } = {},
): Promise<OvernightMove[]> {
  const fetcher = opts.fetcher ?? fetchYahooDailyCloses;
  const fetch24h = opts.fetch24h ?? ((symbol: string) => fetchYahooRolling24hPct(symbol));
  const today = opts.today ?? todayET();
  const from = addDays(today, -FETCH_WINDOW_DAYS);

  const results = await Promise.all(
    OVERNIGHT_INSTRUMENTS.map(async (inst): Promise<OvernightMove | null> => {
      if (inst.window === "rolling24h") {
        const pct = await fetch24h(inst.symbol);
        if (pct === null || !Number.isFinite(pct)) return null; // drop the line
        return { label: inst.label, pct };
      }
      const closes: DailyClose[] = await fetcher(inst.symbol, from, today);
      if (closes.length < 2) return null; // fetch failure / not enough history → drop the line
      const last = closes[closes.length - 1];
      const prior = closes[closes.length - 2];
      if (calendarDaysBetween(last.date, today) > HOLIDAY_STALE_DAYS) {
        return { label: inst.label, closed: true };
      }
      if (!Number.isFinite(prior.close) || prior.close === 0) return null;
      return { label: inst.label, pct: (last.close / prior.close - 1) * 100 };
    }),
  );

  return results.filter((m): m is OvernightMove => m !== null);
}

/** +0.8% / −2.1% — real minus sign (U+2212) for email typography. */
function fmtPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "−";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/**
 * Pure renderer. Null when there are no moves at all — commentary alone is
 * not a scoreboard, and VK's Dawn content still reaches the reader through
 * the synthesis stream.
 */
export function renderOvernightBlock(
  moves: OvernightMove[],
  commentary: string | null,
): string | null {
  if (moves.length === 0) return null;

  const scoreboard = moves
    .map((m) => (m.closed ? `${m.label} closed` : `${m.label} ${fmtPct(m.pct)}`))
    .join(" · ");

  const lines = ["## Overnight", "", scoreboard];
  if (commentary) {
    lines.push("");
    // Attribution rendered here in code — never trusted to the model.
    lines.push(`> ${commentary} — Vital Knowledge`);
  }
  return lines.join("\n");
}

// ── VK Dawn commentary extract ───────────────────────────────────────────────

const PROMPT_CHAR_CAP = 12_000;

interface DawnArticleRow {
  id: number;
  subject: string;
  raw_text: string | null;
  received_at: string;
}

/** received_at is stored as ISO (Gmail fetch) but tolerate the space-separated
 *  SQLite form too; render to the ET calendar date for same-day matching. */
function etDateOf(receivedAt: string): string | null {
  const iso = receivedAt.includes("T") ? receivedAt : receivedAt.replace(" ", "T") + "Z";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
    new Date(ms),
  );
}

function getTodaysDawnArticle(
  db: Database.Database,
  today: string,
): DawnArticleRow | null {
  // 2-day SQL pre-filter (UTC-safe), exact same-ET-day + edition match in JS —
  // yesterday's Dawn presented as "overnight" would be worse than nothing.
  const rows = db
    .prepare(
      `SELECT a.id, a.subject, a.raw_text, a.received_at
         FROM research_articles a
         JOIN research_sources s ON s.id = a.source_id
        WHERE s.name = 'Vital Knowledge'
          AND datetime(a.received_at) >= datetime('now', '-2 days')
        ORDER BY datetime(a.received_at) DESC`,
    )
    .all() as DawnArticleRow[];

  for (const row of rows) {
    if (classifyEdition("Vital Knowledge", row.subject).edition !== "dawn") continue;
    if (etDateOf(row.received_at) !== today) continue;
    if (!row.raw_text || row.raw_text.trim().length === 0) continue;
    return row;
  }
  return null;
}

type GenerateFn = (
  feature: "overnightCommentary",
  opts: { prompt: string; maxOutputTokens: number },
) => Promise<{ text: string }>;

/**
 * 1-2 sentences about the overnight session, extracted from today's VK Dawn.
 * Null (numbers-only block) whenever Dawn is missing, empty, or the model
 * call fails — never throws.
 */
export async function extractOvernightCommentary(
  db: Database.Database,
  opts: { generate?: GenerateFn; today?: string } = {},
): Promise<string | null> {
  const today = opts.today ?? todayET();
  const article = getTodaysDawnArticle(db, today);
  if (!article) return null;

  const generate = opts.generate ?? (generateTextForFeature as unknown as GenerateFn);
  const text = article.raw_text!.slice(0, PROMPT_CHAR_CAP);

  try {
    const res = await generate("overnightCommentary", {
      prompt: `Below is this morning's Vital Knowledge "Dawn" market note.

Extract what it says about the OVERNIGHT session only: Asia equities (Korea/Japan/Hong Kong/China), crypto, and US futures. At most 2 sentences, plain text, no preamble, no markdown, no attribution. If the note says nothing about the overnight session, reply with exactly NONE.

Note text:
${text}`,
      maxOutputTokens: 300,
    });
    const out = res.text.trim();
    if (!out || out === "NONE") return null;
    return out;
  } catch (err) {
    console.warn(
      "[digest] overnight commentary extract failed (numbers-only):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Orchestrator used by generateDigestSinceAdaptive (morning edition only).
 * Fetches moves + commentary in parallel; never throws.
 */
export async function composeOvernightBlock(
  db: Database.Database,
  deps: {
    fetchMoves?: () => Promise<OvernightMove[]>;
    extract?: () => Promise<string | null>;
  } = {},
): Promise<string | null> {
  try {
    const [moves, commentary] = await Promise.all([
      (deps.fetchMoves ?? fetchOvernightMoves)(),
      (deps.extract ?? (() => extractOvernightCommentary(db)))(),
    ]);
    return renderOvernightBlock(moves, commentary);
  } catch (err) {
    console.warn(
      "[digest] overnight block failed (omitted):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
