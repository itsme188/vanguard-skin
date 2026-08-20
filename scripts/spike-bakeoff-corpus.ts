/**
 * SPIKE for the print-watch design (2026-08-20).
 * Measurement/acquisition tool, NOT product code. Throwaway quality is
 * acceptable — but it must work, because real earnings prints only happen
 * once.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS BUILDS
 * ---------------------------------------------------------------------------
 * The PILOT CORPUS for the extraction bake-off described in §2 (statistical
 * gate) and §6 (spike program) of
 * docs/superpowers/specs/2026-08-20-live-print-watch-design.md.
 *
 * For each of a fixed list of past earnings prints, acquires BOTH sources
 * (where available):
 *   (a) the stitched DJ verbatim press release — via TWS reqHistoricalNews /
 *       reqNewsArticle, REUSING scripts/spike-print-tws-news.ts (clientId 9,
 *       the backward-walking reqHistoricalNews quirk, the "{A:...:L:en}"
 *       headline-prefix strip, press-release part-grouping by prefix
 *       containment, part fetching + stitching — all unchanged from there).
 *   (b) the EDGAR 8-K EX-99.* exhibit(s) — CIK resolved from SEC's
 *       company_tickers.json, filing resolved via the submissions API,
 *       exhibits downloaded from the filing index.
 * Also captures DJ flash bullets in the same window (cross-check evidence
 * for gold labeling later).
 *
 * ACQUISITION ONLY. No parsing, no labeling, no gold answers. A failure on
 * one source or one event is DATA, not a fatal error — it is recorded in
 * that event's meta.json and the run continues.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT (gitignored — tests/fixtures/real/ — verified before this script
 * was written: `git check-ignore -v` matches .gitignore line 49)
 * ---------------------------------------------------------------------------
 *   tests/fixtures/real/bakeoff/{SYMBOL}-{DATE}/
 *     dj-release.txt        stitched DJ press release #1 (header + body)
 *     dj-release-2.txt, …   additional distinct DJ release groups, if any
 *     dj-parts.json         part ids/headlines/lengths for every DJ release
 *     dj-flashes.json       DJ flash bullets seen in the acquisition window
 *     edgar-ex99-1.htm, …   every EX-99.* exhibit on the resolved 8-K
 *     meta.json             symbol, dates, conId, CIK, accession,
 *                            acceptanceDateTime, sha256 of every artifact,
 *                            part counts, per-source success/failure
 *   tests/fixtures/real/bakeoff/manifest.json
 *     one row per event: per-source success/failure + counts
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH \
 *     npx tsx scripts/spike-bakeoff-corpus.ts [--only HD,CRWD]
 *
 * PREREQUISITES
 *   TWS running, API-enabled. Opens its own socket on clientId 9 — never
 *   0 (TWS GUI), 1 (Vanguard Skin), or 2 (Stock Contest).
 */

import { createHash } from "node:crypto";
import { extname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IBApi } from "@stoqey/ib";

import {
  connectNewsApi,
  DJ_PROVIDER_CODES,
  formatTwsDateTime,
  groupReleaseParts,
  isFlash,
  parseTwsDateTime,
  reqHistoricalNewsOnce,
  stitchRelease,
  stripHeadlineMeta,
  type NewsHeadline,
} from "./spike-print-tws-news";

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

interface Target {
  symbol: string;
  /** Event date, YYYY-MM-DD (ET calendar date of the print). */
  eventDate: string;
  /** Observed/approx print time, ET wall clock "HH:MM". */
  printET: string;
  /** IBKR contract id (verified live against DJ headlines by the caller). */
  conId: number;
  /** Free-text note carried into meta.json — documents expected quirks. */
  note?: string;
}

