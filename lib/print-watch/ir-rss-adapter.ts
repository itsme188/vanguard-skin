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
// newsroom feed and the article pages it links to). The transport rules
// (manual same-host redirects, content-length precheck + streamed 2MB cap,
// content-type check) now live in the shared `hardened-fetch.ts` used by this
// adapter AND the EDGAR one (fix wave, finding E). Adapter-local rules:
//   - RSS item `<link>` values are only trusted when they resolve to the
//     config's host — an off-host link is dropped, never fetched.
//   - RSS items are extracted via regex/string ops — no XML parser dependency
//     (per plan: no new deps for this task).
//
// BASELINE PASS (fix wave, finding A — Wednesday-critical). The title regex
// matches LAST quarter's results announcement just as well as tonight's: an
// unguarded first poll would download a months-old article, hand it to the
// pipeline as a fresh document, and green the sheet with last quarter's
// numbers. So the FIRST poll of a watch is a baseline: every item currently in
// the feed is recorded as seen WITHOUT being fetched. Only an item that
// appears AFTER the watch started can ever become evidence.
//
// SEEN-MARKING ORDER (fix wave, finding F). This adapter marks seen only what
// it will never fetch — baseline items and non-matching newsroom noise. A
// matched item is returned UNMARKED; the watcher marks it once it has actually
// consumed it, so an article whose download fails (or whose poll the watcher
// abandons on its source timeout) is retried on the next poll instead of being
// silently skipped forever.
//
// Per-host request spacing (SEC 300ms / others 200ms) is the WATCHER's job
// (Task 9's shared spacer) — this module has no polling loop or timers of
// its own; callers own cadence and pass a fresh `seenLinks` Set they persist.

import {
  hardenedFetchText,
  isSameHost,
  CONTENT_TYPE_MARKUP,
  type FetchLike,
} from "./hardened-fetch";

export type { FetchLike };

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

export interface IrPollItem {
  title: string;
  link: string;
  html: string;
}

export interface IrPollOptions {
  /**
   * FIRST poll of a watch (finding A). Every item currently in the feed is
   * recorded in `seenLinks` and NOTHING is fetched: the feed's existing
   * contents are last quarter's history, not tonight's print. Pass false on
   * every subsequent poll of the same watch.
   */
  baseline?: boolean;
}

/**
 * Poll one IR RSS feed. Returns quarterly-results items that appeared since
 * the baseline and are not already in `seenLinks`, newest-`modDate`-first.
 *
 * `seenLinks` is READ for dedupe and mutated ONLY for links this call will
 * never fetch — baseline items and non-matching newsroom noise (conference-
 * call notices, etc.), which must not be re-evaluated on every poll. A matched
 * item comes back UNMARKED: the caller marks it once it has consumed it
 * (finding F), so a failed or abandoned article download retries next poll
 * rather than disappearing.
 */
export async function pollIrRss(
  cfg: IrRssConfig,
  seenLinks: Set<string>,
  fetchFn: FetchLike = fetch,
  opts: IrPollOptions = {},
): Promise<IrPollItem[]> {
  const feedXml = await hardenedFetchText(bust(cfg.feedUrl), fetchFn, {
    host: cfg.host,
    label: "ir-rss-adapter",
    contentType: CONTENT_TYPE_MARKUP,
  });
  const items = sortByModDateDesc(parseRssItems(feedXml));

  const results: IrPollItem[] = [];

  for (const item of items) {
    if (!isSameHost(item.link, cfg.host)) continue; // never trust an off-host link
    if (seenLinks.has(item.link)) continue;

    // Baseline: everything already in the feed at watch start is history.
    if (opts.baseline) {
      seenLinks.add(item.link);
      continue;
    }

    // Newsroom noise: never fetched, so marking it here costs nothing and
    // stops it being re-tested every 10 seconds.
    if (!cfg.titleRegex.test(item.title)) {
      seenLinks.add(item.link);
      continue;
    }

    const html = await hardenedFetchText(item.link, fetchFn, {
      host: cfg.host,
      label: "ir-rss-adapter",
      contentType: CONTENT_TYPE_MARKUP,
    });
    results.push({ title: item.title, link: item.link, html });
  }

  return results;
}
