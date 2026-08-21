// IR (investor-relations) newsroom RSS adapter — NVDA only in v1 (spec
// 2026-08-20 §5, Task 8). NVDA does not post its verbatim quarterly release
// on the Dow Jones wire (Task 6's dj-adapter), so this is the only source
// for the exact NVDA release document.
//
// Findings this consumes from the measurement spike
// (`scripts/spike-print-timestamp-harness.ts`, `IrFeedSource`):
//   - Feed: https://nvidianews.nvidia.com/cats/press_release.xml
//   - NVIDIA's newsroom sits behind Varnish with a ~300s default TTL and no
//     Cache-Control from origin — every feed request MUST carry a fresh
//     `?zz=<random>` cache-buster or a 15s poll can silently re-read a copy
//     up to 5 minutes stale.
//   - Items carry a `<modDate>` that is a more reliable recency signal than
//     feed document order (edits bump modDate without moving the item).
//   - The quarterly-results item is distinguished from newsroom noise (e.g.
//     "NVIDIA Sets Conference Call to Discuss Financial Results for Second
//     Quarter Fiscal 2027") only by title regex.
//
// Hardening (Codex #24 — this adapter fetches attacker-reachable content: a
// newsroom feed and the article pages it links to):
//   - `redirect: "manual"` on every fetch; a 3xx is followed only after the
//     Location header revalidates to the SAME host as the config, max 2 hops.
//   - `content-length` precheck (reject before reading) AND a streamed byte
//     cap enforced while reading (a missing/lying content-length must not
//     bypass the cap).
//   - Response content-type must look like XML or HTML.
//   - RSS item `<link>` values are only trusted when they resolve to the
//     config's host — an off-host link is dropped, never fetched.
//   - RSS items are extracted via regex/string ops — no XML parser dependency
//     (per plan: no new deps for this task).
//
// Per-host request spacing (SEC 300ms / others 200ms) is the WATCHER's job
// (Task 9's shared spacer) — this module has no polling loop or timers of
// its own; callers own cadence and pass a fresh `seenLinks` Set they persist.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface IrRssConfig {
  symbol: string;
  /** Newsroom RSS feed URL. */
  feedUrl: string;
  /** Host every feed request, item link, and redirect target must stay on. */
  host: string;
  /** Title must match this regex to count as the quarterly results release. */
  titleRegex: RegExp;
}

export const IR_RSS_CONFIGS: IrRssConfig[] = [
  {
    symbol: "NVDA",
    feedUrl: "https://nvidianews.nvidia.com/cats/press_release.xml",
    host: "nvidianews.nvidia.com",
    titleRegex:
      /NVIDIA Announces Financial Results for (First|Second|Third|Fourth) Quarter( and)? Fiscal 20\d\d/i,
  },
];

const MAX_BYTES = 2 * 1024 * 1024; // 2MB cap, both precheck and streamed
const MAX_REDIRECT_HOPS = 2;

interface RssItem {
  title: string;
  link: string;
  pubDate?: string;
  modDate?: string;
}

/**
 * NVIDIA's newsroom is Varnish-cached (~300s TTL, no origin Cache-Control).
 * Every feed request gets a fresh nonce so a fast poll loop never re-reads a
 * stale cached copy.
 */
function bust(url: string): string {
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  return url.includes("?") ? `${url}&zz=${nonce}` : `${url}?zz=${nonce}`;
}

function isSameHost(url: string, host: string): boolean {
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

/** RSS `<item>` extraction via regex/string ops — no XML dependency. */
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

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/** modDate is the reliable recency signal (harness finding) — feed document
 *  order is not guaranteed across cache-busted polls. Falls back to pubDate,
 *  then treats a dateless item as oldest. */
function sortByModDateDesc(items: RssItem[]): RssItem[] {
  return [...items].sort(
    (a, b) => parseTimestamp(b.modDate ?? b.pubDate) - parseTimestamp(a.modDate ?? a.pubDate),
  );
}

/** Read a response body up to `capBytes`, streaming when possible so a
 *  missing or dishonest content-length header cannot bypass the cap. */
async function readCapped(res: Response, capBytes: number, url: string): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > capBytes) {
      throw new Error(`ir-rss-adapter: body exceeds ${capBytes}-byte cap for ${url}`);
    }
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > capBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`ir-rss-adapter: streamed body exceeded ${capBytes}-byte cap for ${url}`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Fetch `url`, refusing to leave `host`: `redirect: "manual"` + Location
 * revalidated against `host` for up to `MAX_REDIRECT_HOPS` hops, then a
 * content-type check (XML or HTML) and a byte-capped body read
 * (content-length precheck + streamed cap).
 */
async function hardenedFetch(url: string, host: string, fetchFn: FetchLike): Promise<string> {
  let currentUrl = url;
  let res: Response;

  for (let hop = 0; ; hop += 1) {
    res = await fetchFn(currentUrl, { redirect: "manual" });
    if (res.status < 300 || res.status >= 400) break;

    if (hop >= MAX_REDIRECT_HOPS) {
      throw new Error(`ir-rss-adapter: exceeded ${MAX_REDIRECT_HOPS} redirect hops fetching ${url}`);
    }
    const location = res.headers.get("location");
    if (!location) {
      throw new Error(`ir-rss-adapter: redirect ${res.status} with no Location header for ${currentUrl}`);
    }
    const nextUrl = new URL(location, currentUrl).toString();
    if (!isSameHost(nextUrl, host)) {
      throw new Error(
        `ir-rss-adapter: refusing cross-host redirect from ${currentUrl} to ${nextUrl} (expected host ${host})`,
      );
    }
    currentUrl = nextUrl;
  }

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`ir-rss-adapter: HTTP ${res.status} for ${currentUrl}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!/xml|html/i.test(contentType)) {
    throw new Error(`ir-rss-adapter: unexpected content-type "${contentType}" for ${currentUrl}`);
  }

  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BYTES) {
    throw new Error(
      `ir-rss-adapter: content-length ${contentLength} exceeds ${MAX_BYTES}-byte cap for ${currentUrl}`,
    );
  }

  return readCapped(res, MAX_BYTES, currentUrl);
}

/**
 * Poll one IR RSS feed. Returns quarterly-results items not already in
 * `seenLinks` (mutated in place — the caller owns persistence across polls),
 * newest-`modDate`-first. Every new item's link is added to `seenLinks`
 * whether or not its title matches, so newsroom noise (conference-call
 * notices, etc.) is not re-evaluated on every poll.
 */
export async function pollIrRss(
  cfg: IrRssConfig,
  seenLinks: Set<string>,
  fetchFn: FetchLike = fetch,
): Promise<Array<{ title: string; link: string; html: string }>> {
  const feedXml = await hardenedFetch(bust(cfg.feedUrl), cfg.host, fetchFn);
  const items = sortByModDateDesc(parseRssItems(feedXml));

  const results: Array<{ title: string; link: string; html: string }> = [];

  for (const item of items) {
    if (!isSameHost(item.link, cfg.host)) continue; // never trust an off-host link
    if (seenLinks.has(item.link)) continue;
    seenLinks.add(item.link);

    if (!cfg.titleRegex.test(item.title)) continue;

    const html = await hardenedFetch(item.link, cfg.host, fetchFn);
    results.push({ title: item.title, link: item.link, html });
  }

  return results;
}