const TARGETS: Target[] = [
  { symbol: "HD", eventDate: "2026-08-18", printET: "06:00", conId: 7930 },
  { symbol: "CRWD", eventDate: "2026-06-03", printET: "16:05", conId: 370757467 },
  {
    symbol: "NVDA",
    eventDate: "2026-05-20",
    printET: "16:20",
    conId: 4815747,
    note: "DJ verbatim PR does NOT exist for NVDA — expect flashes only. EDGAR is the full-text source.",
  },
  { symbol: "XMTR", eventDate: "2026-08-04", printET: "07:05", conId: 499640675 },
  { symbol: "NET", eventDate: "2026-08-06", printET: "16:05", conId: 382633646 },
  { symbol: "AKAM", eventDate: "2026-08-06", printET: "16:01", conId: 6220356 },
  { symbol: "U", eventDate: "2026-08-06", printET: "07:00", conId: 445423543 },
  { symbol: "AMZN", eventDate: "2026-07-30", printET: "16:01", conId: 3691937 },
  { symbol: "AAPL", eventDate: "2026-07-30", printET: "16:30", conId: 265598 },
  { symbol: "APP", eventDate: "2026-08-05", printET: "16:05", conId: 481863646 },
  { symbol: "MELI", eventDate: "2026-08-05", printET: "16:15", conId: 45602025 },
  { symbol: "DIS", eventDate: "2026-08-05", printET: "07:02", conId: 6459 },
  { symbol: "RBRK", eventDate: "2026-06-04", printET: "16:05", conId: 699030013 },
  { symbol: "OSCR", eventDate: "2026-08-06", printET: "06:37", conId: 474517727 },
  {
    symbol: "OCUL",
    eventDate: "2026-08-03",
    printET: "16:15",
    conId: 162104102,
    note: "Negative control: reported EPS but NO revenue — fetch whatever exists.",
  },
];

const SEC_UA = "PortfolioDesk contact@myportfoliodesk.com";
const OUT_ROOT = join(process.cwd(), "tests", "fixtures", "real", "bakeoff");
/** SEC asks for a minimum spacing between requests; keep well inside it. */
const SEC_MIN_GAP_MS = 300;

// ---------------------------------------------------------------------------
// Small helpers (duplicated from spike-print-timestamp-harness.ts —
// deliberately not exported there; this is a throwaway spike script too)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function etOffsetMinutes(d: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value])) as Record<
    string,
    string
  >;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return (asUtc - d.getTime()) / 60_000;
}

/** Resolve an ET wall clock ("2026-08-18", "06:00") to a real UTC instant. */
function etToUtc(dateISO: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const naive = Date.UTC(
    Number(dateISO.slice(0, 4)),
    Number(dateISO.slice(5, 7)) - 1,
    Number(dateISO.slice(8, 10)),
    h,
    m,
    0,
  );
  let d = new Date(naive);
  for (let i = 0; i < 2; i += 1) d = new Date(naive - etOffsetMinutes(d) * 60_000);
  return d;
}

function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(
    Date.UTC(
      Number(dateISO.slice(0, 4)),
      Number(dateISO.slice(5, 7)) - 1,
      Number(dateISO.slice(8, 10)),
    ),
  );
  d.setUTCDate(d.getUTCDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function saveTextFile(path: string, content: string): string {
  writeFileSync(path, content, "utf8");
  return sha256(content);
}

function saveBytesFile(path: string, content: Buffer): string {
  writeFileSync(path, content);
  return sha256(content);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// SEC EDGAR — paced fetch (>=250ms apart, per instructions)
// ---------------------------------------------------------------------------

let lastSecCallAt = 0;
async function secFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const wait = SEC_MIN_GAP_MS - (Date.now() - lastSecCallAt);
  if (wait > 0) await sleep(wait);
  const res = await fetchWithTimeout(url, {
    ...init,
    headers: { "User-Agent": SEC_UA, "Cache-Control": "no-cache", ...(init.headers ?? {}) },
    timeoutMs: 30_000,
  });
  lastSecCallAt = Date.now();
  return res;
}

async function loadTickerMap(): Promise<Map<string, string>> {
  const res = await secFetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`company_tickers.json HTTP ${res.status}`);
  const data = (await res.json()) as Record<
    string,
    { cik_str: number; ticker: string; title: string }
  >;
  const map = new Map<string, string>();
  for (const entry of Object.values(data)) {
    map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
  }
  return map;
}

