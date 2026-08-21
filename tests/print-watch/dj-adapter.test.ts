// Ports the proven mechanics from scripts/spike-print-tws-news.ts (verified
// live 2026-08-20 against CRWD, HD, and others in tests/fixtures/real/bakeoff)
// into product code: the "{A:...:L:en}" metadata-prefix strip, the
// backward-walk quirk (first datetime param to reqHistoricalNews is the
// RECENT boundary; results can walk past the older boundary so the window
// is enforced client-side), part grouping by prefix CONTAINMENT (shortest
// form wins), and body fetch + plain concatenation.
//
// Drives a FAKE IBApiLike — no live TWS. CRWD part headlines are loaded from
// the real bake-off fixture when present (gitignored, local-only) and fall
// back to an inline literal replica of the same data otherwise, so the test
// is deterministic in any checkout.

import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  pollDjNews,
  createDjPollState,
  DJ_PROVIDER_CODES,
  type IBApiLike,
  type DjPollState,
} from "@/lib/print-watch/dj-adapter";

// ---------------------------------------------------------------------------
// CRWD part fixture (guarded, inline fallback)
// ---------------------------------------------------------------------------

interface FixturePart {
  n: number;
  articleId: string;
  headline: string;
}

function loadCrwdParts(): FixturePart[] {
  const fixturePath = join(
    process.cwd(),
    "tests",
    "fixtures",
    "real",
    "bakeoff",
    "CRWD-2026-06-03",
    "dj-parts.json",
  );
  if (existsSync(fixturePath)) {
    const raw = JSON.parse(readFileSync(fixturePath, "utf-8")) as Array<{
      partsTotal: number;
      parts: FixturePart[];
    }>;
    const sevenPartRelease = raw.find((r) => r.partsTotal === 7);
    if (sevenPartRelease) return sevenPartRelease.parts;
  }
  // Inline fallback — byte-identical to the real fixture's 7-part release
  // (CrowdStrike Q1 FY27 earnings, 2026-06-03).
  return [
    { n: 1, articleId: "DJ-N$1e9d7cb2", headline: "Press Release: CrowdStrike Reports First Quarter Fiscal Year 2027 Financial Results" },
    { n: 2, articleId: "DJ-N$1e9d7cb5", headline: "Press Release: CrowdStrike Reports First Quarter" },
    { n: 3, articleId: "DJ-N$1e9d7cb8", headline: "Press Release: CrowdStrike Reports First Quarter" },
    { n: 4, articleId: "DJ-N$1e9d7cbd", headline: "Press Release: CrowdStrike Reports First Quarter" },
    { n: 5, articleId: "DJ-N$1e9d7cc6", headline: "Press Release: CrowdStrike Reports First Quarter" },
    { n: 6, articleId: "DJ-N$1e9d7cc9", headline: "Press Release: CrowdStrike Reports First Quarter" },
    { n: 7, articleId: "DJ-N$1e9d7ccd", headline: "Press Release: CrowdStrike Reports First Quarter" },
  ];
}

/** Reconstruct the RAW wire headline: metadata prefix + " -N-" suffix (n>1). */
function rawHeadline(part: FixturePart): string {
  const suffix = part.n > 1 ? ` -${part.n}-` : "";
  return `{A:800015:L:en}${part.headline}${suffix}`;
}

const CRWD_PARTS = loadCrwdParts();
const CRWD_CON_ID = 12345;

// HD "Express Delivery" distractor — a genuine press release that is NOT an
// earnings print (fails the /results|quarter|fiscal|earnings/i filter).
const HD_DISTRACTOR = [
  { n: 1, articleId: "DJ-N$1f2802aa", headline: "Press Release: The Home Depot Expands Fastest Fulfillment in Home Improvement with Nationwide Express Delivery" },
  { n: 2, articleId: "DJ-N$1f2802ab", headline: "Press Release: The Home Depot Expands Fastest Fulfillment" },
];

const FLASH_1 = {
  articleId: "DJ-N$1e9d7c5a",
  time: "2026-06-03 20:05:00.0",
  headline: "{A:800015:L:en}* CrowdStrike Holdings 1Q Rev $1.39B >CRWD",
};
const FLASH_2 = {
  articleId: "DJ-N$1e9d7c62",
  time: "2026-06-03 20:06:00.0",
  headline: "{A:800015:L:en}* CrowdStrike Holdings 1Q Net $27.8M >CRWD",
};

// A headline that walks PAST the older window boundary — TWS's backward-walk
// quirk means this can come back in the results even though it's outside the
// requested window, and must be filtered out client-side.
const OUT_OF_WINDOW_FLASH = {
  articleId: "DJ-N$stale0001",
  time: "2026-06-03 12:00:00.0",
  headline: "{A:800015:L:en}* CrowdStrike Stale Headline From Before The Window >CRWD",
};

