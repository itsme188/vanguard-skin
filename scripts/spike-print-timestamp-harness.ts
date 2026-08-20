/**
 * SPIKE for the print-watch design (2026-08-20).
 * Measurement tool, NOT product code. Throwaway quality is acceptable — but it
 * must work, because it gets exactly one shot at each live earnings print.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES
 * ---------------------------------------------------------------------------
 * On a real earnings print, when does each acquisition source FIRST have the
 * release? We poll four sources in parallel and stamp our own wall clock the
 * instant each one shows us something new:
 *
 *   1. dj-*     TWS Dow Jones news feed (reqHistoricalNews / reqNewsArticle)
 *   2. edgar    SEC submissions API — first new 8-K + its EX-99.* exhibits
 *   3. finnhub  /calendar/earnings — first non-null epsActual / revenueActual
 *   4. nvda-ir  NVIDIA newsroom RSS (NVDA only — DJ does not carry its verbatim PR)
 *
 * Both clocks are recorded for every event: the SOURCE's own timestamp and OUR
 * first-seen wall clock. They differ, and the difference is the whole point.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 * Validate the whole pipeline against a known past print (no waiting):
 *
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH \
 *     npx tsx scripts/spike-print-timestamp-harness.ts --replay
 *
 * LIVE — Wednesday 2026-08-26, start it ~15:45 ET (NVDA + CRWD, both AMC):
 *
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH \
 *     npx tsx scripts/spike-print-timestamp-harness.ts --symbols NVDA,CRWD
 *
 * LIVE — Thursday 2026-08-27 for RBRK:
 *
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH \
 *     npx tsx scripts/spike-print-timestamp-harness.ts --symbols RBRK
 *
 * Flags:
 *   --symbols A,B     symbols to arm (default: everything whose event date is today ET)
 *   --replay          replay the known CRWD 2026-06-03 print instead of running live
 *   --until HH:MM     stop at this ET wall time (default: expected release + 45 min)
 *   --date YYYY-MM-DD override the event date (testing)
 *
 * PREREQUISITES
 *   - TWS (Trader Workstation) must be RUNNING and API-enabled. We open our own
 *     socket on clientId 9 — never 0 (TWS GUI), 1 (Vanguard Skin) or 2 (Stock Contest).
 *   - FINNHUB_API_KEY in .env.local.
 *   - Ctrl-C is safe at any time: JSONL is flushed on every event.
 *
 * OUTPUT
 *   data/spike-harness/{date}-{symbol}.jsonl   append-only event log (data/ is gitignored)
 *   data/spike-harness/bytes/…                 captured release / exhibit bytes
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IBApi } from "@stoqey/ib";

import {
  connectNewsApi,
  DJ_PROVIDER_CODES,
  formatTwsDateTime,
  groupReleaseParts,
  isFlash,
  isPressRelease,
  parseTwsDateTime,
  reqHistoricalNewsOnce,
  stitchRelease,
  stripHeadlineMeta,
  type NewsHeadline,
} from "./spike-print-tws-news";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SymbolConfig {
  symbol: string;
  /** IBKR contract id (from securities.ib_con_id). */
  conId: number;
  /** SEC CIK, zero-padded to 10 digits. Verified against company_tickers.json. */
  cik: string;
  /** Event date, YYYY-MM-DD. */
  eventDate: string;
  /** Expected release time, ET wall clock "HH:MM". */
  expectedReleaseET: string;
  /** NVDA only: newsroom RSS feed (DJ carries no verbatim NVDA press release). */
  irFeedUrl?: string;
  /** NVDA only: predicted direct article URL — 200s with a placeholder title until publish. */
  irDirectUrl?: string;
  /** Regex the IR item title must match to count as the quarterly results release. */
  irTitleRegex?: RegExp;
}

/**
 * Release times are taken from the app's OWN enriched calendar_events table
 * (the authoritative local source), not from guesswork:
 *   NVDA 2026-08-26 16:20 ET | CRWD 2026-08-26 16:15 ET | RBRK 2026-08-27 17:00 ET
 * RBRK at 17:00 is the one that bites — a 16:05 assumption would stop the
 * harness before the print. conIds come from securities.ib_con_id and were
 * each verified live to return DJ headlines.
 */
const CONFIG: Record<string, SymbolConfig> = {
  NVDA: {
    symbol: "NVDA",
    conId: 4815747,
    cik: "0001045810",
    eventDate: "2026-08-26",
    expectedReleaseET: "16:20",
    irFeedUrl: "https://nvidianews.nvidia.com/cats/press_release.xml",
    irDirectUrl:
      "https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-second-quarter-fiscal-2027",
    irTitleRegex:
      /NVIDIA Announces Financial Results for (First|Second|Third|Fourth) Quarter( and)? Fiscal 20\d\d/i,
  },
  CRWD: {
    symbol: "CRWD",
    conId: 370757467,
    cik: "0001535527",
    eventDate: "2026-08-26",
    expectedReleaseET: "16:15",
  },
  RBRK: {
    symbol: "RBRK",
    conId: 699030013,
    cik: "0001943896",
    eventDate: "2026-08-27",
    // 17:00 ET per the app calendar — NOT the 16:05 AMC default.
    expectedReleaseET: "17:00",
  },
};

