import { describe, it, expect } from "vitest";
import { pollIrRss, IR_RSS_CONFIGS, type IrRssConfig } from "@/lib/print-watch/ir-rss-adapter";

const HOST = "nvidianews.nvidia.com";
const FEED_URL = `https://${HOST}/cats/press_release.xml`;
const RESULTS_TITLE = "NVIDIA Announces Financial Results for Second Quarter Fiscal 2027";
const CONFERENCE_CALL_TITLE =
  "NVIDIA Sets Conference Call to Discuss Financial Results for Second Quarter Fiscal 2027";

function makeCfg(overrides: Partial<IrRssConfig> = {}): IrRssConfig {
  return {
    symbol: "NVDA",
    feedUrl: FEED_URL,
    host: HOST,
    titleRegex:
      /NVIDIA Announces Financial Results for (First|Second|Third|Fourth) Quarter( and)? Fiscal 20\d\d/i,
    ...overrides,
  };
}

interface FixtureItem {
  title: string;
  link: string;
  pubDate?: string;
  modDate?: string;
}

function rssXml(items: FixtureItem[]): string {
  const body = items
    .map(
      (i) => `<item>
  <title><![CDATA[${i.title}]]></title>
  <link>${i.link}</link>
  ${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ""}
  ${i.modDate ? `<modDate>${i.modDate}</modDate>` : ""}
</item>`,
    )
    .join("\n");
  return `<?xml version="1.0"?><rss><channel>${body}</channel></rss>`;
}

function headers(extra: Record<string, string> = {}, contentType = "application/xml"): HeadersInit {
  return { "content-type": contentType, ...extra };
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

/** A ReadableStream that emits `totalBytes` without ever setting content-length. */
function bigStream(totalBytes: number): ReadableStream<Uint8Array> {
  const chunkSize = 64 * 1024;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(size).fill(97));
      sent += size;
    },
  });
}

describe("IR_RSS_CONFIGS", () => {
  it("has exactly one NVDA config with the harness-verified feed URL, host, and title regex", () => {
    expect(IR_RSS_CONFIGS).toHaveLength(1);
    const nvda = IR_RSS_CONFIGS[0];
    expect(nvda.symbol).toBe("NVDA");
    expect(nvda.feedUrl).toBe(FEED_URL);
    expect(nvda.host).toBe(HOST);
    expect(nvda.titleRegex.test(RESULTS_TITLE)).toBe(true);
    expect(nvda.titleRegex.test(CONFERENCE_CALL_TITLE)).toBe(false);
  });
});