const WINDOW_START_UTC = "2026-06-03 19:00:00.0";
const NOW_UTC = "2026-06-03 21:00:00.0";

interface RawEvent {
  time: string;
  providerCode: string;
  articleId: string;
  headline: string;
}

type Listener = (...args: unknown[]) => void;

/** Fake IBApiLike — replays a scripted historicalNews response per poll call. */
class FakeIBApi implements IBApiLike {
  private listeners = new Map<string, Listener[]>();
  historicalNewsCalls: Array<{
    conId: number;
    providerCodes: string;
    startDateTime: string;
    endDateTime: string;
  }> = [];
  newsArticleCalls: string[] = [];
  /** callIndex (1-based) -> headlines to replay for that poll's reqHistoricalNews. */
  responsesByCall: RawEvent[][] = [];

  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  removeListener(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((l) => l !== listener),
    );
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  reqHistoricalNews(
    reqId: number,
    conId: number,
    providerCodes: string,
    startDateTime: string,
    endDateTime: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature must match IBApiLike
    totalResults: number,
  ): void {
    this.historicalNewsCalls.push({ conId, providerCodes, startDateTime, endDateTime });
    const callIndex = this.historicalNewsCalls.length;
    const events = this.responsesByCall[callIndex - 1] ?? [];
    queueMicrotask(() => {
      for (const h of events) {
        this.emit("historicalNews", reqId, h.time, h.providerCode, h.articleId, h.headline);
      }
      this.emit("historicalNewsEnd", reqId, false);
    });
  }

  reqNewsArticle(reqId: number, providerCode: string, articleId: string): void {
    this.newsArticleCalls.push(articleId);
    queueMicrotask(() => {
      this.emit("newsArticle", reqId, 0, `BODY[${articleId}]`);
    });
  }
}

function ev(articleId: string, time: string, headline: string, providerCode = "DJ-N"): RawEvent {
  return { time, providerCode, articleId, headline };
}

/** Build the reqHistoricalNews response for a given poll's part-count cutoff. */
function crwdEvents(uptoPart: number): RawEvent[] {
  return CRWD_PARTS.filter((p) => p.n <= uptoPart).map((p) =>
    ev(p.articleId, "2026-06-03 20:05:00.0", rawHeadline(p)),
  );
}

function hdEvents(): RawEvent[] {
  return HD_DISTRACTOR.map((p) => ev(p.articleId, "2026-06-03 20:02:00.0", rawHeadline(p)));
}