interface EdgarFiling {
  accession: string;
  form: string;
  filingDate: string;
  acceptanceDateTime: string;
  primaryDocument: string;
}

async function fetchEdgarFilings(cik: string): Promise<EdgarFiling[]> {
  const res = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`EDGAR submissions HTTP ${res.status}`);
  const json = (await res.json()) as { filings: { recent: Record<string, unknown[]> } };
  const r = json.filings.recent;
  const out: EdgarFiling[] = [];
  const n = (r.accessionNumber as string[]).length;
  for (let i = 0; i < n; i += 1) {
    out.push({
      accession: (r.accessionNumber as string[])[i],
      form: (r.form as string[])[i],
      filingDate: (r.filingDate as string[])[i],
      acceptanceDateTime: (r.acceptanceDateTime as string[])[i],
      primaryDocument: (r.primaryDocument as string[])[i],
    });
  }
  return out;
}

/**
 * Walk a filing's SGML header for its EX-99.* exhibits. The header
 * ({accession}-index-headers.html) carries <TYPE>/<FILENAME> pairs;
 * index.json does not expose exhibit types.
 */
async function fetchExhibits(
  cik: string,
  accession: string,
): Promise<{ type: string; filename: string; url: string }[]> {
  const cikNum = String(Number(cik));
  const accNoDash = accession.replace(/-/g, "");
  const base = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}`;
  const res = await secFetch(`${base}/${accession}-index-headers.html`);
  if (!res.ok) throw new Error(`EDGAR index-headers HTTP ${res.status}`);
  const html = await res.text();

  const out: { type: string; filename: string; url: string }[] = [];
  const re = /&lt;TYPE&gt;([^\s<]+)[\s\S]*?&lt;FILENAME&gt;([^\s<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [, type, filename] = m;
    if (/^EX-99/i.test(type)) out.push({ type, filename, url: `${base}/${filename}` });
  }
  return out;
}

interface EdgarExhibitResult {
  type: string;
  filename: string;
  url: string;
  savedAs: string;
  bytes: number;
  sha256: string;
}

interface EdgarResult {
  success: boolean;
  source: "ok" | "8k-no-ex99" | "no-8k-found" | "cik-not-found" | "edgar-error";
  error: string | null;
  cik: string | null;
  accession: string | null;
  form: string | null;
  filingDate: string | null;
  acceptanceDateTime: string | null;
  usedNextDayFallback: boolean;
  exhibits: EdgarExhibitResult[];
}

/**
 * Resolve the 8-K for a print (accepted on the print date, or the next day
 * for AMC prints — literal instruction), then download every EX-99.*
 * exhibit. Multiple 8-Ks can land the same day (e.g. an 8.01 unrelated to
 * earnings); we walk candidates in acceptance order and take the first one
 * that actually carries an EX-99.* exhibit.
 */
async function acquireEdgar(
  cik: string,
  eventDir: string,
  target: Target,
): Promise<EdgarResult> {
  let filings: EdgarFiling[];
  try {
    filings = await fetchEdgarFilings(cik);
  } catch (err) {
    return {
      success: false,
      source: "edgar-error",
      error: (err as Error).message,
      cik,
      accession: null,
      form: null,
      filingDate: null,
      acceptanceDateTime: null,
      usedNextDayFallback: false,
      exhibits: [],
    };
  }

  const hour = Number(target.printET.split(":")[0]);
  const amc = hour >= 12;
  const nextDay = addDaysISO(target.eventDate, 1);
  const primaryDates = amc ? [target.eventDate, nextDay] : [target.eventDate];

  let candidates = filings
    .filter((f) => /^8-K/i.test(f.form) && primaryDates.includes(f.filingDate))
    .sort((a, b) => a.acceptanceDateTime.localeCompare(b.acceptanceDateTime));
  let usedFallback = false;

  if (candidates.length === 0 && !amc) {
    // BMO print with no same-day 8-K — check the next day (late filer).
    candidates = filings
      .filter((f) => /^8-K/i.test(f.form) && f.filingDate === nextDay)
      .sort((a, b) => a.acceptanceDateTime.localeCompare(b.acceptanceDateTime));
    usedFallback = candidates.length > 0;
  }

  if (candidates.length === 0) {
    return {
      success: false,
      source: "no-8k-found",
      error: `no 8-K filed on ${primaryDates.join(" or ")}`,
      cik,
      accession: null,
      form: null,
      filingDate: null,
      acceptanceDateTime: null,
      usedNextDayFallback: false,
      exhibits: [],
    };
  }

  let chosen: EdgarFiling | null = null;
  let chosenExhibits: { type: string; filename: string; url: string }[] = [];
  for (const f of candidates) {
    let exhibits: { type: string; filename: string; url: string }[];
    try {
      exhibits = await fetchExhibits(cik, f.accession);
    } catch {
      continue;
    }
    if (exhibits.some((e) => /^EX-99/i.test(e.type))) {
      chosen = f;
      chosenExhibits = exhibits;
      break;
    }
    if (!chosen) chosen = f; // fallback: first 8-K seen, even with no EX-99
  }
  if (!chosen) chosen = candidates[0];

  if (chosenExhibits.length === 0) {
    return {
      success: false,
      source: "8k-no-ex99",
      error: null,
      cik,
      accession: chosen.accession,
      form: chosen.form,
      filingDate: chosen.filingDate,
      acceptanceDateTime: chosen.acceptanceDateTime,
      usedNextDayFallback: usedFallback,
      exhibits: [],
    };
  }

  const usedNumbers = new Set<number>();
  const results: EdgarExhibitResult[] = [];
  let fallbackIdx = 0;
  for (const ex of chosenExhibits) {
    let buf: Buffer;
    try {
      const res = await secFetch(ex.url);
      if (!res.ok) throw new Error(`exhibit HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      results.push({
        type: ex.type,
        filename: ex.filename,
        url: ex.url,
        savedAs: `(download failed: ${(err as Error).message})`,
        bytes: 0,
        sha256: "",
      });
      continue;
    }

    const m = /EX-99\.?(\d+)/i.exec(ex.type);
    let n = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(n) || usedNumbers.has(n)) {
      fallbackIdx += 1;
      n = fallbackIdx;
      while (usedNumbers.has(n)) n += 1;
    }
    usedNumbers.add(n);
    const ext = extname(ex.filename) || ".htm";
    const savedName = `edgar-ex99-${n}${ext}`;
    const sha = saveBytesFile(join(eventDir, savedName), buf);
    results.push({
      type: ex.type,
      filename: ex.filename,
      url: ex.url,
      savedAs: savedName,
      bytes: buf.length,
      sha256: sha,
    });
  }

  return {
    success: results.some((r) => r.bytes > 0),
    source: "ok",
    error: null,
    cik,
    accession: chosen.accession,
    form: chosen.form,
    filingDate: chosen.filingDate,
    acceptanceDateTime: chosen.acceptanceDateTime,
    usedNextDayFallback: usedFallback,
    exhibits: results,
  };
}

