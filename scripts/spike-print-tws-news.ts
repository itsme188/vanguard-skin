/**
 * SPIKE for the print-watch design (2026-08-20).
 * Measurement tool, not product code. Throwaway quality is acceptable —
 * but it must work, because it runs live on a real earnings print.
 *
 * Raw-IBApi news client for the print-timestamp harness.
 *
 * WHY RAW IBApi: IBApiNext has no promise wrappers for reqHistoricalNews /
 * reqNewsArticle (same situation as lib/tws/wsh.ts documents for WSH). We
 * open our OWN socket on clientId 9 so we never contend with the app
 * (clientId 1) or Stock Contest (clientId 2). NEVER use 0/1/2 here.
 */

import { EventName, IBApi } from "@stoqey/ib";

/** Provider codes for the Dow Jones + Briefing bundles the account subscribes to. */
export const DJ_PROVIDER_CODES =
  "BRFG+BRFUPDN+DJ-N+DJ-RT+DJ-RTA+DJ-RTE+DJ-RTG+DJNL";

/** clientId reserved for this spike. 0=TWS GUI, 1=Vanguard Skin, 2=Stock Contest. */
export const SPIKE_CLIENT_ID = 9;

export interface NewsHeadline {
  /** TWS-reported timestamp string, e.g. "2026-06-03 20:05:12.0" (UTC). */
  time: string;
  providerCode: string;
  articleId: string;
  headline: string;
}

export interface NewsArticleBody {
  /** 0 = plain text / HTML, 1 = binary (base64 PDF). */
  articleType: number;
  text: string;
}

/**
 * Format a Date as the "yyyy-MM-dd HH:mm:ss.0" string TWS wants for
 * historical-news boundaries. TWS treats these as UTC when no timezone
 * suffix is supplied, so we build them from the UTC getters.
 */
export function formatTwsDateTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.0`
  );
}

/** Parse a TWS news timestamp ("2026-06-03 20:05:12.0") into a real Date (UTC). */
export function parseTwsDateTime(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  return new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    ),
  );
}

let reqIdSeq = 7000;
function nextReqId(): number {
  reqIdSeq += 1;
  return reqIdSeq;
}

/**
 * Open a dedicated socket to TWS on clientId 9 and resolve once TWS has
 * handed us a nextValidId (the reliable "session is live" signal — the
 * `connected` event fires before the handshake completes).
 */
export function connectNewsApi(options?: {
  host?: string;
  port?: number;
  clientId?: number;
  timeoutMs?: number;
}): Promise<IBApi> {
  const host = options?.host ?? "127.0.0.1";
  const port = options?.port ?? 7496;
  const clientId = options?.clientId ?? SPIKE_CLIENT_ID;
  const timeoutMs = options?.timeoutMs ?? 15_000;

  if (clientId === 0 || clientId === 1 || clientId === 2) {
    throw new Error(
      `Refusing clientId ${clientId}: reserved (0=TWS GUI, 1=Vanguard Skin, 2=Stock Contest)`,
    );
  }

  const api = new IBApi({ host, port, clientId });

  return new Promise<IBApi>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try {
        api.disconnect();
      } catch {
        /* ignore */
      }
      reject(new Error(`TWS connect timeout (${timeoutMs / 1000}s) on ${host}:${port}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      api.removeListener(EventName.nextValidId, onReady);
      api.removeListener(EventName.error, onError);
    }

    function onReady() {
      cleanup();
      resolve(api);
    }

    // Only CONNECTION-level errors (reqId -1) should fail the connect.
    function onError(err: Error, code: number, reqId: number) {
      if (reqId !== -1) return;
      // 2104/2106/2158 are "market data farm OK" info messages, not failures.
      if (code >= 2100 && code < 2200) return;
      cleanup();
      try {
        api.disconnect();
      } catch {
        /* ignore */
      }
      reject(new Error(`TWS connect error [${code}]: ${err.message}`));
    }

    api.on(EventName.nextValidId, onReady);
    api.on(EventName.error, onError);
    api.connect(clientId);
  });
}

/**
 * One reqHistoricalNews round-trip.
 *
 * QUIRK (verified live 2026-08-20): despite the parameter NAMES, the FIRST
 * datetime is the RECENT boundary and results walk BACKWARD from it toward
 * the second datetime. So pass `startDateTime` = now-ish and
 * `endDateTime` = the older edge of the window you care about.
 */