/**
 * Arm the TWS window this many minutes BEFORE the expected release.
 * 30 (not 15): companies do print early — the project's own wire-time notes
 * record XMTR hitting ~07:05 against an 08:00 expectation — and a headline
 * that lands before the arm window is invisible to us.
 */
const ARM_LEAD_MIN = 30;

/** The known past print the --replay acceptance test runs against. */
const REPLAY = {
  symbol: "CRWD",
  conId: 370757467,
  cik: "0001535527",
  eventDate: "2026-06-03",
  expectedReleaseET: "16:05",
  /** Headline the capture header MUST carry. */
  expectContains: "CrowdStrike Reports First Quarter",
  /**
   * Marker that must appear in the BODY. DJ article bodies carry no headline,
   * so asserting on the headline alone would only test our own header block —
   * this proves we really pulled the release text.
   */
  expectBodyContains: "first quarter fiscal year 2027",
  /** DJ split this release across exactly 7 parts. */
  expectParts: 7,
  expectMinChars: 10_000,
};

const POLL_MS = {
  tws: 10_000,
  edgar: 10_000,
  finnhub: 30_000,
  ir: 15_000,
};

const SEC_UA = "PortfolioDesk contact@myportfoliodesk.com";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126 Safari/537.36";

const OUT_DIR = join(process.cwd(), "data", "spike-harness");
const BYTES_DIR = join(OUT_DIR, "bytes");

// ---------------------------------------------------------------------------
// Time helpers (ET wall clock <-> UTC)
// ---------------------------------------------------------------------------

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
  const p = Object.fromEntries(
    fmt.formatToParts(d).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
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

/** Resolve an ET wall clock ("2026-08-26", "16:20") to a real UTC instant. */
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
  // Two passes converge (the offset only changes on DST boundaries).
  for (let i = 0; i < 2; i += 1) d = new Date(naive - etOffsetMinutes(d) * 60_000);
  return d;
}

