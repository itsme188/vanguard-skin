/**
 * Dow Jones news adapter for print-watch (Task 6).
 *
 * Ports the proven mechanics from `scripts/spike-print-tws-news.ts` (a
 * throwaway measurement tool, verified live 2026-08-20 against CRWD, HD,
 * and others captured in `tests/fixtures/real/bakeoff/`) into product code:
 *
 *  - the "{A:800015:L:en}" metadata prefix DJ puts on every headline, which
 *    must be stripped before any "Press Release:" / "*" classification.
 *  - the BACKWARD-WALK QUIRK: despite the parameter names, the FIRST
 *    datetime given to `reqHistoricalNews` is the RECENT boundary and
 *    results walk backward from it toward the second (older) datetime —
 *    and can walk PAST that older boundary. The window is therefore
 *    enforced client-side, never trusted from the API call alone.
 *  - PART GROUPING BY PREFIX CONTAINMENT: DJ splits long releases across
 *    numbered headlines, but continuation headlines are TRUNCATED copies
 *    of the base ("Press Release: CrowdStrike Reports First Quarter -2-"
 *    vs the full "...Reports First Quarter Fiscal Year 2027 Financial
 *    Results"), so a fixed-length prefix key does not group them — we
 *    group on containment (one normalized headline is a prefix of the
 *    other), keeping the SHORTEST form seen as the group key.
 *  - body fetch + PLAIN CONCATENATION — DJ parts never overlap.
 *
 * IBApiNext has no promise wrappers for reqHistoricalNews / reqNewsArticle
 * (the same situation `lib/tws/wsh.ts` documents for WSH), so this module
 * is injected the raw IBApi-shaped connection rather than opening its own
 * socket — it shares the app's ONE TWS connection (no second clientId).
 *
 * INTERFACE CONTRACT for callers (Task 9's watcher): `windowStartUtc` and
 * `nowUtc` are TWS wire-format datetime strings — "yyyy-MM-dd HH:mm:ss.0",
 * UTC, exactly the format `reqHistoricalNews` itself expects and that the
 * `historicalNews` event's own `time` field uses. Use `formatTwsDateTime`
 * (exported below) to build them from a `Date`. This module never touches
 * a Date/ISO string — the TWS format is the single currency throughout, so
 * the client-side window filter can compare `time` fields directly against
 * the same two boundary strings with no conversion.
 */

/** Provider codes for the Dow Jones + Briefing bundles the account subscribes to. */
export const DJ_PROVIDER_CODES =
  "BRFG+BRFUPDN+DJ-N+DJ-RT+DJ-RTA+DJ-RTE+DJ-RTG+DJNL";

/** A part group completes only once its part set has been stable this long. */
const QUIESCENCE_MS = 20_000;

/** The completed release's headline must look like an earnings print. */
const EARNINGS_HEADLINE_RE = /results|quarter|fiscal|earnings/i;

/** DJ metadata prefix, e.g. "{A:800015:L:en}". */
const META_PREFIX_RE = /^\s*\{[^}]*\}\s*/;
/** Trailing " -N-" continuation marker DJ appends to part 2+. */
const PART_SUFFIX_RE = /\s*-(\d+)-\s*$/;
/** Don't group on a normalized headline shorter than this (too generic). */
const MIN_GROUP_KEY_LEN = 12;

/** ReqIds reserved for this adapter (verified clear of lib/tws/ usage). */
const REQ_ID_MIN = 41_000;
const REQ_ID_MAX = 41_999;

let reqIdSeq = REQ_ID_MIN;
function nextReqId(): number {
  const id = reqIdSeq;
  reqIdSeq = id + 1 > REQ_ID_MAX ? REQ_ID_MIN : id + 1;
  return id;
}

/**
 * Minimal shape of the raw @stoqey/ib `IBApi` this module needs, defined
 * locally (rather than importing `IBApi`) so tests can drive a plain fake —
 * no live TWS socket required. A real `IBApi` instance satisfies this
 * structurally (see `lib/tws/wsh.ts`'s `getRawApi()` for how production
 * code pulls it off `IBApiNext`).
 */
