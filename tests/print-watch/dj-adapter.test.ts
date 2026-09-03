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

import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getEventListeners } from "node:events";
import {
  pollDjNews,
  createDjPollState,
  DJ_PROVIDER_CODES,
  type IBApiLike,
  type DjPollState,
  type DjPollOutput,
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
  /** articleIds that should emit an `error` event instead of `newsArticle`, simulating a fetch failure. */
  failingArticleIds = new Set<string>();
  /** articleIds that NEVER settle — no `newsArticle`, no `error`, ever. Used to
   *  prove `reqNewsArticleOnce`'s OWN abort race (fix round 1, review finding
   *  I1): with this set, the fake genuinely never answers, so the only thing
   *  that can settle the request is the helper's abort listener or the 25s
   *  timeout — unlike a fake that always answers on a microtask, where the
   *  loop-level `throwIfAborted` between iterations could produce the same
   *  observable rejection for the wrong reason. */
  neverAnswerArticleIds = new Set<string>();
  /** When set, `reqHistoricalNews`/`reqNewsArticle` throws this SYNCHRONOUSLY
   *  (fix round 1, review finding M1) instead of scheduling a response. */
  throwOnHistoricalNews: Error | null = null;
  throwOnNewsArticle: Error | null = null;
  /** Cancellation test hooks (Task 4) — fired SYNCHRONOUSLY so a test can flip
   *  an AbortController exactly when a request has been placed (listeners —
   *  including the production code's abort listener — already attached) or
   *  exactly after one has settled, without racing microtask timing. */
  onHistoricalNewsRequested?: () => void;
  onArticleRequested?: (articleId: string) => void;
  onArticleSettled?: (articleId: string) => void;

  /** Test introspection only — how many listeners the fake is currently
   *  holding for `event` (used to assert no leak after a synchronous throw,
   *  fix round 1 M1). */
  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }

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
    this.onHistoricalNewsRequested?.();
    if (this.throwOnHistoricalNews) throw this.throwOnHistoricalNews;
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
    this.onArticleRequested?.(articleId);
    if (this.throwOnNewsArticle) throw this.throwOnNewsArticle;
    if (this.neverAnswerArticleIds.has(articleId)) return; // genuinely never settles
    queueMicrotask(() => {
      if (this.failingArticleIds.has(articleId)) {
        this.emit("error", new Error(`simulated fetch failure for ${articleId}`), 162, reqId);
        this.onArticleSettled?.(articleId);
        return;
      }
      this.emit("newsArticle", reqId, 0, `BODY[${articleId}]`);
      this.onArticleSettled?.(articleId);
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

/**
 * What the WATCHER does with a poll's output once it has ingested it — the
 * caller-owns-seen contract (fix wave, finding F). The adapter marks nothing
 * it hands back, so every test expecting dedupe on a later poll has to consume
 * first, exactly as production does.
 */
function consume(state: DjPollState, out: DjPollOutput): void {
  for (const release of out.completedReleases) {
    for (const id of release.articleIds) state.seenArticleIds.add(id);
  }
  for (const flash of out.flashes) state.seenArticleIds.add(flash.articleId);
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
    // The flash carries its article id so the CALLER can mark it once taken.
    expect(out.flashes).toEqual([
      {
        time: FLASH_1.time,
        headline: "* CrowdStrike Holdings 1Q Rev $1.39B >CRWD",
        articleId: FLASH_1.articleId,
      },
    ]);
    // ...and the adapter did NOT mark it (finding F).
    expect(state.seenArticleIds.has(FLASH_1.articleId)).toBe(false);

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

    const out1 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);
    consume(state, out1); // the watcher takes poll 1's flash
    const out2 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 10_000);

    expect(out2.completedReleases).toEqual([]);
    // seen-dedupe: FLASH_1 was CONSUMED after poll 1, so it must not reappear.
    expect(out2.flashes).toEqual([
      {
        time: FLASH_2.time,
        headline: "* CrowdStrike Holdings 1Q Net $27.8M >CRWD",
        articleId: FLASH_2.articleId,
      },
    ]);

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

    consume(state, await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0));
    consume(
      state,
      await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 10_000),
    );
    const out3 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 30_000);

    expect(out3.completedReleases).toHaveLength(1);
    const release = out3.completedReleases[0];
    expect(release.articleIds.sort()).toEqual(CRWD_PARTS.map((p) => p.articleId).sort());
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
    // (The adapter DOES mark this one: it never reaches the caller.)
    expect(out3.completedReleases.some((r) => r.headline.includes("Express Delivery"))).toBe(false);
    expect([...state.partGroups.values()].some((g) => g.articleIds.includes(HD_DISTRACTOR[0].articleId))).toBe(false);
    expect(state.seenArticleIds.has(HD_DISTRACTOR[0].articleId)).toBe(true);

    // The completed group is EMITTED, not retired (finding F): it stays in
    // state, unmarked, until the caller says it ingested the release.
    expect([...state.partGroups.values()].some((g) => g.articleIds.includes(CRWD_PARTS[0].articleId))).toBe(true);
    for (const p of CRWD_PARTS) expect(state.seenArticleIds.has(p.articleId)).toBe(false);

    // No flashes this poll — both were consumed after their own polls.
    expect(out3.flashes).toEqual([]);
  });

  it("re-polling after a CONSUMED completion never re-emits the same release (emit once)", async () => {
    const stableResponse = [...hdEvents(), ...crwdEvents(7)];
    api.responsesByCall = [crwdEvents(4), stableResponse, stableResponse, stableResponse];

    await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);
    await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 10_000);
    const out3 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 30_000);
    expect(out3.completedReleases).toHaveLength(1);

    consume(state, out3); // the watcher ingested it

    const out4 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 50_000);
    expect(out4.completedReleases).toEqual([]);
    // Consumption is also what retires the part group.
    expect([...state.partGroups.values()].some((g) => g.articleIds.includes(CRWD_PARTS[0].articleId))).toBe(false);
  });

  // The whole point of finding F: an emit is not a delivery. If the caller's
  // ingest throws, nothing marks the release seen — and the next poll must
  // hand it back rather than losing it for the life of the runtime.
  it("re-emits a completed release the caller never consumed, and stops once it does", async () => {
    const stableResponse = [...crwdEvents(7)];
    api.responsesByCall = [crwdEvents(4), stableResponse, stableResponse, stableResponse, stableResponse];

    await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);
    await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 10_000);

    const out3 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 30_000);
    expect(out3.completedReleases).toHaveLength(1);
    // The caller's ingestDocument threw: it marks nothing.

    const out4 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 50_000);
    expect(out4.completedReleases).toHaveLength(1);
    expect(out4.completedReleases[0].partCount).toBe(7);
    expect(out4.completedReleases[0].stitchedText).toBe(out3.completedReleases[0].stitchedText);

    consume(state, out4); // this time the ingest worked

    const out5 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 70_000);
    expect(out5.completedReleases).toEqual([]);
  });

  it("re-emits a flash the caller never consumed", async () => {
    const flashEvent = ev(FLASH_1.articleId, FLASH_1.time, FLASH_1.headline);
    api.responsesByCall = [[flashEvent], [flashEvent], [flashEvent]];

    const out1 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);
    expect(out1.flashes).toHaveLength(1);

    // Nothing consumed it — the bullet comes back rather than vanishing.
    const out2 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 10_000);
    expect(out2.flashes).toHaveLength(1);
    consume(state, out2);

    const out3 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 20_000);
    expect(out3.flashes).toEqual([]);
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

  // ---------------------------------------------------------------------
  // Fix round 1 — CRITICAL: a failing reqNewsArticle must not throw the
  // whole poll, must not drop other completions/flashes from the same
  // poll, and must leave the failed group retryable on the next poll.
  // ---------------------------------------------------------------------

  const ACME_PARTS: FixturePart[] = [
    { n: 1, articleId: "DJ-N$acme0001", headline: "Press Release: Acme Corp Reports Second Quarter 2026 Results" },
    { n: 2, articleId: "DJ-N$acme0002", headline: "Press Release: Acme Corp Reports Second Quarter" },
  ];
  function acmeEvents(): RawEvent[] {
    return ACME_PARTS.map((p) => ev(p.articleId, "2026-06-03 20:03:00.0", rawHeadline(p)));
  }
  const FLASH_3 = {
    articleId: "DJ-N$1e9d8341",
    time: "2026-06-03 20:09:00.0",
    headline: "{A:800015:L:en}* CrowdStrike Holdings Sees FY27 Rev $5.915B-$5.959B >CRWD",
  };

  it("a reqNewsArticle failure does not throw the poll, other completions/flashes survive, and the failed group is retryable next poll", async () => {
    const flashesSoFar = [ev(FLASH_1.articleId, FLASH_1.time, FLASH_1.headline)];
    const flashesTwo = [...flashesSoFar, ev(FLASH_2.articleId, FLASH_2.time, FLASH_2.headline)];
    const flashesThree = [...flashesTwo, ev(FLASH_3.articleId, FLASH_3.time, FLASH_3.headline)];

    api.responsesByCall = [
      [...crwdEvents(4), ...acmeEvents(), ...flashesSoFar],
      [...crwdEvents(7), ...acmeEvents(), ...flashesTwo],
      [...crwdEvents(7), ...acmeEvents(), ...flashesThree],
      [...crwdEvents(7), ...acmeEvents(), ...flashesThree],
    ];
    // A middle CRWD part fails to fetch on the poll where the group first
    // goes quiescent.
    api.failingArticleIds.add(CRWD_PARTS[3].articleId);

    consume(state, await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0));
    consume(
      state,
      await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 10_000),
    );

    // Poll 3: CRWD and Acme both reach quiescence in the SAME call. CRWD's
    // body fetch fails partway through; the call must still resolve (not
    // throw), Acme must still complete, and FLASH_3 must still come out.
    const out3 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 30_000);

    expect(out3.completedReleases).toHaveLength(1);
    expect(out3.completedReleases[0].headline).toBe(
      "Press Release: Acme Corp Reports Second Quarter 2026 Results",
    );
    expect(out3.completedReleases.some((r) => r.headline.includes("CrowdStrike"))).toBe(false);
    expect(out3.flashes).toEqual([
      {
        time: FLASH_3.time,
        headline: "* CrowdStrike Holdings Sees FY27 Rev $5.915B-$5.959B >CRWD",
        articleId: FLASH_3.articleId,
      },
    ]);

    // The watcher ingests what it got (Acme + the flash) — CRWD never arrived.
    consume(state, out3);

    // The failed group survives in state, untouched — not silently lost.
    const survivingCrwdGroup = [...state.partGroups.values()].find((g) => g.articleIds.includes(CRWD_PARTS[0].articleId));
    expect(survivingCrwdGroup?.articleIds.length).toBe(7);
    // Not poisoned: none of its article ids were marked seen by the failed attempt.
    for (const p of CRWD_PARTS) expect(state.seenArticleIds.has(p.articleId)).toBe(false);

    // Poll 4: the transient failure clears — the SAME group completes whole.
    api.failingArticleIds.clear();
    const out4 = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 50_000);
    expect(out4.completedReleases).toHaveLength(1);
    expect(out4.completedReleases[0].partCount).toBe(7);
    const expectedOrder = CRWD_PARTS.map((p) => `BODY[${p.articleId}]`).join("\n\n");
    expect(out4.completedReleases[0].stitchedText).toBe(expectedOrder);
  });

  // ---------------------------------------------------------------------
  // Fix round 1 — IMPORTANT: prefix-containment grouping must be gated by
  // provider equality + time proximity, or two unrelated releases sharing
  // a truncated-headline prefix could merge into one bogus stitch.
  // ---------------------------------------------------------------------

  it("two same-prefix releases 10+ minutes apart form separate groups (time gate)", async () => {
    const releaseX: FixturePart[] = [
      { n: 1, articleId: "DJ-N$x0001", headline: "Press Release: Acme Corp Announces Strategic Update For Investors" },
      { n: 2, articleId: "DJ-N$x0002", headline: "Press Release: Acme Corp Announces Strategic" },
    ];
    const releaseY: FixturePart[] = [
      { n: 1, articleId: "DJ-N$y0001", headline: "Press Release: Acme Corp Announces Strategic Update For Investors" },
      { n: 2, articleId: "DJ-N$y0002", headline: "Press Release: Acme Corp Announces Strategic" },
    ];
    const xEvents = releaseX.map((p) => ev(p.articleId, "2026-06-03 20:00:00.0", rawHeadline(p)));
    const yEvents = releaseY.map((p) => ev(p.articleId, "2026-06-03 20:16:00.0", rawHeadline(p))); // 16 min later

    api.responsesByCall = [[...xEvents, ...yEvents]];
    const out = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);

    expect(out.completedReleases).toEqual([]); // freshly created — not quiescent yet
    expect(state.partGroups.size).toBe(2);
    const groupX = [...state.partGroups.values()].find((g) => g.articleIds.includes("DJ-N$x0001"));
    const groupY = [...state.partGroups.values()].find((g) => g.articleIds.includes("DJ-N$y0001"));
    expect(groupX?.articleIds.sort()).toEqual(["DJ-N$x0001", "DJ-N$x0002"]);
    expect(groupY?.articleIds.sort()).toEqual(["DJ-N$y0001", "DJ-N$y0002"]);
  });

  it("two same-prefix, same-time releases on different providers form separate groups (provider gate)", async () => {
    const releaseDjN: FixturePart[] = [
      { n: 1, articleId: "DJ-N$p0001", headline: "Press Release: Acme Corp Announces Strategic Update For Investors" },
      { n: 2, articleId: "DJ-N$p0002", headline: "Press Release: Acme Corp Announces Strategic" },
    ];
    const releaseDjRta: FixturePart[] = [
      { n: 1, articleId: "DJ-RTA$q0001", headline: "Press Release: Acme Corp Announces Strategic Update For Investors" },
      { n: 2, articleId: "DJ-RTA$q0002", headline: "Press Release: Acme Corp Announces Strategic" },
    ];
    const djNEvents = releaseDjN.map((p) => ev(p.articleId, "2026-06-03 20:00:00.0", rawHeadline(p), "DJ-N"));
    const djRtaEvents = releaseDjRta.map((p) => ev(p.articleId, "2026-06-03 20:00:00.0", rawHeadline(p), "DJ-RTA"));

    api.responsesByCall = [[...djNEvents, ...djRtaEvents]];
    const out = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);

    expect(out.completedReleases).toEqual([]);
    expect(state.partGroups.size).toBe(2);
  });

  // -------------------------------------------------------------------
  // Task 4 (slice C): pollDjNews honours a trailing, optional AbortSignal —
  // checked before the historical-news request and before each article-body
  // fetch, and raced INSIDE both TWS request helpers so an abort mid-flight
  // (request already placed, no response yet) rejects immediately rather
  // than waiting out the 25s TWS timeout. Reuses this file's own FakeIBApi
  // (extended with three synchronous cancellation hooks) and the ACME
  // 2-part fixture already defined above — no second fake.
  // -------------------------------------------------------------------
  describe("pollDjNews — cancellation", () => {
    it("throws AbortError before the historical-news request when the signal is already aborted, touching no state", async () => {
      api.responsesByCall = [[]];
      const ac = new AbortController();
      ac.abort();

      await expect(
        pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0, ac.signal),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(api.historicalNewsCalls).toHaveLength(0);
      expect(state.seenArticleIds.size).toBe(0);
      expect(state.partGroups.size).toBe(0);
    });

    it("throws AbortError between article fetches and leaves the part group retryable", async () => {
      // Poll 1 creates the 2-part Acme group; poll 2 (+30s, no growth) hits
      // quiescence and starts fetching bodies — abort right after the first
      // part's body is delivered, before the second is ever requested.
      api.responsesByCall = [acmeEvents(), []];
      await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);

      const ac = new AbortController();
      api.onArticleSettled = (id) => {
        if (id === ACME_PARTS[0].articleId) ac.abort();
      };

      await expect(
        pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 30_000, ac.signal),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(api.newsArticleCalls).toEqual([ACME_PARTS[0].articleId]);
      const group = [...state.partGroups.values()].find((g) => g.articleIds.includes(ACME_PARTS[0].articleId));
      expect(group?.articleIds.length).toBe(2); // still there for the next poll
      expect(state.seenArticleIds.size).toBe(0); // nothing retired
    });

    it("without a signal the behaviour is unchanged (one call, both parts stitched)", async () => {
      api.responsesByCall = [acmeEvents(), []];
      await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);
      const out = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 30_000);

      expect(out.completedReleases).toHaveLength(1);
      expect(out.completedReleases[0].stitchedText).toBe(
        ACME_PARTS.map((p) => `BODY[${p.articleId}]`).join("\n\n"),
      );
    });

    // Codex round 1, finding #10: the helpers themselves must race the
    // signal, not just the loop-level check between iterations — otherwise
    // an abort that lands WHILE a request is outstanding (not between two
    // requests) would still wait out the 25s TWS timeout.
    it("a historical-news request that never answers rejects the moment the signal aborts (fake timers; no 25s wait)", async () => {
      vi.useFakeTimers();
      try {
        const ac = new AbortController();
        api.onHistoricalNewsRequested = () => ac.abort();
        api.responsesByCall = [[]];

        await expect(
          pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0, ac.signal),
        ).rejects.toMatchObject({ name: "AbortError" });

        expect(api.historicalNewsCalls).toHaveLength(1); // the request WAS placed
        expect(state.partGroups.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    // Fix round 1, review finding I1: the fake used to keep answering on a
    // microtask even after the abort hook fired, so this test passed
    // identically with `reqNewsArticleOnce`'s own abort listener deleted —
    // the loop-level `throwIfAborted` between iterations alone satisfied
    // every assertion. `neverAnswerArticleIds` makes the request GENUINELY
    // never settle, so the ONLY thing that can reject this promise (short of
    // the real 25s TWS timeout, which fake timers never advance to) is the
    // helper's own `signal` listener — the thing amendment #1 actually added.
    it("a news-article request that never answers rejects the moment the signal aborts (fake timers; no 25s wait)", async () => {
      vi.useFakeTimers();
      try {
        api.responsesByCall = [acmeEvents(), []];
        await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);

        api.neverAnswerArticleIds.add(ACME_PARTS[0].articleId);
        const ac = new AbortController();
        api.onArticleRequested = (id) => {
          if (id === ACME_PARTS[0].articleId) ac.abort();
        };

        await expect(
          pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 30_000, ac.signal),
        ).rejects.toMatchObject({ name: "AbortError" });

        expect(api.newsArticleCalls).toEqual([ACME_PARTS[0].articleId]);
        const group = [...state.partGroups.values()].find((g) => g.articleIds.includes(ACME_PARTS[0].articleId));
        expect(group?.articleIds.length).toBe(2);
        expect(state.seenArticleIds.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    // Fix round 1, review finding M1: a synchronous throw from the raw IBApi
    // call must not skip cleanup() — otherwise the 25s timer, the TWS
    // listeners, and (new with this change) the abort listener on the
    // caller's signal would all leak past the settled promise.
    it("cleans up the timer and TWS/abort listeners when ib.reqHistoricalNews throws synchronously (M1)", async () => {
      vi.useFakeTimers();
      try {
        const boom = new Error("synchronous TWS failure");
        api.throwOnHistoricalNews = boom;
        api.responsesByCall = [[]];
        const ac = new AbortController(); // never aborted — this is a plain-throw test

        expect(vi.getTimerCount()).toBe(0);
        await expect(
          pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0, ac.signal),
        ).rejects.toBe(boom);

        expect(vi.getTimerCount()).toBe(0); // the 25s timer was cleared, not leaked
        expect(api.listenerCount("historicalNews")).toBe(0);
        expect(api.listenerCount("historicalNewsEnd")).toBe(0);
        expect(api.listenerCount("error")).toBe(0);
        expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cleans up the timer and TWS/abort listeners when ib.reqNewsArticle throws synchronously (M1)", async () => {
      vi.useFakeTimers();
      try {
        // Build the 2-part Acme group first so the second poll's quiescence
        // sweep actually reaches the reqNewsArticle call.
        api.responsesByCall = [acmeEvents(), []];
        await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0);

        const boom = new Error("synchronous TWS failure");
        api.throwOnNewsArticle = boom;
        const ac = new AbortController();

        expect(vi.getTimerCount()).toBe(0);
        // Not an AbortError, so the part-loop's catch swallows it (same as
        // any other fetch failure) and leaves the group retryable — the poll
        // RESOLVES, it does not reject.
        const out = await pollDjNews(api, CRWD_CON_ID, WINDOW_START_UTC, NOW_UTC, state, T0 + 30_000, ac.signal);
        expect(out.completedReleases).toEqual([]);

        expect(vi.getTimerCount()).toBe(0);
        expect(api.listenerCount("newsArticle")).toBe(0);
        expect(api.listenerCount("error")).toBe(0);
        expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);

        const group = [...state.partGroups.values()].find((g) => g.articleIds.includes(ACME_PARTS[0].articleId));
        expect(group?.articleIds.length).toBe(2); // untouched — retryable next poll
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
