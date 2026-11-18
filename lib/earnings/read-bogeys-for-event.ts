/**
 * Read a file or pasted text for ONE earnings print and return the figures for
 * the edit box to show (bogey intake 2026-11-18, Task B).
 *
 * WRITES NOTHING. Figures reach the database only through the existing Save
 * (`POST /api/earnings/bogeys`, source `manual`), after the owner has checked
 * them. The extractor is told the one company to read and the lines already on
 * its sheet; what comes back is narrowed to that company's issuer family, its
 * segment breakdown is turned into watch lines, and every line is aligned to
 * the sheet's existing lines so a save lands on them.
 *
 * Nothing here logs the input or the model's output.
 */
import type Database from "better-sqlite3";
import {
  extractBogeys,
  type BogeysInput,
  type ExtractedBogey,
} from "@/lib/earnings/extract-bogeys";
import {
  alignToExistingLines,
  existingWatchLinesForEvent,
  existingWatchSpecsForEvent,
  parseWatchMetrics,
  MAX_WATCH_METRICS_PER_ROW,
} from "@/lib/earnings/watch-metrics";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { todayET } from "@/lib/calendar/date-utils";
import type { ExtraMetricSpec } from "@/lib/print-watch/extra-metrics";
import type { ReadBogeysResult } from "@/lib/earnings/read-bogeys-types";

export type { ReadBogeysResult } from "@/lib/earnings/read-bogeys-types";

/** The event id names no earnings print with a symbol. */
export class ReadBogeysEventNotFoundError extends Error {
  constructor(eventId: number) {
    super(`No earnings event with id ${eventId}.`);
    this.name = "ReadBogeysEventNotFoundError";
  }
}

export interface ReadBogeysDeps {
  extract?: typeof extractBogeys;
  /** The uploaded file's name, for the suggested label. */
  sourceName?: string;
}

const EMPTY_VALUES: ReadBogeysResult["values"] = {
  eps_consensus: null,
  eps_whisper: null,
  revenue_consensus_usd: null,
  revenue_whisper_usd: null,
  expected_move_pct: null,
  guidance_notes: null,
  notes: null,
};

/**
 * Segment breakdown -> watch lines: "<segment> revenue", usd, the quarter,
 * basis n/a, with the segment's consensus and whisper. Each goes through
 * `parseWatchMetrics`, so a segment name that carries a figure, or names total
 * revenue, is dropped like any other bad line.
 */
function segmentLines(segments: ExtractedBogey["segment_breakdown"]): ExtraMetricSpec[] {
  if (!segments) return [];
  const raw = Object.entries(segments).map(([name, v]) => {
    const segment = name.replace(/\s+/g, " ").trim();
    const label = /\b(revenues?|sales)\b/i.test(segment) ? segment : `${segment} revenue`;
    return {
      label,
      definition: `${label} for the quarter as stated in the release.`,
      unit: "usd",
      period: "Q",
      basis: "na",
      consensus: v?.consensus ?? null,
      whisper: v?.whisper ?? null,
    };
  });
  // parseWatchMetrics caps each call; segments are read in batches so a long
  // breakdown is not cut at the per-extraction cap before the row cap applies.
  const out: ExtraMetricSpec[] = [];
  for (let i = 0; i < raw.length; i += 6) out.push(...parseWatchMetrics(raw.slice(i, i + 6)));
  return out;
}

function hasNumber(v: number | null | undefined): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * The label a read suggests for the hand-entered sheet. It carries the Eastern
 * time as well as the day: the manual Save overwrites the row with the same
 * label, so two reads on one day under one label silently replaced the first
 * saved sheet, and the edit box reloaded the stored row over the new read
 * (wave-2 review findings 1 and 2).
 */
function suggestedLabelFor(input: BogeysInput, sourceName: string | undefined, now: Date = new Date()): string {
  const day = todayET();
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  if (input.kind === "text") return `Pasted text ${day} ${time}`;
  const base = (sourceName ?? "").replace(/\.[A-Za-z0-9]+$/, "").replace(/\s+/g, " ").trim().slice(0, 60);
  return `${base || "File"} ${day} ${time}`;
}