export interface IBApiLike {
  reqHistoricalNews(
    reqId: number,
    conId: number,
    providerCodes: string,
    startDateTime: string,
    endDateTime: string,
    totalResults: number,
  ): void;
  reqNewsArticle(reqId: number, providerCode: string, articleId: string): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

interface RawHeadline {
  /** TWS-format timestamp, e.g. "2026-06-03 20:05:00.0" (UTC). */
  time: string;
  providerCode: string;
  articleId: string;
  headline: string;
}

export interface DjPollState {
  seenArticleIds: Set<string>;
  partGroups: Map<
    string,
    { headlines: string[]; articleIds: string[]; lastGrewAtMs: number }
  >;
}

export interface DjPollOutput {
  completedReleases: Array<{ headline: string; stitchedText: string; partCount: number }>;
  flashes: Array<{ time: string; headline: string }>;
}

export function createDjPollState(): DjPollState {
  return { seenArticleIds: new Set(), partGroups: new Map() };
}

/**
 * Format a Date as the "yyyy-MM-dd HH:mm:ss.0" string TWS wants for
 * historical-news boundaries (built from the UTC getters — TWS treats
 * these as UTC when no timezone suffix is supplied).
 */
export function formatTwsDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.0`
  );
}

/** Parse a TWS news timestamp ("2026-06-03 20:05:00.0") into epoch ms (UTC). */
function parseTwsDateTimeMs(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  );
}

/** Strip the "{A:800015:L:en}"-style metadata prefix DJ puts on every headline. */
function stripHeadlineMeta(headline: string): string {
  return headline.replace(META_PREFIX_RE, "").trim();
}

/** DJ flash bullets — "*" / "!*" prefixed one-liners. Metadata prefix must be stripped first. */
function isFlash(stripped: string): boolean {
  return /^!?\*/.test(stripped);
}

/** Headlines that look like a verbatim press release (not a flash/story). */
function isPressRelease(stripped: string): boolean {
  return (
    /^press release:/i.test(stripped) ||
    /^\(pr\)/i.test(stripped) ||
    /\(pr\)\s*$/i.test(stripped)
  );
}

function parsePartNumber(stripped: string): { partNumber: number; baseHeadline: string } {
  const m = PART_SUFFIX_RE.exec(stripped);
  if (!m) return { partNumber: 1, baseHeadline: stripped };
  return { partNumber: Number(m[1]), baseHeadline: stripped.replace(PART_SUFFIX_RE, "") };
}

/** Lowercased, whitespace-collapsed baseHeadline minus the "Press Release:" label — the grouping key. */
function normKey(baseHeadline: string): string {
  return baseHeadline
    .replace(/^\s*Press Release:\s*/i, "")
    .replace(/^\s*\(PR\)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** DJ articleIds are "{providerCode}${hex}" (e.g. "DJ-N$1e9d7cb2") — the provider code is embedded. */
function providerCodeFromArticleId(articleId: string): string {
  const i = articleId.indexOf("$");
  return i === -1 ? "" : articleId.slice(0, i);
}

function reqHistoricalNewsOnce(
  ib: IBApiLike,
  args: { conId: number; startDateTime: string; endDateTime: string; totalResults?: number; timeoutMs?: number },
): Promise<RawHeadline[]> {
  const reqId = nextReqId();
  const timeoutMs = args.timeoutMs ?? 25_000;

  return new Promise<RawHeadline[]>((resolve, reject) => {
    const out: RawHeadline[] = [];

    const timer = setTimeout(() => {
      cleanup();
      // Partial results are still data — resolve rather than throw away work.
      if (out.length > 0) resolve(out);
      else reject(new Error(`reqHistoricalNews timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      ib.removeListener("historicalNews", onNews);
      ib.removeListener("historicalNewsEnd", onEnd);
      ib.removeListener("error", onError);
    }

    function onNews(...args: unknown[]) {
      const [id, time, providerCode, articleId, headline] = args as [number, string, string, string, string];
      if (id !== reqId) return;
      out.push({ time, providerCode, articleId, headline });
    }

    function onEnd(...args: unknown[]) {
      const [id] = args as [number];
      if (id !== reqId) return;
      cleanup();
      resolve(out);
    }

    function onError(...args: unknown[]) {
      const [err, code, id] = args as [Error, number, number];
      if (id !== reqId) return;
      cleanup();
      reject(new Error(`reqHistoricalNews error [${code}]: ${err.message}`));
    }

    ib.on("historicalNews", onNews);
    ib.on("historicalNewsEnd", onEnd);
    ib.on("error", onError);

    ib.reqHistoricalNews(
      reqId,
      args.conId,
      DJ_PROVIDER_CODES,
      args.startDateTime,
      args.endDateTime,
      args.totalResults ?? 300,
    );
  });
}

