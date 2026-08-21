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
 *  - PART GROUPING BY PREFIX CONTAINMENT, GATED BY PROVIDER + TIME: DJ
 *    splits long releases across numbered headlines, but continuation
 *    headlines are TRUNCATED copies of the base ("Press Release:
 *    CrowdStrike Reports First Quarter -2-" vs the full "...Reports First
 *    Quarter Fiscal Year 2027 Financial Results"), so a fixed-length prefix
 *    key does not group them — we group on containment (one normalized
 *    headline is a prefix of the other), keeping the SHORTEST form seen as
 *    the group's matching key. Containment ALONE is too permissive — two
 *    UNRELATED releases can share a truncated-headline prefix — so a
 *    candidate must also match the group's provider code exactly and land
 *    within 3 minutes of the group's anchor (first-part) time, same gate
 *    the spike used (review finding, fix round 1).
 *  - body fetch + PLAIN CONCATENATION — DJ parts never overlap. All part
 *    bodies for a group are fetched BEFORE any state mutation; if any part
 *    fetch fails, the group is left untouched (not removed, not marked
 *    seen) so it is retried whole on the next poll rather than silently
 *    losing the release or corrupting `seenArticleIds` (review finding,
 *    fix round 1 — the spike's own per-part try/catch partial-stitch
 *    precedent was rejected here in favor of full retry, since this module
 *    polls repeatedly and the spike was a one-shot tool).
 *  - CALLER-OWNS-SEEN (fix wave, finding F): the same "leave it in state
 *    until it is genuinely done" rule now extends past the fetch to the
 *    CONSUMER. Emitting no longer marks anything seen or removes the group;
 *    the caller marks each article id once it has ingested the release (or
 *    taken the flash), and a group whose parts are all marked is retired at
 *    the top of the next poll. A caller whose ingest fails gets the release
 *    again instead of losing it for the life of the runtime.
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

/** Parts of one release share a minute; allow slack for a straddling release. */
const GROUP_TIME_TOLERANCE_MS = 3 * 60_000;

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

/**
 * DEVIATION from the brief's literal snippet (flagged for Task 9, same
 * practice as Task 1's PrintRow/DocumentRow addition): the part-group value
 * adds `providerCode` and `anchorTimeMs`, both captured from the group's
 * FIRST part and never updated afterward. They restore the spike's grouping
 * safety net (provider equality + |Δtime| <= 3min) that pure prefix-
 * containment matching drops — two distinct releases that happen to share a
 * truncated-headline prefix (different provider, or minutes apart) must not
 * merge into one bogus stitch (review finding, fix round 1). The Map's own
 * key is the articleId of the part that created the group (a stable, always-
 * unique identity) — it is never a good idea to key the Map by mutable
 * headline text, since two DISTINCT groups can normalize to the identical
 * text (that's exactly the case this gate exists to keep separate).
 */
export interface DjPollState {
  seenArticleIds: Set<string>;
  partGroups: Map<
    string,
    {
      headlines: string[];
      articleIds: string[];
      lastGrewAtMs: number;
      providerCode: string;
      anchorTimeMs: number;
    }
  >;
}

/**
 * CALLER-OWNS-SEEN (fix wave, finding F). Everything this adapter HANDS BACK
 * carries the article ids behind it, and the adapter does not mark them:
 * `seenArticleIds` is the caller's record of what it has CONSUMED, and only
 * the caller knows whether ingesting the bytes worked. Marking at emit time
 * meant one failed `ingestDocument` lost the release for the life of the
 * runtime — the same class of bug fixed for the IR and EDGAR adapters.
 *
 * The adapter still marks (and drops) what it will NEVER hand over: a
 * quiescent group whose headline is not an earnings print.
 */
export interface DjPollOutput {
  completedReleases: Array<{
    headline: string;
    stitchedText: string;
    partCount: number;
    /** Every part's article id — the caller marks these once it has ingested
     *  the stitched release, which is also what retires the part group. */
    articleIds: string[];
  }>;
  flashes: Array<{ time: string; headline: string; articleId: string }>;
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

/**
 * The group's current (shortest-seen) normalized key, recomputed on demand
 * from its stored headlines rather than tracked as a separately-maintained
 * field — cheap given groups are a handful of parts, and it can never drift
 * out of sync with `headlines[]`.
 */
function currentGroupKey(g: { headlines: string[] }): string {
  let shortest = "";
  for (const stripped of g.headlines) {
    const { baseHeadline } = parsePartNumber(stripped);
    const k = normKey(baseHeadline);
    if (shortest === "" || k.length < shortest.length) shortest = k;
  }
  return shortest;
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

  // Retire the groups the caller has CONSUMED (finding F). A completed group
  // is left in state when it is emitted, precisely so a caller whose ingest
  // failed gets it again on the next poll; what tells us the release actually
  // landed is its parts appearing in `seenArticleIds`, which only the caller
  // writes. This is the same "leave it in state until it is genuinely done"
  // rule the part-fetch failure path has always used.
  for (const [mapKey, g] of Array.from(state.partGroups.entries())) {
    if (g.articleIds.every((id) => state.seenArticleIds.has(id))) state.partGroups.delete(mapKey);
  }

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
      // Handed over UNMARKED — the watcher marks it once the bullet is in the
      // flash lane's batch (finding F).
      flashes.push({ time: h.time, headline: stripped, articleId: h.articleId });
      continue;
    }

    if (!isPressRelease(stripped)) continue; // not a headline shape this adapter tracks
    if (alreadyGrouped.has(h.articleId)) continue; // already a member of a tracked group

    const { baseHeadline } = parsePartNumber(stripped);
    const key = normKey(baseHeadline);
    if (key.length < MIN_GROUP_KEY_LEN) continue;

    const candidateTimeMs = parseTwsDateTimeMs(h.time) ?? nowMs;

    // Grouping gate (review finding, fix round 1): prefix containment ALONE
    // is not enough — two distinct releases can share a truncated-headline
    // prefix. Require same provider AND a timestamp within 3 minutes of the
    // group's anchor (its first part), same as the spike.
    let matchedKey: string | undefined;
    for (const [k, g] of state.partGroups) {
      if (g.providerCode !== h.providerCode) continue;
      if (Math.abs(candidateTimeMs - g.anchorTimeMs) > GROUP_TIME_TOLERANCE_MS) continue;
      const gKey = currentGroupKey(g);
      if (gKey.startsWith(key) || key.startsWith(gKey)) {
        matchedKey = k;
        break;
      }
    }

    if (matchedKey) {
      const g = state.partGroups.get(matchedKey)!;
      g.headlines.push(stripped);
      g.articleIds.push(h.articleId);
      g.lastGrewAtMs = nowMs;
    } else {
      // Keyed by this (creating) part's own articleId — a stable, always-
      // unique identity, so two distinct groups can never collide even when
      // their normalized headline text is identical (see DjPollState doc).
      state.partGroups.set(h.articleId, {
        headlines: [stripped],
        articleIds: [h.articleId],
        lastGrewAtMs: nowMs,
        providerCode: h.providerCode,
        anchorTimeMs: candidateTimeMs,
      });
    }
    alreadyGrouped.add(h.articleId);
  }

  // Quiescence sweep: complete (and remove) any group untouched for >= 20s.
  const completedReleases: DjPollOutput["completedReleases"] = [];
  for (const [mapKey, g] of Array.from(state.partGroups.entries())) {
    if (nowMs - g.lastGrewAtMs < QUIESCENCE_MS) continue;

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

    if (!EARNINGS_HEADLINE_RE.test(headline)) {
      // Distractor — will never pass this regex no matter how often we
      // retry, so drop for good: remove + mark seen, never emit. The adapter
      // marks here precisely BECAUSE this never reaches the caller (same rule
      // as the IR adapter's newsroom noise).
      state.partGroups.delete(mapKey);
      for (const id of g.articleIds) state.seenArticleIds.add(id);
      continue;
    }

    // CRITICAL (review finding, fix round 1): fetch every part's body
    // BEFORE mutating state. A single failing part must not throw the whole
    // poll (losing other completed releases / flashes from the same call),
    // and must not poison seenArticleIds — leaving the group untouched here
    // makes it retryable on the next poll (still quiescent, so the sweep
    // retries it immediately).
    let chunks: string[];
    try {
      chunks = [];
      for (const part of parts) {
        const text = await reqNewsArticleOnce(ib, { providerCode: g.providerCode, articleId: part.articleId });
        chunks.push(text);
      }
    } catch {
      continue; // leave the group in state — retried next poll
    }

    // Emitted, NOT retired (finding F). The group stays in state and its parts
    // stay unmarked until the caller reports back by marking them seen; an
    // ingest that failed therefore gets the whole release again next poll,
    // exactly like a part-fetch failure does.
    completedReleases.push({
      headline,
      stitchedText: chunks.join("\n\n"),
      partCount: parts.length,
      articleIds: parts.map((p) => p.articleId),
    });
  }

  return { completedReleases, flashes };
}