// ---------------------------------------------------------------------------
// DJ (TWS) acquisition
// ---------------------------------------------------------------------------

interface DjReleaseResult {
  index: number;
  baseHeadline: string;
  provider: string;
  djTime: string;
  djTimeIso: string | null;
  partsTotal: number;
  partsFetched: number;
  parts: { n: number; articleId: string; headline: string }[];
  failures: string[];
  chars: number;
  savedAs: string;
  sha256: string;
}

interface DjFlash {
  time: string;
  timeIso: string | null;
  articleId: string;
  provider: string;
  headline: string;
}

interface DjResult {
  success: boolean;
  source: "ok" | "no-verbatim-pr" | "dj-history-exhausted" | "tws-error";
  error: string | null;
  rawHeadlineCount: number;
  inWindowCount: number;
  releases: DjReleaseResult[];
  flashes: DjFlash[];
}

async function acquireDj(api: IBApi, eventDir: string, target: Target): Promise<DjResult> {
  const printUtc = etToUtc(target.eventDate, target.printET);
  const recentBoundary = new Date(printUtc.getTime() + 3 * 60 * 60_000);
  const olderBoundary = new Date(printUtc.getTime() - 30 * 60_000);

  let heads: NewsHeadline[];
  try {
    heads = await reqHistoricalNewsOnce(api, {
      conId: target.conId,
      providerCodes: DJ_PROVIDER_CODES,
      startDateTime: formatTwsDateTime(recentBoundary),
      endDateTime: formatTwsDateTime(olderBoundary),
      totalResults: 150,
    });
  } catch (err) {
    return {
      success: false,
      source: "tws-error",
      error: (err as Error).message,
      rawHeadlineCount: 0,
      inWindowCount: 0,
      releases: [],
      flashes: [],
    };
  }

  if (heads.length === 0) {
    return {
      success: false,
      source: "dj-history-exhausted",
      error: null,
      rawHeadlineCount: 0,
      inWindowCount: 0,
      releases: [],
      flashes: [],
    };
  }

  const inWindow = heads.filter((h) => {
    const t = parseTwsDateTime(h.time);
    return (
      t !== null &&
      t.getTime() >= olderBoundary.getTime() &&
      t.getTime() <= recentBoundary.getTime()
    );
  });

  const flashes: DjFlash[] = inWindow
    .filter((h) => isFlash(h.headline))
    .map((h) => ({
      time: h.time,
      timeIso: parseTwsDateTime(h.time)?.toISOString() ?? null,
      articleId: h.articleId,
      provider: h.providerCode,
      headline: stripHeadlineMeta(h.headline),
    }));

  const groups = groupReleaseParts(inWindow);
  const releases: DjReleaseResult[] = [];

  for (let i = 0; i < groups.length; i += 1) {
    const parts = groups[i];
    const result = await stitchRelease(api, parts);
    const savedAs = i === 0 ? "dj-release.txt" : `dj-release-${i + 1}.txt`;
    const sha = saveTextFile(join(eventDir, savedAs), result.text);
    releases.push({
      index: i + 1,
      baseHeadline: parts[0].baseHeadline,
      provider: parts[0].providerCode,
      djTime: parts[0].time,
      djTimeIso: parseTwsDateTime(parts[0].time)?.toISOString() ?? null,
      partsTotal: parts.length,
      partsFetched: result.partsFetched,
      parts: parts.map((p) => ({ n: p.partNumber, articleId: p.articleId, headline: p.baseHeadline })),
      failures: result.failures,
      chars: result.text.length,
      savedAs,
      sha256: sha,
    });
  }

  return {
    success: releases.length > 0,
    source: groups.length > 0 ? "ok" : "no-verbatim-pr",
    error: null,
    rawHeadlineCount: heads.length,
    inWindowCount: inWindow.length,
    releases,
    flashes,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

interface EventMeta {
  symbol: string;
  eventDate: string;
  printET: string;
  conId: number;
  cik: string | null;
  note: string | null;
  generatedAt: string;
  dj: {
    source: DjResult["source"];
    error: string | null;
    rawHeadlineCount: number;
    inWindowCount: number;
    releaseCount: number;
    flashCount: number;
    releases: Omit<DjReleaseResult, never>[];
  };
  edgar: EdgarResult;
  sourcesSucceeded: { dj: boolean; edgar: boolean };
  bothFailed: boolean;
}

function parseArgs(argv: string[]): { only: string[] | null } {
  let only: string[] | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--only") {
      only = (argv[++i] ?? "").split(",").filter(Boolean).map((s) => s.toUpperCase());
    }
  }
  return { only };
}