describe("pollIrRss", () => {
  it("returns the results item matched by title regex; the conference-call distractor is not returned", async () => {
    const items: FixtureItem[] = [
      {
        title: CONFERENCE_CALL_TITLE,
        link: `https://${HOST}/news/conference-call`,
        modDate: "2026-08-20T16:00:00Z",
      },
      {
        title: RESULTS_TITLE,
        link: `https://${HOST}/news/q2-fy2027-results`,
        modDate: "2026-08-26T16:20:00Z",
      },
    ];
    const feedXml = rssXml(items);
    const articleFetchPaths: string[] = [];
    const fetchFn = async (url: string) => {
      if (pathOf(url) === "/cats/press_release.xml") {
        return new Response(feedXml, { status: 200, headers: headers() });
      }
      if (pathOf(url) === "/news/q2-fy2027-results") {
        articleFetchPaths.push(pathOf(url));
        return new Response("<html>results page body</html>", {
          status: 200,
          headers: headers({}, "text/html"),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const seen = new Set<string>();
    const results = await pollIrRss(makeCfg(), seen, fetchFn);

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe(RESULTS_TITLE);
    expect(results[0].link).toBe(items[1].link);
    expect(results[0].html).toContain("results page body");

    // Both items are marked seen (so the distractor is not re-evaluated next
    // poll), but the distractor's article page was never fetched.
    expect(seen.has(items[0].link)).toBe(true);
    expect(seen.has(items[1].link)).toBe(true);
    expect(articleFetchPaths).toEqual(["/news/q2-fy2027-results"]);
  });

  it("returns matched items newest-modDate-first", async () => {
    const items: FixtureItem[] = [
      {
        title: RESULTS_TITLE,
        link: `https://${HOST}/news/older`,
        modDate: "2026-08-26T16:20:00Z",
      },
      {
        title: RESULTS_TITLE,
        link: `https://${HOST}/news/newer`,
        modDate: "2026-08-26T16:25:00Z",
      },
    ];
    const feedXml = rssXml(items);
    const fetchFn = async (url: string) => {
      if (pathOf(url) === "/cats/press_release.xml") {
        return new Response(feedXml, { status: 200, headers: headers() });
      }
      return new Response(`<html>${pathOf(url)}</html>`, { status: 200, headers: headers({}, "text/html") });
    };

    const results = await pollIrRss(makeCfg(), new Set(), fetchFn);
    expect(results.map((r) => r.link)).toEqual([items[1].link, items[0].link]);
  });

  it("appends a fresh ?zz= cache-buster on every feed request", async () => {
    const feedXml = rssXml([]);
    const zzValues: (string | null)[] = [];
    const fetchFn = async (url: string) => {
      zzValues.push(new URL(url).searchParams.get("zz"));
      return new Response(feedXml, { status: 200, headers: headers() });
    };

    await pollIrRss(makeCfg(), new Set(), fetchFn);
    await pollIrRss(makeCfg(), new Set(), fetchFn);

    expect(zzValues).toHaveLength(2);
    expect(zzValues[0]).toBeTruthy();
    expect(zzValues[1]).toBeTruthy();
    expect(zzValues[0]).not.toBe(zzValues[1]);
  });

  it("refuses a cross-host redirect when fetching a matched item's article page", async () => {
    const items: FixtureItem[] = [
      { title: RESULTS_TITLE, link: `https://${HOST}/news/q2-fy2027-results` },
    ];
    const feedXml = rssXml(items);
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (pathOf(url) === "/cats/press_release.xml") {
        return new Response(feedXml, { status: 200, headers: headers() });
      }
      if (pathOf(url) === "/news/q2-fy2027-results") {
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: headers({ location: "https://evil.example.com/phish" }),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(pollIrRss(makeCfg(), new Set(), fetchFn)).rejects.toThrow(/cross-host/i);
  });

  it("follows a same-host redirect once and returns the final page's html", async () => {
    const items: FixtureItem[] = [
      { title: RESULTS_TITLE, link: `https://${HOST}/news/q2-fy2027-results` },
    ];
    const feedXml = rssXml(items);
    let articleFetches = 0;
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (pathOf(url) === "/cats/press_release.xml") {
        return new Response(feedXml, { status: 200, headers: headers() });
      }
      if (pathOf(url) === "/news/q2-fy2027-results") {
        articleFetches += 1;
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: headers({ location: `https://${HOST}/news/q2-fy2027-results-final` }),
        });
      }
      if (pathOf(url) === "/news/q2-fy2027-results-final") {
        articleFetches += 1;
        return new Response("<html>final page body</html>", {
          status: 200,
          headers: headers({}, "text/html"),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const results = await pollIrRss(makeCfg(), new Set(), fetchFn);
    expect(results).toHaveLength(1);
    expect(results[0].html).toContain("final page body");
    expect(articleFetches).toBe(2);
  });

  it("rejects a redirect chain longer than 2 hops even when every hop stays on-host", async () => {
    const items: FixtureItem[] = [
      { title: RESULTS_TITLE, link: `https://${HOST}/news/hop0` },
    ];
    const feedXml = rssXml(items);
    const fetchFn = async (url: string) => {
      if (pathOf(url) === "/cats/press_release.xml") {
        return new Response(feedXml, { status: 200, headers: headers() });
      }
      const m = /^\/news\/hop(\d)$/.exec(pathOf(url));
      if (m) {
        const n = Number(m[1]);
        if (n < 3) {
          return new Response(null, {
            status: 302,
            headers: headers({ location: `https://${HOST}/news/hop${n + 1}` }),
          });
        }
        return new Response("<html>should never be reached</html>", {
          status: 200,
          headers: headers({}, "text/html"),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(pollIrRss(makeCfg(), new Set(), fetchFn)).rejects.toThrow(/redirect hops/i);
  });

  it("rejects a streamed article body that exceeds the 2MB cap even with no content-length header", async () => {
    const items: FixtureItem[] = [
      { title: RESULTS_TITLE, link: `https://${HOST}/news/q2-fy2027-results` },
    ];
    const feedXml = rssXml(items);
    const fetchFn = async (url: string) => {
      if (pathOf(url) === "/cats/press_release.xml") {
        return new Response(feedXml, { status: 200, headers: headers() });
      }
      if (pathOf(url) === "/news/q2-fy2027-results") {
        // 3MB, streamed, no content-length — the precheck can't catch this;
        // only the streamed cap can.
        return new Response(bigStream(3 * 1024 * 1024), {
          status: 200,
          headers: headers({}, "text/html"),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(pollIrRss(makeCfg(), new Set(), fetchFn)).rejects.toThrow(/cap/i);
  });

  it("rejects via the content-length precheck without reading the body when the header is honest", async () => {
    const items: FixtureItem[] = [
      { title: RESULTS_TITLE, link: `https://${HOST}/news/q2-fy2027-results` },
    ];
    const feedXml = rssXml(items);
    const fetchFn = async (url: string) => {
      if (pathOf(url) === "/cats/press_release.xml") {
        return new Response(feedXml, { status: 200, headers: headers() });
      }
      if (pathOf(url) === "/news/q2-fy2027-results") {
        return new Response("<html>tiny body, big header lie</html>", {
          status: 200,
          headers: headers({ "content-length": String(3 * 1024 * 1024) }, "text/html"),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(pollIrRss(makeCfg(), new Set(), fetchFn)).rejects.toThrow(/content-length/i);
  });

  it("dedupes via seenLinks: an already-seen item is skipped and its article is not re-fetched", async () => {
    const items: FixtureItem[] = [
      { title: RESULTS_TITLE, link: `https://${HOST}/news/q2-fy2027-results` },
    ];
    const feedXml = rssXml(items);
    let articleFetches = 0;
    const fetchFn = async (url: string) => {
      if (pathOf(url) === "/cats/press_release.xml") {
        return new Response(feedXml, { status: 200, headers: headers() });
      }
      if (pathOf(url) === "/news/q2-fy2027-results") {
        articleFetches += 1;
        return new Response("<html>results page body</html>", {
          status: 200,
          headers: headers({}, "text/html"),
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const seen = new Set<string>();
    const first = await pollIrRss(makeCfg(), seen, fetchFn);
    expect(first).toHaveLength(1);
    expect(articleFetches).toBe(1);

    const second = await pollIrRss(makeCfg(), seen, fetchFn);
    expect(second).toHaveLength(0);
    expect(articleFetches).toBe(1); // no repeat fetch of an already-seen link
  });

  it("drops an item whose link is off the configured host without fetching it", async () => {
    const items: FixtureItem[] = [
      { title: RESULTS_TITLE, link: "https://evil.example.com/spoofed-results" },
    ];
    const feedXml = rssXml(items);
    const fetchFn = async (url: string) => {
      if (pathOf(url) === "/cats/press_release.xml") {
        return new Response(feedXml, { status: 200, headers: headers() });
      }
      throw new Error(`unexpected fetch (off-host link should never be fetched): ${url}`);
    };

    const results = await pollIrRss(makeCfg(), new Set(), fetchFn);
    expect(results).toHaveLength(0);
  });

  it("rejects a feed response whose content-type is not XML or HTML", async () => {
    const fetchFn = async (url: string) => {
      if (pathOf(url) === "/cats/press_release.xml") {
        return new Response("not a feed", { status: 200, headers: headers({}, "application/json") });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    await expect(pollIrRss(makeCfg(), new Set(), fetchFn)).rejects.toThrow(/content-type/i);
  });
});