function reqNewsArticleOnce(
  ib: IBApiLike,
  args: { providerCode: string; articleId: string; timeoutMs?: number },
): Promise<string> {
  const reqId = nextReqId();
  const timeoutMs = args.timeoutMs ?? 25_000;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`reqNewsArticle timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      ib.removeListener("newsArticle", onArticle);
      ib.removeListener("error", onError);
    }

    function onArticle(...args: unknown[]) {
      const [id, articleType, articleText] = args as [number, number, string];
      if (id !== reqId) return;
      cleanup();
      resolve(articleType === 1 ? `[binary article type=1, base64 length ${articleText.length}]` : articleText);
    }

    function onError(...args: unknown[]) {
      const [err, code, id] = args as [Error, number, number];
      if (id !== reqId) return;
      cleanup();
      reject(new Error(`reqNewsArticle error [${code}]: ${err.message}`));
    }

    ib.on("newsArticle", onArticle);
    ib.on("error", onError);
    ib.reqNewsArticle(reqId, args.providerCode, args.articleId);
  });
}

/**
 * One poll cycle: fetch historical news for the window, extract flashes,
 * accumulate press-release parts into groups, and stitch+emit any group
 * that has gone quiescent (no new part for >= 20s).
 *
 * `windowStartUtc`/`nowUtc` are TWS wire-format strings (see module header).
 * `nowMs` is a plain epoch-ms clock reading, independent of the two window
 * strings, used only to drive the quiescence timer — callers pass a fresh
 * `Date.now()` (or a fixed value in tests) each poll.
 */
export async function pollDjNews(
  ib: IBApiLike,
  conId: number,
  windowStartUtc: string,
  nowUtc: string,
  state: DjPollState,
  nowMs: number,
): Promise<DjPollOutput> {
  const windowStartMs = parseTwsDateTimeMs(windowStartUtc);
  const windowEndMs = parseTwsDateTimeMs(nowUtc);

  // QUIRK: first param = RECENT boundary, second = OLDER boundary.
  const raw = await reqHistoricalNewsOnce(ib, {
    conId,
    startDateTime: nowUtc,
    endDateTime: windowStartUtc,
  });

  // Results can walk PAST the older boundary — enforce the window client-side.
  const inWindow = raw.filter((h) => {
    const t = parseTwsDateTimeMs(h.time);
    if (t === null) return false;
    if (windowStartMs !== null && t < windowStartMs) return false;
    if (windowEndMs !== null && t > windowEndMs) return false;
    return true;
  });

  const flashes: DjPollOutput["flashes"] = [];

  // Article ids already tracked by an in-progress group, from ANY prior
  // poll — reqHistoricalNews returns the full window every call (it is not
  // incremental), so without this a still-growing group's old parts would
  // look "new" again every poll and its quiescence timer would never fire.
  const alreadyGrouped = new Set<string>();
  for (const g of state.partGroups.values()) {
    for (const id of g.articleIds) alreadyGrouped.add(id);
  }

  for (const h of inWindow) {
    if (state.seenArticleIds.has(h.articleId)) continue;
    const stripped = stripHeadlineMeta(h.headline);

    if (isFlash(stripped)) {
      flashes.push({ time: h.time, headline: stripped });
      state.seenArticleIds.add(h.articleId);
      continue;
    }

    if (!isPressRelease(stripped)) continue; // not a headline shape this adapter tracks
    if (alreadyGrouped.has(h.articleId)) continue; // already a member of a tracked group

    const { baseHeadline } = parsePartNumber(stripped);
    const key = normKey(baseHeadline);
    if (key.length < MIN_GROUP_KEY_LEN) continue;

    let matchedKey: string | undefined;
    for (const k of state.partGroups.keys()) {
      if (k.startsWith(key) || key.startsWith(k)) {
        matchedKey = k;
        break;
      }
    }

    if (matchedKey) {
      const g = state.partGroups.get(matchedKey)!;
      g.headlines.push(stripped);
      g.articleIds.push(h.articleId);
      g.lastGrewAtMs = nowMs;
      if (key.length < matchedKey.length) {
        // Keep the shortest form so a later, more-truncated part still matches.
        state.partGroups.delete(matchedKey);
        state.partGroups.set(key, g);
      }
    } else {
      state.partGroups.set(key, { headlines: [stripped], articleIds: [h.articleId], lastGrewAtMs: nowMs });
    }
    alreadyGrouped.add(h.articleId);
  }

  // Quiescence sweep: complete (and remove) any group untouched for >= 20s.
  const completedReleases: DjPollOutput["completedReleases"] = [];
  for (const [key, g] of Array.from(state.partGroups.entries())) {
    if (nowMs - g.lastGrewAtMs < QUIESCENCE_MS) continue;

    state.partGroups.delete(key);
    for (const id of g.articleIds) state.seenArticleIds.add(id);

    const parts = g.headlines
      .map((stripped, i) => {
        const { partNumber, baseHeadline } = parsePartNumber(stripped);
        return { partNumber, baseHeadline, articleId: g.articleIds[i] };
      })
      .sort((a, b) => a.partNumber - b.partNumber);
    if (parts.length === 0) continue;

    // The fullest (longest, i.e. untruncated) form is the human-readable title.
    const headline = parts.reduce(
      (longest, p) => (p.baseHeadline.length > longest.length ? p.baseHeadline : longest),
      parts[0].baseHeadline,
    );

    if (!EARNINGS_HEADLINE_RE.test(headline)) continue; // distractor — drop silently, never emit

    const chunks: string[] = [];
    for (const part of parts) {
      const providerCode = providerCodeFromArticleId(part.articleId);
      const text = await reqNewsArticleOnce(ib, { providerCode, articleId: part.articleId });
      chunks.push(text);
    }

    completedReleases.push({
      headline,
      stitchedText: chunks.join("\n\n"),
      partCount: parts.length,
    });
  }

  return { completedReleases, flashes };
}