function printSummaryTable(events: EventMeta[]): void {
  const rows = events.map((m) => {
    const rel = m.dj.releases[0];
    const djParts = rel ? `${rel.partsFetched}/${rel.partsTotal}` : `0 (${m.dj.source})`;
    const djChars = rel ? String(rel.chars) : "0";
    return {
      symbol: m.symbol,
      djParts,
      djChars,
      flashes: String(m.dj.flashCount),
      edgarExhibits: String(m.edgar.exhibits.filter((e) => e.bytes > 0).length),
      edgarAccepted: m.edgar.acceptanceDateTime ?? "—",
    };
  });
  const cols: { key: keyof (typeof rows)[number]; label: string }[] = [
    { key: "symbol", label: "symbol" },
    { key: "djParts", label: "dj parts" },
    { key: "djChars", label: "dj chars" },
    { key: "flashes", label: "flashes" },
    { key: "edgarExhibits", label: "edgar exhibits" },
    { key: "edgarAccepted", label: "edgar accepted" },
  ];
  const widths = cols.map((c) =>
    Math.max(c.label.length, ...rows.map((r) => String(r[c.key]).length)),
  );
  const line = (vals: string[]) =>
    vals.map((v, i) => v.padEnd(widths[i])).join("  |  ");
  console.log(line(cols.map((c) => c.label)));
  console.log(widths.map((w) => "-".repeat(w)).join("--+--"));
  for (const r of rows) console.log(line(cols.map((c) => String(r[c.key]))));
}