export async function readBogeysForEvent(
  db: Database.Database,
  eventId: number,
  input: BogeysInput,
  deps: ReadBogeysDeps = {},
): Promise<ReadBogeysResult> {
  const event = db
    .prepare(`SELECT id, symbol FROM calendar_events WHERE id = ? AND event_type = 'earnings'`)
    .get(eventId) as { id: number; symbol: string | null } | undefined;
  const symbol = event?.symbol?.trim().toUpperCase() ?? "";
  if (!event || symbol === "") throw new ReadBogeysEventNotFoundError(eventId);

  const extract = deps.extract ?? extractBogeys;
  const existingLines = existingWatchLinesForEvent(db, eventId);
  const extraction = await extract(input, {
    onlySymbol: symbol,
    existingLinesBySymbol: existingLines.length > 0 ? { [symbol]: existingLines } : {},
  });

  const suggestedLabel = suggestedLabelFor(input, deps.sourceName);
  const where = input.kind === "text" ? "this text" : "this file";
  const family = new Set(issuerSiblings(symbol).map((s) => s.toUpperCase()));
  const candidates = extraction.bogeys.filter((b) => family.has(b.symbol.toUpperCase()));
  const entry = candidates.find((b) => b.symbol.toUpperCase() === symbol) ?? candidates[0];

  const notFound: ReadBogeysResult = {
    found: false,
    values: { ...EMPTY_VALUES },
    extraMetrics: [],
    suggestedLabel,
    modelId: extraction.modelId ?? null,
    message: `No figures for ${symbol} were found in ${where}.`,
  };
  if (!entry) return notFound;

  const lines: ExtraMetricSpec[] = [];
  const seen = new Set<string>();
  for (const spec of [...parseWatchMetrics(entry.watch_metrics), ...segmentLines(entry.segment_breakdown)]) {
    if (seen.has(spec.id) || lines.length >= MAX_WATCH_METRICS_PER_ROW) continue;
    seen.add(spec.id);
    lines.push(spec);
  }
  const extraMetrics = alignToExistingLines(lines, existingWatchSpecsForEvent(db, eventId));

  const values: ReadBogeysResult["values"] = {
    eps_consensus: hasNumber(entry.eps_consensus) ? entry.eps_consensus : null,
    eps_whisper: hasNumber(entry.eps_whisper) ? entry.eps_whisper : null,
    revenue_consensus_usd: hasNumber(entry.revenue_consensus_usd) ? entry.revenue_consensus_usd : null,
    revenue_whisper_usd: hasNumber(entry.revenue_whisper_usd) ? entry.revenue_whisper_usd : null,
    expected_move_pct: hasNumber(entry.expected_move_pct) ? entry.expected_move_pct : null,
    guidance_notes: typeof entry.guidance_notes === "string" && entry.guidance_notes.trim() ? entry.guidance_notes : null,
    notes: typeof entry.notes === "string" && entry.notes.trim() ? entry.notes : null,
  };

  const figureCount =
    [
      values.eps_consensus,
      values.eps_whisper,
      values.revenue_consensus_usd,
      values.revenue_whisper_usd,
      values.expected_move_pct,
    ].filter(hasNumber).length +
    extraMetrics.reduce((n, m) => n + (hasNumber(m.consensus) ? 1 : 0) + (hasNumber(m.whisper) ? 1 : 0), 0);

  // "Found" means a figure: an entry with only notes or topic-only lines is
  // nothing to fill, and the edit box is left as it was.
  if (figureCount === 0) return notFound;

  return {
    found: true,
    values,
    extraMetrics,
    suggestedLabel,
    modelId: extraction.modelId ?? null,
    message: `Found ${figureCount} figure${figureCount === 1 ? "" : "s"} for ${symbol} in ${where}. Check them, then Save.`,
  };
}