export function reqHistoricalNewsOnce(
  api: IBApi,
  args: {
    conId: number;
    providerCodes?: string;
    /** RECENT boundary (see quirk note). */
    startDateTime: string;
    /** OLDER boundary (see quirk note). */
    endDateTime: string;
    totalResults?: number;
    timeoutMs?: number;
  },
): Promise<NewsHeadline[]> {
  const reqId = nextReqId();
  const timeoutMs = args.timeoutMs ?? 25_000;

  return new Promise<NewsHeadline[]>((resolve, reject) => {
    const out: NewsHeadline[] = [];

    const timer = setTimeout(() => {
      cleanup();
      // Partial results are still data — resolve rather than throw away work.
      if (out.length > 0) resolve(out);
      else reject(new Error(`reqHistoricalNews timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      api.removeListener(EventName.historicalNews, onNews);
      api.removeListener(EventName.historicalNewsEnd, onEnd);
      api.removeListener(EventName.error, onError);
    }

    function onNews(
      id: number,
      time: string,
      providerCode: string,
      articleId: string,
      headline: string,
    ) {
      if (id !== reqId) return;
      out.push({ time, providerCode, articleId, headline });
    }

    function onEnd(id: number) {
      if (id !== reqId) return;
      cleanup();
      resolve(out);
    }

    function onError(err: Error, code: number, id: number) {
      if (id !== reqId) return;
      cleanup();
      reject(new Error(`reqHistoricalNews error [${code}]: ${err.message}`));
    }

    api.on(EventName.historicalNews, onNews);
    api.on(EventName.historicalNewsEnd, onEnd);
    api.on(EventName.error, onError);

    api.reqHistoricalNews(
      reqId,
      args.conId,
      args.providerCodes ?? DJ_PROVIDER_CODES,
      args.startDateTime,
      args.endDateTime,
      args.totalResults ?? 300,
    );
  });
}

/** One reqNewsArticle round-trip (fetch a headline's full body). */
export function reqNewsArticleOnce(
  api: IBApi,
  args: { providerCode: string; articleId: string; timeoutMs?: number },
): Promise<NewsArticleBody> {
  const reqId = nextReqId();
  const timeoutMs = args.timeoutMs ?? 25_000;

  return new Promise<NewsArticleBody>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`reqNewsArticle timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      api.removeListener(EventName.newsArticle, onArticle);
      api.removeListener(EventName.error, onError);
    }

    function onArticle(id: number, articleType: number, articleText: string) {
      if (id !== reqId) return;
      cleanup();
      resolve({ articleType, text: articleText });
    }

    function onError(err: Error, code: number, id: number) {
      if (id !== reqId) return;
      cleanup();
      reject(new Error(`reqNewsArticle error [${code}]: ${err.message}`));
    }

    api.on(EventName.newsArticle, onArticle);
    api.on(EventName.error, onError);
    api.reqNewsArticle(reqId, args.providerCode, args.articleId);
  });
}

// ---------------------------------------------------------------------------
// Multi-part press-release stitching
// ---------------------------------------------------------------------------

/**
 * Dow Jones splits long press releases across numbered headlines: the base
 * headline, then " -2-", " -3-", … Parts share the same minute.
 *
 * VERIFIED LIVE (2026-08-20, CRWD 2026-06-03): the continuation headlines are
 * TRUNCATED copies of the base, e.g.
 *   part 1: "Press Release: CrowdStrike Reports First Quarter Fiscal Year 2027 Financial Results"
 *   part 2: "Press Release: CrowdStrike Reports First Quarter -2-"
 * so a fixed-length prefix key does NOT group them. We instead group on
 * PREFIX CONTAINMENT (one normalized headline is a prefix of the other),
 * keeping the shortest form as the group key.
 *
 * Every headline also carries a metadata prefix like "{A:800015:L:en}" that
 * must be stripped BEFORE any "Press Release:" / "*" test.
 */

export interface PressHeadline extends NewsHeadline {
  /** Part number parsed from a trailing " -N-" (1 when absent). */
  partNumber: number;
  /** Headline with the "{...}" metadata prefix and " -N-" suffix removed. */
  baseHeadline: string;
  /** Lowercased, whitespace-collapsed baseHeadline minus the "Press Release:" label. */
  norm: string;
}

const PART_SUFFIX_RE = /\s*-(\d+)-\s*$/;
/** DJ metadata prefix, e.g. "{A:800015:L:en}". */
const META_PREFIX_RE = /^\s*\{[^}]*\}\s*/;
/** Parts of one release share a minute; allow slack for a straddling release. */
const GROUP_TIME_TOLERANCE_MS = 3 * 60_000;
/** Don't group on a normalized headline shorter than this (too generic). */
const MIN_GROUP_KEY_LEN = 12;

/** Remove the "{A:800015:L:en}"-style metadata prefix DJ puts on every headline. */
export function stripHeadlineMeta(headline: string): string {
  return headline.replace(META_PREFIX_RE, "").trim();
}

export function parsePressHeadline(h: NewsHeadline): PressHeadline {
  const stripped = stripHeadlineMeta(h.headline);
  const m = PART_SUFFIX_RE.exec(stripped);
  const partNumber = m ? Number(m[1]) : 1;
  const baseHeadline = m ? stripped.replace(PART_SUFFIX_RE, "") : stripped;
  const norm = baseHeadline
    .replace(/^\s*Press Release:\s*/i, "")
    .replace(/^\s*\(PR\)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return { ...h, partNumber, baseHeadline, norm };
}

/** True for headlines that look like a verbatim press release (not a flash/story). */
export function isPressRelease(headline: string): boolean {
  const h = stripHeadlineMeta(headline);
  return /^press release:/i.test(h) || /^\(PR\)/i.test(h) || /\(PR\)\s*$/i.test(h);
}

/**
 * True for DJ flash bullets — "*" / "!*" prefixed one-liners such as
 * "* CrowdStrike Holdings 1Q Rev $1.39B >CRWD". The metadata prefix sits
 * BEFORE the asterisk, so strip it first.
 */
export function isFlash(headline: string): boolean {
  return /^!?\*/.test(stripHeadlineMeta(headline));
}

/**
 * Group press-release headlines into releases, each sorted by part number.
 * Grouping is by provider + near-identical timestamp + prefix containment.
 */
export function groupReleaseParts(headlines: NewsHeadline[]): PressHeadline[][] {
  const parsed = headlines
    .map(parsePressHeadline)
    .filter((p) => isPressRelease(p.headline) && p.norm.length >= MIN_GROUP_KEY_LEN);

  const groups: {
    key: string;
    time: number;
    provider: string;
    parts: PressHeadline[];
  }[] = [];

  for (const p of parsed) {
    const t = parseTwsDateTime(p.time)?.getTime() ?? 0;
    let g = groups.find(
      (cand) =>
        cand.provider === p.providerCode &&
        Math.abs(cand.time - t) <= GROUP_TIME_TOLERANCE_MS &&
        (cand.key.startsWith(p.norm) || p.norm.startsWith(cand.key)),
    );
    if (!g) {
      g = { key: p.norm, time: t, provider: p.providerCode, parts: [] };
      groups.push(g);
    } else if (p.norm.length < g.key.length) {
      // Keep the shortest form so later (more truncated) parts still match.
      g.key = p.norm;
    }
    g.parts.push(p);
  }

  for (const g of groups) g.parts.sort((a, b) => a.partNumber - b.partNumber);
  return groups.map((g) => g.parts);
}

/** Separator between the capture header and the concatenated release body. */
export const BODY_MARKER = "=== BODY ===";

/**
 * Fetch every part's body and concatenate in part order.
 *
 * VERIFIED (CRWD 2026-06-03): DJ parts do NOT overlap — each is a distinct
 * continuation that ends with the same boilerplate disclaimer footer, so plain
 * concatenation is correct (no dedupe needed). Distinctive body phrases appear
 * exactly once across the 7-part stitch.
 *
 * The article body carries NO headline — DJ keeps that in headline metadata
 * only — so we prepend a header block to make the saved artifact
 * self-describing. `body` is the text after that header.
 */
export async function stitchRelease(
  api: IBApi,
  parts: PressHeadline[],
  onPart?: (part: PressHeadline, chars: number) => void,
): Promise<{
  text: string;
  header: string;
  body: string;
  partsFetched: number;
  failures: string[];
}> {
  const chunks: string[] = [];
  const failures: string[] = [];
  let partsFetched = 0;

  for (const part of parts) {
    try {
      const article = await reqNewsArticleOnce(api, {
        providerCode: part.providerCode,
        articleId: part.articleId,
      });
      const text =
        article.articleType === 1
          ? `[binary article type=1, base64 length ${article.text.length}]`
          : article.text;
      chunks.push(text);
      partsFetched += 1;
      onPart?.(part, text.length);
    } catch (err) {
      failures.push(
        `part ${part.partNumber} (${part.articleId}): ${(err as Error).message}`,
      );
    }
  }

  const body = chunks.join("\n\n");
  const header = [
    "=== DJ PRESS RELEASE CAPTURE ===",
    `headline:    ${parts[0].baseHeadline}`,
    `provider:    ${parts[0].providerCode}`,
    `dj_time:     ${parts[0].time}  (UTC, minute resolution)`,
    `parts:       ${partsFetched}/${parts.length} fetched — ${parts
      .map((p) => `${p.partNumber}:${p.articleId}`)
      .join(", ")}`,
    `captured_at: ${new Date().toISOString()}`,
    failures.length > 0 ? `failures:    ${failures.join(" | ")}` : "failures:    none",
    BODY_MARKER,
  ].join("\n");

  return { text: `${header}\n${body}`, header, body, partsFetched, failures };
}