async function main(): Promise<void> {
  const { only } = parseArgs(process.argv.slice(2));
  const targets = only ? TARGETS.filter((t) => only.includes(t.symbol)) : TARGETS;
  if (targets.length === 0) {
    console.error("No matching targets. Known symbols:", TARGETS.map((t) => t.symbol).join(", "));
    process.exit(1);
  }

  mkdirSync(OUT_ROOT, { recursive: true });

  console.log("Resolving CIKs from SEC company_tickers.json...");
  const tickerMap = await loadTickerMap();
  console.log(`  ${tickerMap.size} tickers loaded.\n`);

  console.log("Connecting to TWS on clientId 9...");
  const api = await connectNewsApi();
  console.log("  connected.\n");

  const results: EventMeta[] = [];

  for (const target of targets) {
    console.log(`=== ${target.symbol} ${target.eventDate} ${target.printET} ET (conId ${target.conId}) ===`);
    const eventDir = join(OUT_ROOT, `${target.symbol}-${target.eventDate}`);
    mkdirSync(eventDir, { recursive: true });

    let dj: DjResult;
    try {
      dj = await acquireDj(api, eventDir, target);
    } catch (err) {
      dj = {
        success: false,
        source: "tws-error",
        error: (err as Error).message,
        rawHeadlineCount: 0,
        inWindowCount: 0,
        releases: [],
        flashes: [],
      };
    }
    writeJson(join(eventDir, "dj-parts.json"), dj.releases);
    writeJson(join(eventDir, "dj-flashes.json"), dj.flashes);
    console.log(
      `  DJ: ${dj.source} — ${dj.releases.length} release(s) (${dj.releases
        .map((r) => `${r.partsFetched}/${r.partsTotal} parts, ${r.chars} chars`)
        .join("; ") || "none"}), ${dj.flashes.length} flash(es)`,
    );

    const cik = tickerMap.get(target.symbol.toUpperCase()) ?? null;
    let edgar: EdgarResult;
    if (!cik) {
      edgar = {
        success: false,
        source: "cik-not-found",
        error: `ticker ${target.symbol} not found in company_tickers.json`,
        cik: null,
        accession: null,
        form: null,
        filingDate: null,
        acceptanceDateTime: null,
        usedNextDayFallback: false,
        exhibits: [],
      };
    } else {
      try {
        edgar = await acquireEdgar(cik, eventDir, target);
      } catch (err) {
        edgar = {
          success: false,
          source: "edgar-error",
          error: (err as Error).message,
          cik,
          accession: null,
          form: null,
          filingDate: null,
          acceptanceDateTime: null,
          usedNextDayFallback: false,
          exhibits: [],
        };
      }
    }
    console.log(
      `  EDGAR: ${edgar.source}${edgar.accession ? ` (${edgar.form} ${edgar.accession}, accepted ${edgar.acceptanceDateTime})` : ""} — ${
        edgar.exhibits.filter((e) => e.bytes > 0).length
      } exhibit(s)`,
    );

    const meta: EventMeta = {
      symbol: target.symbol,
      eventDate: target.eventDate,
      printET: target.printET,
      conId: target.conId,
      cik,
      note: target.note ?? null,
      generatedAt: new Date().toISOString(),
      dj: {
        source: dj.source,
        error: dj.error,
        rawHeadlineCount: dj.rawHeadlineCount,
        inWindowCount: dj.inWindowCount,
        releaseCount: dj.releases.length,
        flashCount: dj.flashes.length,
        releases: dj.releases,
      },
      edgar,
      sourcesSucceeded: { dj: dj.success, edgar: edgar.success },
      bothFailed: !dj.success && !edgar.success,
    };
    if (meta.bothFailed) console.log(`  !! BOTH SOURCES FAILED for ${target.symbol} ${target.eventDate}`);
    writeJson(join(eventDir, "meta.json"), meta);
    results.push(meta);

    await sleep(500);
  }

  try {
    api.disconnect();
  } catch {
    /* ignore */
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    corpusRoot: OUT_ROOT,
    eventCount: results.length,
    events: results.map((m) => ({
      symbol: m.symbol,
      eventDate: m.eventDate,
      printET: m.printET,
      conId: m.conId,
      cik: m.cik,
      note: m.note,
      dj: { success: m.sourcesSucceeded.dj, source: m.dj.source, releaseCount: m.dj.releaseCount, flashCount: m.dj.flashCount },
      edgar: {
        success: m.sourcesSucceeded.edgar,
        source: m.edgar.source,
        accession: m.edgar.accession,
        acceptanceDateTime: m.edgar.acceptanceDateTime,
        exhibitCount: m.edgar.exhibits.filter((e) => e.bytes > 0).length,
      },
      bothFailed: m.bothFailed,
    })),
    bothFailedEvents: results.filter((m) => m.bothFailed).map((m) => `${m.symbol} ${m.eventDate}`),
    djSuccessCount: results.filter((m) => m.sourcesSucceeded.dj).length,
    edgarSuccessCount: results.filter((m) => m.sourcesSucceeded.edgar).length,
  };
  writeJson(join(OUT_ROOT, "manifest.json"), manifest);

  console.log("\n=== CORPUS SUMMARY ===");
  printSummaryTable(results);

  console.log(`\nManifest: ${join(OUT_ROOT, "manifest.json")}`);
  const bothFailed = results.filter((m) => m.bothFailed);
  if (bothFailed.length > 0) {
    console.log(`\nEvents where BOTH sources failed (${bothFailed.length}):`);
    for (const m of bothFailed) console.log(`  - ${m.symbol} ${m.eventDate}`);
  } else {
    console.log("\nNo events had both sources fail.");
  }
}

main().catch((err) => {
  console.error("BAKEOFF CORPUS FATAL:", err);
  process.exit(1);
});