describe("pollDjNews", () => {
  let api: FakeIBApi;
  let state: DjPollState;
  const T0 = Date.parse("2026-06-03T20:20:00.000Z");

  beforeEach(() => {
    api = new FakeIBApi();
    state = createDjPollState();
  });

  it("first poll: sees 4 of 7 parts, nothing completed yet", async () => {
    // Shuffle the arrival order to prove part-order stitching later relies
    // on the parsed part number, not response order.
    const crwd4 = crwdEvents(4);
    api.responsesByCall = [[ev(FLASH_1.articleId, FLASH_1.time, FLASH_1.headline), ...hdEvents(), ...crwd4]];

    const out = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);

    expect(out.completedReleases).toEqual([]);
    expect(out.flashes).toEqual([{ time: FLASH_1.time, headline: "* CrowdStrike Holdings 1Q Rev $1.39B >CRWD" }]);

    const crwdGroup = [...state.partGroups.values()].find((g) => g.articleIds.length > 0 && g.articleIds.includes(CRWD_PARTS[0].articleId));
    expect(crwdGroup?.articleIds.length).toBe(4);
  });

  it("second poll (+10s): adds 3 more parts (7 total), still not quiescent", async () => {
    api.responsesByCall = [
      [ev(FLASH_1.articleId, FLASH_1.time, FLASH_1.headline), ...hdEvents(), ...crwdEvents(4)],
      // Reorder so part 7 arrives before parts 5/6 — arrival order must not
      // determine stitch order.
      [
        ev(FLASH_1.articleId, FLASH_1.time, FLASH_1.headline),
        ev(FLASH_2.articleId, FLASH_2.time, FLASH_2.headline),
        ...hdEvents(),
        ev(CRWD_PARTS[6].articleId, "2026-06-03 20:05:00.0", rawHeadline(CRWD_PARTS[6])),
        ev(CRWD_PARTS[4].articleId, "2026-06-03 20:05:00.0", rawHeadline(CRWD_PARTS[4])),
        ev(CRWD_PARTS[5].articleId, "2026-06-03 20:05:00.0", rawHeadline(CRWD_PARTS[5])),
        ...crwdEvents(4),
      ],
    ];

    await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);
    const out2 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 10_000);

    expect(out2.completedReleases).toEqual([]);
    // seen-dedupe: FLASH_1 already emitted in poll 1, must not reappear.
    expect(out2.flashes).toEqual([{ time: FLASH_2.time, headline: "* CrowdStrike Holdings 1Q Net $27.8M >CRWD" }]);

    const crwdGroup = [...state.partGroups.values()].find((g) => g.articleIds.includes(CRWD_PARTS[0].articleId));
    expect(crwdGroup?.articleIds.length).toBe(7);
  });

  it("third poll (+20s, no growth): completes the 7-part CRWD stitch in order; HD distractor excluded", async () => {
    const stableResponse = [
      ev(FLASH_1.articleId, FLASH_1.time, FLASH_1.headline),
      ev(FLASH_2.articleId, FLASH_2.time, FLASH_2.headline),
      ...hdEvents(),
      ...crwdEvents(7),
    ];
    api.responsesByCall = [
      [ev(FLASH_1.articleId, FLASH_1.time, FLASH_1.headline), ...hdEvents(), ...crwdEvents(4)],
      stableResponse,
      stableResponse,
    ];

    await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);
    await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 10_000);
    const out3 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 30_000);

    expect(out3.completedReleases).toHaveLength(1);
    const release = out3.completedReleases[0];
    expect(release.partCount).toBe(7);
    expect(release.headline).toBe(
      "Press Release: CrowdStrike Reports First Quarter Fiscal Year 2027 Financial Results",
    );
    // Stitched body concatenates part bodies IN PART-NUMBER ORDER, regardless
    // of the arrival order the fake replayed them in.
    const expectedOrder = CRWD_PARTS.map((p) => `BODY[${p.articleId}]`).join("\n\n");
    expect(release.stitchedText).toBe(expectedOrder);

    // HD distractor reached quiescence too but must be silently dropped —
    // not present in completedReleases, and removed from state either way.
    expect(out3.completedReleases.some((r) => r.headline.includes("Express Delivery"))).toBe(false);
    expect([...state.partGroups.values()].some((g) => g.articleIds.includes(HD_DISTRACTOR[0].articleId))).toBe(false);

    // Completed group is removed from state (emit once).
    expect([...state.partGroups.values()].some((g) => g.articleIds.includes(CRWD_PARTS[0].articleId))).toBe(false);

    // No flashes this poll — both already seen.
    expect(out3.flashes).toEqual([]);
  });

  it("re-polling after completion never re-emits the same release (emit once)", async () => {
    const stableResponse = [...hdEvents(), ...crwdEvents(7)];
    api.responsesByCall = [crwdEvents(4), stableResponse, stableResponse, stableResponse];

    await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);
    await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 10_000);
    const out3 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 30_000);
    expect(out3.completedReleases).toHaveLength(1);

    const out4 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 50_000);
    expect(out4.completedReleases).toEqual([]);
  });

  it("passes the RECENT boundary first and the OLDER boundary second to reqHistoricalNews (backward-walk quirk)", async () => {
    api.responsesByCall = [[]];
    await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);

    expect(api.historicalNewsCalls).toHaveLength(1);
    const call = api.historicalNewsCalls[0];
    expect(call.conId).toBe(CRWD_CON_ID);
    expect(call.providerCodes).toBe(DJ_PROVIDER_CODES);
    // First param = RECENT boundary = nowUtc; second = OLDER boundary = windowStartUtc.
    expect(call.startDateTime).toBe(NOW_UTC);
    expect(call.endDateTime).toBe(WINDOW_START_UTC);
  });

  it("filters out a result that walks past the older window boundary (backward-walk quirk)", async () => {
    api.responsesByCall = [[ev(OUT_OF_WINDOW_FLASH.articleId, OUT_OF_WINDOW_FLASH.time, OUT_OF_WINDOW_FLASH.headline)]];

    const out = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);

    expect(out.flashes).toEqual([]);
    expect(out.completedReleases).toEqual([]);
  });

  it("strips the DJ metadata prefix before classifying/emitting a headline", async () => {
    api.responsesByCall = [[ev(FLASH_1.articleId, FLASH_1.time, FLASH_1.headline)]];
    const out = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);
    expect(out.flashes[0].headline.startsWith("{A:")).toBe(false);
    expect(out.flashes[0].headline).toBe("* CrowdStrike Holdings 1Q Rev $1.39B >CRWD");
  });
});