function etClock(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

type EventKind = "first_seen" | "article" | "exhibit" | "error" | "info";

interface HarnessEvent {
  wall_ts: string;
  monotonic_ms: number;
  source: string;
  kind: EventKind;
  symbol: string;
  detail: string;
  /** The source's OWN timestamp, when it publishes one (vs. our first-seen). */
  source_ts?: string;
  /** Lag in ms between the source's own timestamp and our first-seen. */
  lag_ms?: number;
  sha256?: string;
  bytes_path?: string;
  extra?: Record<string, unknown>;
}

const T0 = process.hrtime.bigint();
function monotonicMs(): number {
  return Number(process.hrtime.bigint() - T0) / 1e6;
}

class EventLog {
  private readonly paths = new Map<string, string>();

  constructor(private readonly runDate: string) {
    mkdirSync(BYTES_DIR, { recursive: true });
  }

  private pathFor(symbol: string): string {
    let p = this.paths.get(symbol);
    if (!p) {
      p = join(OUT_DIR, `${this.runDate}-${symbol}.jsonl`);
      this.paths.set(symbol, p);
    }
    return p;
  }

  write(e: Omit<HarnessEvent, "wall_ts" | "monotonic_ms">): HarnessEvent {
    const full: HarnessEvent = {
      wall_ts: new Date().toISOString(),
      monotonic_ms: Number(monotonicMs().toFixed(3)),
      ...e,
    };
    // Append-only, flushed per event: Ctrl-C never loses measurements.
    appendFileSync(this.pathFor(e.symbol), `${JSON.stringify(full)}\n`);

    const lag =
      full.lag_ms !== undefined ? ` (+${(full.lag_ms / 1000).toFixed(1)}s)` : "";
    const marker = full.kind === "error" ? "ERR " : "";
    console.log(
      `[${etClock(new Date())} ET] ${marker}${full.symbol} ${full.source}/${full.kind}${lag} ${full.detail}`,
    );
    return full;
  }

  files(): string[] {
    return [...this.paths.values()];
  }
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function saveBytes(name: string, content: Buffer | string): { path: string; sha: string } {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160);
  const path = join(BYTES_DIR, safe);
  writeFileSync(path, content);
  return { path, sha: sha256(content) };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function loadFinnhubKey(): string | null {
  if (process.env.FINNHUB_API_KEY) return process.env.FINNHUB_API_KEY;
  try {
    // Manual parse — avoids pulling dotenv's side effects into a spike script.
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const m = /^\s*FINNHUB_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** fetch with a timeout — a hung socket must never stall a poll loop. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15_000, ...rest } = init;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Source 1 — TWS Dow Jones news
// ---------------------------------------------------------------------------

class TwsNewsSource {
  private readonly seenArticles = new Set<string>();
  private readonly headlines: NewsHeadline[] = [];
  private readonly stitched = new Set<string>();
  private lastGroupSignatures = new Set<string>();

  constructor(
    private readonly api: IBApi,
    private readonly cfg: { symbol: string; conId: number },
    private readonly windowStart: Date,
    private readonly log: EventLog,
  ) {}

  /**
   * One poll. QUIRK (verified live): the FIRST datetime is the RECENT boundary
   * and results walk BACKWARD from it. The second (older) boundary is NOT a
   * hard floor — TWS keeps walking back until totalResults is exhausted — so we
   * filter to the armed window ourselves.
   */
  async poll(): Promise<void> {
    const recent = new Date(Date.now() + 60_000); // clock-skew buffer
    const heads = await reqHistoricalNewsOnce(this.api, {
      conId: this.cfg.conId,
      providerCodes: DJ_PROVIDER_CODES,
      startDateTime: formatTwsDateTime(recent),
      endDateTime: formatTwsDateTime(this.windowStart),
      totalResults: 60,
    });

    for (const h of heads) {
      const t = parseTwsDateTime(h.time);
      if (!t || t.getTime() < this.windowStart.getTime()) continue;
      if (this.seenArticles.has(h.articleId)) continue;
      this.seenArticles.add(h.articleId);
      this.headlines.push(h);

      const clean = stripHeadlineMeta(h.headline);
      const source = isFlash(h.headline)
        ? "dj-flash"
        : isPressRelease(h.headline)
          ? "dj-press"
          : "dj-story";

      this.log.write({
        source,
        kind: "first_seen",
        symbol: this.cfg.symbol,
        // Flash numbers are logged RAW — no parsing, no rounding.
        detail: clean,
        source_ts: t.toISOString(),
        lag_ms: Date.now() - t.getTime(),
        extra: { articleId: h.articleId, provider: h.providerCode },
      });
    }

    await this.stitchSettledReleases();
  }

  /**
   * Stitch a multi-part release once its part set has been STABLE for one poll
   * cycle — otherwise we'd stitch part 1 alone and miss parts 2..N.
   */
  private async stitchSettledReleases(): Promise<void> {
    const groups = groupReleaseParts(this.headlines);
    const signatures = new Set<string>();

    for (const parts of groups) {
      const sig = parts.map((p) => p.articleId).join(",");
      signatures.add(sig);
      const releaseId = parts[0].articleId;
      if (this.stitched.has(releaseId)) continue;
      if (!this.lastGroupSignatures.has(sig)) continue; // not settled yet

      this.stitched.add(releaseId);
      const result = await stitchRelease(this.api, parts);
      const { path } = saveBytes(
        `${this.cfg.symbol}-dj-${releaseId.replace(/[^A-Za-z0-9]/g, "")}.txt`,
        result.text,
      );
      // Hash the BODY only. The header carries captured_at, so a header-inclusive
      // hash changes every capture and is useless as a content fingerprint.
      const sha = sha256(result.body);
      this.log.write({
        source: "dj-press",
        kind: "article",
        symbol: this.cfg.symbol,
        detail:
          `stitched "${parts[0].baseHeadline}" — ${result.partsFetched}/${parts.length} parts, ` +
          `${result.text.length} chars`,
        source_ts: parseTwsDateTime(parts[0].time)?.toISOString(),
        sha256: sha,
        bytes_path: path,
        extra: {
          parts: parts.map((p) => ({ n: p.partNumber, articleId: p.articleId })),
          failures: result.failures,
        },
      });
      for (const f of result.failures) {
        this.log.write({
          source: "dj-press",
          kind: "error",
          symbol: this.cfg.symbol,
          detail: `part fetch failed: ${f}`,
        });
      }
    }

    this.lastGroupSignatures = signatures;
  }

  /** Replay path: one pass, then stitch immediately (no settle wait needed). */
  async pollOnceAndStitch(): Promise<void> {
    await this.poll();
    this.lastGroupSignatures = new Set(
      groupReleaseParts(this.headlines).map((parts) =>
        parts.map((p) => p.articleId).join(","),
      ),
    );
    await this.stitchSettledReleases();
  }
}

// ---------------------------------------------------------------------------
// Source 2 — SEC EDGAR
// ---------------------------------------------------------------------------

interface EdgarFiling {
  accession: string;
  form: string;
  filingDate: string;
  acceptanceDateTime: string;
  primaryDocument: string;
}

async function fetchEdgarFilings(cik: string): Promise<EdgarFiling[]> {
  const res = await fetchWithTimeout(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { "User-Agent": SEC_UA, "Cache-Control": "no-cache", Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`EDGAR submissions HTTP ${res.status}`);
  const json = (await res.json()) as {
    filings: { recent: Record<string, unknown[]> };
  };
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
 * Walk a filing's SGML header to find its EX-99.* exhibits. The header
 * (`{accession}-index-headers.html`) carries `<TYPE>` / `<FILENAME>` pairs;
 * index.json does NOT expose exhibit types.
 */
async function fetchExhibits(
  cik: string,
  accession: string,
): Promise<{ type: string; filename: string; url: string }[]> {
  const cikNum = String(Number(cik));
  const accNoDash = accession.replace(/-/g, "");
  const base = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}`;
  const res = await fetchWithTimeout(`${base}/${accession}-index-headers.html`, {
    headers: { "User-Agent": SEC_UA, "Cache-Control": "no-cache" },
  });
  if (!res.ok) throw new Error(`EDGAR index-headers HTTP ${res.status}`);
  const html = await res.text();

  const out: { type: string; filename: string; url: string }[] = [];
  // Tags are HTML-escaped inside a <PRE> block: "&lt;TYPE&gt;EX-99.1".
  const re = /&lt;TYPE&gt;([^\s<]+)[\s\S]*?&lt;FILENAME&gt;([^\s<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [, type, filename] = m;
    if (/^EX-99/i.test(type)) out.push({ type, filename, url: `${base}/${filename}` });
  }
  return out;
}

class EdgarSource {
  private baseline: Set<string> | null = null;

  constructor(
    private readonly cfg: { symbol: string; cik: string },
    private readonly log: EventLog,
  ) {}

  async poll(): Promise<void> {
    const filings = await fetchEdgarFilings(this.cfg.cik);

    if (this.baseline === null) {
      this.baseline = new Set(filings.map((f) => f.accession));
      this.log.write({
        source: "edgar",
        kind: "info",
        symbol: this.cfg.symbol,
        detail: `baseline snapshot: ${filings.length} filings, newest ${filings[0]?.form} ${filings[0]?.accession}`,
      });
      return;
    }

    for (const f of filings) {
      if (this.baseline.has(f.accession)) continue;
      this.baseline.add(f.accession);
      await this.report(f);
    }
  }

  /** Log a filing and, when it is an 8-K, download + hash its EX-99.* exhibits. */
  async report(f: EdgarFiling): Promise<void> {
    // acceptanceDateTime is UTC with a real Z (verified: a 2026-06-09 filing
    // carries 2026-06-10T01:44Z — impossible if the stamp were ET).
    const accepted = new Date(f.acceptanceDateTime);
    this.log.write({
      source: "edgar",
      kind: "first_seen",
      symbol: this.cfg.symbol,
      detail: `${f.form} ${f.accession} accepted ${f.acceptanceDateTime}`,
      source_ts: accepted.toISOString(),
      lag_ms: Date.now() - accepted.getTime(),
      extra: { form: f.form, primaryDocument: f.primaryDocument },
    });

    if (!/^8-K/i.test(f.form)) return;

    try {
      const exhibits = await fetchExhibits(this.cfg.cik, f.accession);
      if (exhibits.length === 0) {
        this.log.write({
          source: "edgar",
          kind: "info",
          symbol: this.cfg.symbol,
          detail: `8-K ${f.accession} has no EX-99.* exhibit`,
        });
      }
      for (const ex of exhibits) {
        const res = await fetchWithTimeout(ex.url, {
          headers: { "User-Agent": SEC_UA },
          timeoutMs: 30_000,
        });
        if (!res.ok) throw new Error(`exhibit HTTP ${res.status} for ${ex.filename}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const { path, sha } = saveBytes(`${this.cfg.symbol}-edgar-${ex.filename}`, buf);
        this.log.write({
          source: "edgar",
          kind: "exhibit",
          symbol: this.cfg.symbol,
          detail: `${ex.type} ${ex.filename} (${buf.length} bytes)`,
          sha256: sha,
          bytes_path: path,
          extra: { url: ex.url, accession: f.accession },
        });
      }
    } catch (err) {
      this.log.write({
        source: "edgar",
        kind: "error",
        symbol: this.cfg.symbol,
        detail: `exhibit walk failed for ${f.accession}: ${(err as Error).message}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Source 3 — Finnhub actuals
// ---------------------------------------------------------------------------

class FinnhubSource {
  private reported = false;

  constructor(
    private readonly cfg: { symbol: string; eventDate: string },
    private readonly apiKey: string,
    private readonly log: EventLog,
  ) {}

  async poll(): Promise<void> {
    if (this.reported) return;
    const url =
      `https://finnhub.io/api/v1/calendar/earnings?from=${this.cfg.eventDate}` +
      `&to=${this.cfg.eventDate}&symbol=${encodeURIComponent(this.cfg.symbol)}` +
      `&token=${this.apiKey}`;
    const res = await fetchWithTimeout(url, { timeoutMs: 15_000 });
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    const json = (await res.json()) as {
      earningsCalendar?: {
        symbol: string;
        epsActual: number | null;
        revenueActual: number | null;
        epsEstimate: number | null;
        revenueEstimate: number | null;
      }[];
    };
    const row = (json.earningsCalendar ?? []).find(
      (e) => e.symbol.toUpperCase() === this.cfg.symbol.toUpperCase(),
    );
    if (!row) return;
    if (row.epsActual === null && row.revenueActual === null) return;

    this.reported = true;
    this.log.write({
      source: "finnhub",
      kind: "first_seen",
      symbol: this.cfg.symbol,
      detail: `epsActual=${row.epsActual} revenueActual=${row.revenueActual} (est eps=${row.epsEstimate} rev=${row.revenueEstimate})`,
      extra: row as unknown as Record<string, unknown>,
    });
  }
}

// ---------------------------------------------------------------------------
// Source 4 — NVDA IR newsroom
// ---------------------------------------------------------------------------

interface RssItem {
  title: string;
  link: string;
  pubDate?: string;
  modDate?: string;
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const pick = (block: string, tag: string): string | undefined => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
    if (!m) return undefined;
    return m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#8217;|&rsquo;/g, "'")
      .trim();
  };
  for (const b of blocks) {
    const title = pick(b, "title");
    const link = pick(b, "link");
    if (!title || !link) continue;
    items.push({ title, link, pubDate: pick(b, "pubDate"), modDate: pick(b, "modDate") });
  }
  return items;
}

/**
 * NVIDIA's newsroom sits behind Varnish with a ~300s default TTL and NO
 * Cache-Control from origin. Without a cache-buster a 15s poll would just
 * re-read a copy up to 5 minutes stale — so every request gets a fresh nonce.
 */
function bust(url: string): string {
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  return url.includes("?") ? `${url}&zz=${nonce}` : `${url}?zz=${nonce}`;
}

const IR_PLACEHOLDER_TITLE = /News Archive \| NVIDIA Newsroom/i;

class IrFeedSource {
  private baseline: Set<string> | null = null;
  private matched = false;
  private directHit = false;

  constructor(
    private readonly cfg: SymbolConfig,
    private readonly log: EventLog,
  ) {}

  async poll(): Promise<void> {
    await this.pollFeed();
    await this.pollDirect();
  }

  private async pollFeed(): Promise<void> {
    if (!this.cfg.irFeedUrl) return;
    const res = await fetchWithTimeout(bust(this.cfg.irFeedUrl), {
      headers: { "User-Agent": BROWSER_UA, "Cache-Control": "no-cache" },
    });
    if (!res.ok) throw new Error(`IR feed HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseRssItems(xml);

    if (this.baseline === null) {
      this.baseline = new Set(items.map((i) => i.link));
      this.log.write({
        source: "nvda-ir",
        kind: "info",
        symbol: this.cfg.symbol,
        detail: `feed baseline: ${items.length} items, newest "${items[0]?.title ?? "(none)"}"`,
        extra: { varnish: res.headers.get("x-varnish-2023-cache"), age: res.headers.get("age") },
      });
      return;
    }

    for (const item of items) {
      if (this.baseline.has(item.link)) continue;
      this.baseline.add(item.link);
      const isResults = this.cfg.irTitleRegex?.test(item.title) ?? false;
      this.log.write({
        source: "nvda-ir",
        kind: "first_seen",
        symbol: this.cfg.symbol,
        detail: `${isResults ? "QUARTERLY RESULTS " : ""}feed item: ${item.title}`,
        source_ts: item.modDate ?? item.pubDate,
        extra: { link: item.link, pubDate: item.pubDate, modDate: item.modDate },
      });
      if (isResults && !this.matched) {
        this.matched = true;
        await this.capture(item.link, "release");
      }
    }
  }

  /**
   * The predicted article URL 200s with the generic archive title until the
   * release publishes — so a title that is no longer the placeholder IS the signal.
   */
  private async pollDirect(): Promise<void> {
    if (!this.cfg.irDirectUrl || this.directHit) return;
    const res = await fetchWithTimeout(bust(this.cfg.irDirectUrl), {
      headers: { "User-Agent": BROWSER_UA, "Cache-Control": "no-cache" },
    });
    if (!res.ok) return; // 404 before publish is normal, not an error
    const html = await res.text();
    const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
    if (!title || IR_PLACEHOLDER_TITLE.test(title)) return;

    this.directHit = true;
    this.log.write({
      source: "nvda-ir",
      kind: "first_seen",
      symbol: this.cfg.symbol,
      detail: `direct URL went live: "${title}"`,
      extra: { url: this.cfg.irDirectUrl },
    });
    await this.capture(this.cfg.irDirectUrl, "direct");
  }

  private async capture(url: string, label: string): Promise<void> {
    try {
      const res = await fetchWithTimeout(bust(url), {
        headers: { "User-Agent": BROWSER_UA },
        timeoutMs: 30_000,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const { path, sha } = saveBytes(
        `${this.cfg.symbol}-ir-${label}-${Date.now()}.html`,
        buf,
      );
      this.log.write({
        source: "nvda-ir",
        kind: "article",
        symbol: this.cfg.symbol,
        detail: `captured ${label} page (${buf.length} bytes)`,
        sha256: sha,
        bytes_path: path,
        extra: { url },
      });
    } catch (err) {
      this.log.write({
        source: "nvda-ir",
        kind: "error",
        symbol: this.cfg.symbol,
        detail: `capture failed for ${url}: ${(err as Error).message}`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Loop driver — ERRORS ARE DATA: one source failing must never kill the others
// ---------------------------------------------------------------------------

function startLoop(opts: {
  name: string;
  symbol: string;
  intervalMs: number;
  deadline: number;
  log: EventLog;
  fn: () => Promise<void>;
}): Promise<void> {
  return new Promise<void>((resolve) => {
    let consecutiveErrors = 0;

    const tick = async () => {
      if (Date.now() >= opts.deadline) {
        resolve();
        return;
      }
      try {
        await opts.fn();
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        opts.log.write({
          source: opts.name,
          kind: "error",
          symbol: opts.symbol,
          detail: `${(err as Error).message} (consecutive=${consecutiveErrors})`,
        });
      }
      // Exponential backoff on repeated failure, capped at 8x the base interval.
      const backoff = Math.min(2 ** Math.max(0, consecutiveErrors - 1), 8);
      const delay = Math.min(opts.intervalMs * backoff, opts.deadline - Date.now());
      if (delay <= 0) {
        resolve();
        return;
      }
      setTimeout(tick, delay);
    };

    void tick();
  });
}

// ---------------------------------------------------------------------------
// Replay — the acceptance test
// ---------------------------------------------------------------------------

async function runReplay(): Promise<void> {
  console.log("=== SPIKE REPLAY: CRWD 2026-06-03 print (16:05 ET / 20:05 UTC) ===\n");
  const log = new EventLog(`replay-${REPLAY.eventDate}`);
  const failures: string[] = [];

  // --- TWS ---------------------------------------------------------------
  let stitchedText = "";
  let stitchedBody = "";
  let stitchedSha = "";
  let stitchedParts = 0;
  let stitchedTotalParts = 0;
  try {
    const api = await connectNewsApi();
    console.log("TWS: connected on clientId 9");
    const windowStart = etToUtc(REPLAY.eventDate, "15:50");
    const source = new TwsNewsSource(
      api,
      { symbol: REPLAY.symbol, conId: REPLAY.conId },
      windowStart,
      log,
    );
    // Replay reaches into the past, so the "recent boundary" must be the past too.
    const recentBoundary = etToUtc(REPLAY.eventDate, "17:00");
    const heads = await reqHistoricalNewsOnce(api, {
      conId: REPLAY.conId,
      providerCodes: DJ_PROVIDER_CODES,
      startDateTime: formatTwsDateTime(recentBoundary),
      endDateTime: formatTwsDateTime(windowStart),
      totalResults: 120,
    });
    console.log(`TWS: ${heads.length} raw headlines returned`);

    // Feed the historical headlines through the SAME classify/stitch path.
    const inWindow = heads.filter((h) => {
      const t = parseTwsDateTime(h.time);
      return t !== null && t.getTime() >= windowStart.getTime();
    });
    for (const h of inWindow) {
      const t = parseTwsDateTime(h.time)!;
      const src = isFlash(h.headline)
        ? "dj-flash"
        : isPressRelease(h.headline)
          ? "dj-press"
          : "dj-story";
      log.write({
        source: src,
        kind: "first_seen",
        symbol: REPLAY.symbol,
        detail: stripHeadlineMeta(h.headline),
        source_ts: t.toISOString(),
        extra: { articleId: h.articleId, provider: h.providerCode, replay: true },
      });
    }

    const groups = groupReleaseParts(inWindow);
    console.log(`TWS: ${groups.length} press-release group(s) detected`);
    for (const parts of groups) {
      console.log(
        `TWS: group "${parts[0].baseHeadline}" -> ${parts.length} parts ` +
          `[${parts.map((p) => p.partNumber).join(",")}]`,
      );
      const result = await stitchRelease(api, parts, (p, chars) =>
        console.log(`      part ${p.partNumber} ${p.articleId}: ${chars} chars`),
      );
      const { path } = saveBytes(
        `REPLAY-${REPLAY.symbol}-dj-${parts[0].articleId.replace(/[^A-Za-z0-9]/g, "")}.txt`,
        result.text,
      );
      const sha = sha256(result.body);
      log.write({
        source: "dj-press",
        kind: "article",
        symbol: REPLAY.symbol,
        detail: `stitched "${parts[0].baseHeadline}" — ${result.partsFetched}/${parts.length} parts, ${result.text.length} chars`,
        source_ts: parseTwsDateTime(parts[0].time)?.toISOString(),
        sha256: sha,
        bytes_path: path,
        extra: { replay: true, failures: result.failures },
      });
      if (result.header.includes(REPLAY.expectContains)) {
        stitchedText = result.text;
        stitchedBody = result.body;
        stitchedSha = sha;
        stitchedParts = result.partsFetched;
        stitchedTotalParts = parts.length;
      }
    }
    api.disconnect();
  } catch (err) {
    failures.push(`TWS leg: ${(err as Error).message}`);
    log.write({
      source: "tws",
      kind: "error",
      symbol: REPLAY.symbol,
      detail: (err as Error).message,
    });
  }

  // --- EDGAR -------------------------------------------------------------
  let exhibitOk = false;
  try {
    const filings = await fetchEdgarFilings(REPLAY.cik);
    const eightK = filings.find(
      (f) => /^8-K/i.test(f.form) && f.filingDate === REPLAY.eventDate,
    );
    if (!eightK) throw new Error(`no 8-K found on ${REPLAY.eventDate}`);
    console.log(
      `EDGAR: 8-K ${eightK.accession} accepted ${eightK.acceptanceDateTime}`,
    );
    const edgar = new EdgarSource({ symbol: REPLAY.symbol, cik: REPLAY.cik }, log);
    await edgar.report(eightK);
    const exhibits = await fetchExhibits(REPLAY.cik, eightK.accession);
    exhibitOk = exhibits.some((e) => /^EX-99/i.test(e.type));
    console.log(
      `EDGAR: exhibits -> ${exhibits.map((e) => `${e.type}:${e.filename}`).join(", ") || "(none)"}`,
    );
  } catch (err) {
    failures.push(`EDGAR leg: ${(err as Error).message}`);
    log.write({
      source: "edgar",
      kind: "error",
      symbol: REPLAY.symbol,
      detail: (err as Error).message,
    });
  }

  // --- Finnhub (expected to be empty: free tier is forward-looking only) ---
  const key = loadFinnhubKey();
  if (key) {
    try {
      const url =
        `https://finnhub.io/api/v1/calendar/earnings?from=${REPLAY.eventDate}` +
        `&to=${REPLAY.eventDate}&symbol=${REPLAY.symbol}&token=${key}`;
      const res = await fetchWithTimeout(url);
      const json = (await res.json()) as { earningsCalendar?: unknown[] };
      const n = json.earningsCalendar?.length ?? 0;
      console.log(
        `Finnhub: historical query returned ${n} row(s)` +
          (n === 0 ? " — free tier serves FORWARD-looking dates only (expected)" : ""),
      );
      log.write({
        source: "finnhub",
        kind: n === 0 ? "info" : "first_seen",
        symbol: REPLAY.symbol,
        detail: `replay historical query returned ${n} row(s)`,
        extra: { rows: json.earningsCalendar ?? [] },
      });
    } catch (err) {
      failures.push(`Finnhub leg: ${(err as Error).message}`);
    }
  } else {
    failures.push("Finnhub leg: FINNHUB_API_KEY not found");
  }

  // --- NVDA IR connectivity check (no historical replay possible) ---------
  let irOk = false;
  try {
    const res = await fetchWithTimeout(bust(CONFIG.NVDA.irFeedUrl!), {
      headers: { "User-Agent": BROWSER_UA },
    });
    const xml = await res.text();
    const items = parseRssItems(xml);
    irOk = items.length > 0;
    console.log(
      `NVDA IR: feed reachable, ${items.length} items, varnish=${res.headers.get("x-varnish-2023-cache")} age=${res.headers.get("age")}`,
    );
    log.write({
      source: "nvda-ir",
      kind: "info",
      symbol: REPLAY.symbol,
      detail: `connectivity check: ${items.length} items, newest "${items[0]?.title ?? "(none)"}"`,
      extra: {
        varnish: res.headers.get("x-varnish-2023-cache"),
        age: res.headers.get("age"),
      },
    });
  } catch (err) {
    failures.push(`NVDA IR leg: ${(err as Error).message}`);
  }

  // --- Assertions --------------------------------------------------------
  console.log("\n=== REPLAY ACCEPTANCE ===");
  const bodyHasMarker = stitchedBody
    .toLowerCase()
    .includes(REPLAY.expectBodyContains.toLowerCase());
  const checks: [string, boolean, string][] = [
    [
      "stitched release > 10k chars",
      stitchedText.length > REPLAY.expectMinChars,
      `${stitchedText.length} chars`,
    ],
    [
      `capture header carries "${REPLAY.expectContains}"`,
      stitchedText.includes(REPLAY.expectContains),
      stitchedText.includes(REPLAY.expectContains) ? "yes" : "NO",
    ],
    [
      `BODY contains "${REPLAY.expectBodyContains}"`,
      bodyHasMarker,
      bodyHasMarker ? "yes" : "NO",
    ],
    [
      `all ${REPLAY.expectParts} DJ parts fetched`,
      stitchedParts === REPLAY.expectParts && stitchedTotalParts === REPLAY.expectParts,
      `${stitchedParts}/${stitchedTotalParts}`,
    ],
    ["stitched release hashed", stitchedSha.length === 64, stitchedSha.slice(0, 16) || "(none)"],
    ["EX-99.1 downloaded + hashed", exhibitOk, exhibitOk ? "yes" : "NO"],
    ["NVDA IR feed reachable", irOk, irOk ? "yes" : "NO"],
  ];

  // JSONL well-formedness: re-read every line we wrote and parse it.
  let jsonlOk = true;
  let lineCount = 0;
  for (const file of log.files()) {
    const raw = readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      lineCount += 1;
      try {
        const obj = JSON.parse(line);
        if (!obj.wall_ts || typeof obj.monotonic_ms !== "number" || !obj.source) {
          jsonlOk = false;
        }
      } catch {
        jsonlOk = false;
      }
    }
  }
  checks.push(["JSONL well-formed", jsonlOk, `${lineCount} lines`]);

  let allPass = true;
  for (const [name, ok, note] of checks) {
    if (!ok) allPass = false;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  (${note})`);
  }
  if (failures.length > 0) {
    console.log("\nNon-fatal leg failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`\nJSONL: ${log.files().join(", ")}`);
  console.log(`Bytes: ${BYTES_DIR}`);
  console.log(`\nREPLAY ${allPass ? "PASSED" : "FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

async function runLive(symbols: string[], untilET: string | null): Promise<void> {
  const configs = symbols.map((s) => {
    const c = CONFIG[s.toUpperCase()];
    if (!c) throw new Error(`Unknown symbol ${s}. Known: ${Object.keys(CONFIG).join(", ")}`);
    return c;
  });

  const runDate = configs[0].eventDate;
  const log = new EventLog(runDate);

  // Deadline: --until, else the LATEST expected release + 45 min.
  const deadline = untilET
    ? etToUtc(runDate, untilET).getTime()
    : Math.max(
        ...configs.map(
          (c) => etToUtc(c.eventDate, c.expectedReleaseET).getTime() + 45 * 60_000,
        ),
      );

  console.log("=== SPIKE PRINT-TIMESTAMP HARNESS (live) ===");
  for (const c of configs) {
    const armed = new Date(
      etToUtc(c.eventDate, c.expectedReleaseET).getTime() - ARM_LEAD_MIN * 60_000,
    );
    console.log(
      `  ${c.symbol}  conId=${c.conId}  CIK=${c.cik}  expect ${c.eventDate} ${c.expectedReleaseET} ET  ` +
        `(DJ window armed from ${etClock(armed)} ET)`,
    );
  }
  console.log(`  stop at: ${etClock(new Date(deadline))} ET`);
  console.log(`  JSONL:   ${OUT_DIR}/${runDate}-{SYMBOL}.jsonl\n`);

  if (Date.now() >= deadline) {
    console.error("Deadline is already in the past — nothing to do.");
    process.exit(1);
  }

  const tasks: Promise<void>[] = [];

  // --- TWS: ONE socket, symbols polled sequentially inside a single loop ---
  // (IB paces per-connection; serializing keeps us well inside its limits.)
  try {
    const api = await connectNewsApi();
    console.log("TWS: connected on clientId 9\n");
    const twsSources = configs.map(
      (c) =>
        new TwsNewsSource(
          api,
          { symbol: c.symbol, conId: c.conId },
          new Date(
            etToUtc(c.eventDate, c.expectedReleaseET).getTime() - ARM_LEAD_MIN * 60_000,
          ),
          log,
        ),
    );
    tasks.push(
      startLoop({
        name: "tws",
        symbol: configs.map((c) => c.symbol).join("+"),
        intervalMs: POLL_MS.tws,
        deadline,
        log,
        fn: async () => {
          for (const s of twsSources) await s.poll();
        },
      }).then(() => {
        try {
          api.disconnect();
        } catch {
          /* ignore */
        }
      }),
    );
  } catch (err) {
    // TWS down must not abort the run — the other three sources still measure.
    log.write({
      source: "tws",
      kind: "error",
      symbol: configs.map((c) => c.symbol).join("+"),
      detail: `connect failed, TWS leg DISABLED for this run: ${(err as Error).message}`,
    });
    console.error(`\n!! TWS leg disabled: ${(err as Error).message}\n`);
  }

  const finnhubKey = loadFinnhubKey();
  if (!finnhubKey) {
    log.write({
      source: "finnhub",
      kind: "error",
      symbol: "ALL",
      detail: "FINNHUB_API_KEY not found in env or .env.local — Finnhub leg DISABLED",
    });
  }

  for (const c of configs) {
    const edgar = new EdgarSource({ symbol: c.symbol, cik: c.cik }, log);
    tasks.push(
      startLoop({
        name: "edgar",
        symbol: c.symbol,
        intervalMs: POLL_MS.edgar,
        deadline,
        log,
        fn: () => edgar.poll(),
      }),
    );

    if (finnhubKey) {
      const fh = new FinnhubSource(
        { symbol: c.symbol, eventDate: c.eventDate },
        finnhubKey,
        log,
      );
      tasks.push(
        startLoop({
          name: "finnhub",
          symbol: c.symbol,
          intervalMs: POLL_MS.finnhub,
          deadline,
          log,
          fn: () => fh.poll(),
        }),
      );
    }

    if (c.irFeedUrl) {
      const ir = new IrFeedSource(c, log);
      tasks.push(
        startLoop({
          name: "nvda-ir",
          symbol: c.symbol,
          intervalMs: POLL_MS.ir,
          deadline,
          log,
          fn: () => ir.poll(),
        }),
      );
    }
  }

  const onSigint = () => {
    console.log("\nInterrupted — JSONL already flushed. Files:");
    for (const f of log.files()) console.log(`  ${f}`);
    process.exit(0);
  };
  process.on("SIGINT", onSigint);

  await Promise.all(tasks);

  console.log("\n=== RUN COMPLETE ===");
  for (const f of log.files()) console.log(`  ${f}`);
  console.log(`  bytes: ${BYTES_DIR}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const out: { symbols: string[]; replay: boolean; until: string | null; date: string | null } = {
    symbols: [],
    replay: false,
    until: null,
    date: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--replay") out.replay = true;
    else if (a === "--symbols") out.symbols = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--until") out.until = argv[++i] ?? null;
    else if (a === "--date") out.date = argv[++i] ?? null;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: npx tsx scripts/spike-print-timestamp-harness.ts " +
          "[--replay] [--symbols NVDA,CRWD] [--until HH:MM] [--date YYYY-MM-DD]",
      );
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(BYTES_DIR, { recursive: true });

  if (args.replay) {
    await runReplay();
    return;
  }

  if (args.date) {
    for (const c of Object.values(CONFIG)) c.eventDate = args.date;
  }

  let symbols = args.symbols;
  if (symbols.length === 0) {
    const today = todayET();
    symbols = Object.values(CONFIG)
      .filter((c) => c.eventDate === today)
      .map((c) => c.symbol);
    if (symbols.length === 0) {
      console.error(
        `No configured symbol has event date ${today} (ET). Pass --symbols explicitly.`,
      );
      process.exit(1);
    }
  }

  await runLive(symbols, args.until);
}

main().catch((err) => {
  console.error("HARNESS FATAL:", err);
  process.exit(1);
});
