/**
 * Earnings coverage in the cloud reads the Mac's own "held" answer
 * (snapshot v14, `earningsHeldSymbols`), so a name held only through a live
 * option or only short gets a cloud preview, recap, wrap membership, a "held"
 * chip and a print push, as it does on the Mac. Owner ruling 2026-10-09.
 *
 * Three snapshot shapes, for each earnings reader:
 *   (a) the new field, with an option-only and a short-only name;
 *   (b) no new field (a snapshot older than v14): behaviour as before;
 *   (c) a name that is in `heldSymbols` only.
 *
 * `heldSymbols` (long stock) keeps its meaning for the digest, the evening
 * email, the briefing and newsletter relevance: pinned at the end.
 *
 * The print-push gate is exercised in calendar-enrich.test.ts (same shapes).
 * Invented tickers and round figures only: the repo is public.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import type { FallbackEnv } from "../src/fallback-earnings";
import type { Snapshot } from "../src/state";

vi.mock("../src/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state")>();
  return { ...actual, loadLatestSnapshot: vi.fn() };
});

vi.mock("../src/resend", () => ({
  sendEmail: vi.fn(async () => ({ id: "mock-email-id" })),
}));

vi.mock("../src/ibkr-positions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ibkr-positions")>();
  return { ...actual, fetchLiveIbkrPositionsCached: vi.fn(async () => []) };
});

import { runEarningsFallback, renderPositions } from "../src/fallback-earnings";
import { earningsHeldSet } from "../src/earnings-held";
import { effectiveCalendarEvents, isCoveredInCloud } from "../src/armed-events";
import { buildTodaysReportersBlock } from "../src/todays-reporters";
import { partitionListingOnlyHeldBuckets, buildSynthesisPrompt } from "../src/fallback-evening";
import { renderBriefingHoldings } from "../src/fallback-briefing";
import { loadLatestSnapshot } from "../src/state";
import { sendEmail } from "../src/resend";
import { composeReleaseInstant } from "../src/reaction-matcher";

const EVENT_DATE = "2026-06-15";
const MIN = 60_000;

/** Long stock, option-only, short-only, in heldSymbols only, in neither. */
const LONG = "ZZL";
const OPTION_ONLY = "ZZO";
const SHORT_ONLY = "ZZS";
const OLD_LIST_ONLY = "ZZH";
const NEITHER = "ZZN";

function makeEnv(): FallbackEnv {
  const store = new Map<string, string>();
  return {
    CRON_KV: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
      list: vi.fn(async () => ({ keys: [] })),
    } as unknown as KVNamespace,
    ARCHIVE: {} as R2Bucket,
    BRIEFING_EMAIL_TO: "user@example.com",
    RESEND_API_KEY: "test-resend-key",
    RESEND_FROM_DOMAIN: "example.com",
  };
}

interface RowOpts {
  id: number;
  symbol: string;
  release_time?: string;
  event_time?: string | null;
  enriched_at?: string | null;
  actual_value?: string | null;
}

function row(o: RowOpts): Record<string, unknown> {
  return {
    id: o.id,
    week_of: EVENT_DATE,
    event_date: EVENT_DATE,
    event_type: "earnings",
    title: `${o.symbol} earnings`,
    description: null,
    symbol: o.symbol,
    event_time: o.event_time ?? null,
    release_time: o.release_time ?? "16:15",
    expected_impact: "high",
    source: "finnhub",
    source_key: `finnhub:${o.symbol}:${EVENT_DATE}`,
    raw_json: {},
    superseded: 0,
    enriched_at: o.enriched_at ?? null,
    consensus_estimate: "EPS 1.50 · Rev 90000000000",
    consensus_value: null,
    actual_value: o.actual_value ?? null,
    previous_value: null,
    reaction_snapshot: null,
  };
}

/** A small book: ZZL long, ZZS short, one long call on ZZO. */
const BOOK = {
  accounts: [{ id: 1, name: "Desk" }],
  securities: [
    { id: 1, symbol: LONG, name: null, security_type: "Stock", asset_class: null, sector: null, underlying_symbol: null, option_type: null, strike_price: null, expiration_date: null, multiplier: null },
    { id: 2, symbol: SHORT_ONLY, name: null, security_type: "Stock", asset_class: null, sector: null, underlying_symbol: null, option_type: null, strike_price: null, expiration_date: null, multiplier: null },
    { id: 3, symbol: "ZZO   270115C00050000", name: null, security_type: "Option", asset_class: null, sector: null, underlying_symbol: OPTION_ONLY, option_type: "CALL", strike_price: 50, expiration_date: "2027-01-15", multiplier: 100 },
  ],
  holdings: [
    { id: 1, account_id: 1, security_id: 1, quantity: 100, cost_basis: 1000, as_of_date: "2026-06-12" },
    { id: 2, account_id: 1, security_id: 2, quantity: -200, cost_basis: 2000, as_of_date: "2026-06-12" },
    { id: 3, account_id: 1, security_id: 3, quantity: 3, cost_basis: 300, as_of_date: "2026-06-12" },
  ],
};

/** What the Mac ships: `heldSymbols` is long stock; the new field adds the rest. */
const HELD_SYMBOLS = [LONG, OLD_LIST_ONLY];
const EARNINGS_HELD = [LONG, OPTION_ONLY, SHORT_ONLY];

type Shape = "with-field" | "old-snapshot";

function snapshotOf(events: Record<string, unknown>[], shape: Shape): Snapshot {
  const snap: Record<string, unknown> = {
    schemaVersion: shape === "with-field" ? 14 : 13,
    snapshotDate: EVENT_DATE,
    generatedAt: new Date().toISOString(),
    heldSymbols: HELD_SYMBOLS,
    watchlistSymbols: [],
    settings: { last_digest_sent_at: null, last_briefing_sent_at: null },
    calendarEvents: events,
    earningsEmails: [],
    researchSources: [],
    recentArticlesMeta: [],
    deepReadArticles: [],
    ...BOOK,
  };
  if (shape === "with-field") snap.earningsHeldSymbols = EARNINGS_HELD;
  return snap as unknown as Snapshot;
}

/** 110 minutes before the release: inside the Worker's preview window. */
const previewNow = (releaseTime: string): Date =>
  new Date(composeReleaseInstant(EVENT_DATE, releaseTime)!.getTime() - 110 * MIN);

const sentSymbols = (r: Awaited<ReturnType<typeof runEarningsFallback>>, phase: string) =>
  r.details
    .filter((d) => d.status === "sent" && d.phase === phase)
    .map((d) => d.symbol)
    .sort();

const htmlFor = (symbol: string): string => {
  const call = vi.mocked(sendEmail).mock.calls.find((c) =>
    String((c[1] as { subject: string }).subject).includes(symbol),
  );
  if (!call) throw new Error(`no email sent for ${symbol}`);
  return (call[1] as { html: string }).html;
};

const ALL = [LONG, OPTION_ONLY, SHORT_ONLY, OLD_LIST_ONLY, NEITHER];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue({ id: "mock-email-id" } as never);
});

// ── The one reader ───────────────────────────────────────────────────────────

describe("earningsHeldSet", () => {
  it("(a) the field is the held set: option-only and short-only names are in", () => {
    const set = earningsHeldSet({ heldSymbols: HELD_SYMBOLS, earningsHeldSymbols: EARNINGS_HELD });
    expect([...set].sort()).toEqual([LONG, OPTION_ONLY, SHORT_ONLY]);
  });

  it("(b) no field: heldSymbols, exactly as before", () => {
    const set = earningsHeldSet({ heldSymbols: HELD_SYMBOLS });
    expect([...set].sort()).toEqual([OLD_LIST_ONLY, LONG].sort());
  });

  it("(c) the field replaces heldSymbols: a name in heldSymbols only is not earnings-held", () => {
    const set = earningsHeldSet({ heldSymbols: HELD_SYMBOLS, earningsHeldSymbols: EARNINGS_HELD });
    expect(set.has(OLD_LIST_ONLY)).toBe(false);
  });

  it("an EMPTY field means no held names; it does not fall back", () => {
    expect(earningsHeldSet({ heldSymbols: HELD_SYMBOLS, earningsHeldSymbols: [] }).size).toBe(0);
  });

  it("a field that is not a list reads as absent", () => {
    const bad = { heldSymbols: [LONG], earningsHeldSymbols: null } as unknown as Snapshot;
    expect([...earningsHeldSet(bad)]).toEqual([LONG]);
  });

  it("upper-cases and drops blanks", () => {
    const set = earningsHeldSet({ heldSymbols: [], earningsHeldSymbols: ["zzl", "", "ZZL"] });
    expect([...set]).toEqual([LONG]);
  });
});

describe("isCoveredInCloud", () => {
  const covered = (shape: Shape, symbol: string): boolean => {
    const snap = snapshotOf([row({ id: 1, symbol })], shape);
    return isCoveredInCloud(snap, effectiveCalendarEvents(snap, null), { id: 1, symbol });
  };

  it("(a) with the field: long, option-only and short-only are covered", () => {
    expect(ALL.filter((s) => covered("with-field", s))).toEqual([LONG, OPTION_ONLY, SHORT_ONLY]);
  });

  it("(b) old snapshot: only what heldSymbols lists, as before", () => {
    expect(ALL.filter((s) => covered("old-snapshot", s))).toEqual([LONG, OLD_LIST_ONLY]);
  });

  it("stays family-aware over the new field (GOOGL event, GOOG held through an option)", () => {
    const snap = {
      ...snapshotOf([], "with-field"),
      earningsHeldSymbols: ["GOOG"],
    } as unknown as Snapshot;
    const eff = effectiveCalendarEvents(snap, null);
    expect(isCoveredInCloud(snap, eff, { id: 9, symbol: "GOOGL" })).toBe(true);
  });

  it("the watchlist still covers a name the held set does not", () => {
    const snap = {
      ...snapshotOf([], "with-field"),
      watchlistSymbols: [NEITHER],
    } as unknown as Snapshot;
    expect(isCoveredInCloud(snap, effectiveCalendarEvents(snap, null), { id: 9, symbol: NEITHER })).toBe(true);
  });
});

// ── Preview ──────────────────────────────────────────────────────────────────

describe("cloud preview", () => {
  const events = () => ALL.map((symbol, i) => row({ id: i + 1, symbol }));

  it("(a) with the field: previews for the long, the option-only and the short-only name", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(events(), "with-field"));
    const res = await runEarningsFallback(makeEnv(), { now: previewNow("16:15") });
    expect(sentSymbols(res, "preview")).toEqual([LONG, OPTION_ONLY, SHORT_ONLY]);
  });

  it("(b) old snapshot: previews for heldSymbols names only, as before", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(events(), "old-snapshot"));
    const res = await runEarningsFallback(makeEnv(), { now: previewNow("16:15") });
    expect(sentSymbols(res, "preview")).toEqual([OLD_LIST_ONLY, LONG].sort());
  });

  it("(c) a name in heldSymbols only gets no preview once the field is present", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(events(), "with-field"));
    const res = await runEarningsFallback(makeEnv(), { now: previewNow("16:15") });
    expect(sentSymbols(res, "preview")).not.toContain(OLD_LIST_ONLY);
    expect(res.details.some((d) => d.symbol === OLD_LIST_ONLY)).toBe(false);
  });

  it("a muted option-only name stays silent", async () => {
    const snap = {
      ...snapshotOf(events(), "with-field"),
      earningsSettings: { enabled: true, mutedSymbols: [OPTION_ONLY] },
    } as unknown as Snapshot;
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snap);
    const res = await runEarningsFallback(makeEnv(), { now: previewNow("16:15") });
    expect(sentSymbols(res, "preview")).toEqual([LONG, SHORT_ONLY]);
  });
});

// ── Recap ────────────────────────────────────────────────────────────────────

describe("cloud recap", () => {
  // Enriched 15 minutes before `now`; two names, so no wrap cluster forms.
  const now = new Date("2026-06-15T20:30:00Z");
  const recapRow = (id: number, symbol: string) =>
    row({
      id,
      symbol,
      release_time: "07:00",
      event_time: "BMO",
      enriched_at: "2026-06-15 20:15:00",
      actual_value: "EPS 1.60 · Rev 91000000000",
    });
  const events = () => ALL.map((symbol, i) => recapRow(i + 1, symbol));

  it("(a) with the field: recaps for the long, the option-only and the short-only name", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(events(), "with-field"));
    const res = await runEarningsFallback(makeEnv(), { now });
    expect(sentSymbols(res, "recap")).toEqual([LONG, OPTION_ONLY, SHORT_ONLY]);
  });

  it("(b) old snapshot: recaps for heldSymbols names only, as before", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(events(), "old-snapshot"));
    const res = await runEarningsFallback(makeEnv(), { now });
    expect(sentSymbols(res, "recap")).toEqual([OLD_LIST_ONLY, LONG].sort());
  });

  it("(c) a name in heldSymbols only gets no recap once the field is present", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(events(), "with-field"));
    const res = await runEarningsFallback(makeEnv(), { now });
    expect(sentSymbols(res, "recap")).not.toContain(OLD_LIST_ONLY);
  });
});

// ── Wrap (suppress-for-debrief) cluster ──────────────────────────────────────

describe("after-close wrap cluster", () => {
  const now = new Date("2026-06-15T22:30:00Z"); // 18:30 Eastern
  const amc = (id: number, symbol: string) =>
    row({ id, symbol, release_time: "16:00", event_time: "AMC", actual_value: "EPS 1.60 · Rev 91000000000" });
  const events = () => [amc(1, LONG), amc(2, OPTION_ONLY), amc(3, SHORT_ONLY), amc(4, OLD_LIST_ONLY)];
  const wrapped = (r: Awaited<ReturnType<typeof runEarningsFallback>>) =>
    r.details
      .filter((d) => d.reason === "wrap-suppressed-for-debrief")
      .map((d) => d.symbol)
      .sort();

  it("(a) with the field: the option-only and short-only names count toward the cluster of three", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(events(), "with-field"));
    const res = await runEarningsFallback(makeEnv(), { now });
    expect(wrapped(res)).toEqual([LONG, OPTION_ONLY, SHORT_ONLY]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("(b) old snapshot: two heldSymbols names, under the threshold, no wrap, as before", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(events(), "old-snapshot"));
    const res = await runEarningsFallback(makeEnv(), { now });
    expect(wrapped(res)).toEqual([]);
  });

  it("(c) a name in heldSymbols only is not a cluster member once the field is present", async () => {
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(events(), "with-field"));
    const res = await runEarningsFallback(makeEnv(), { now });
    expect(wrapped(res)).not.toContain(OLD_LIST_ONLY);
  });
});

// ── Today's reporters chip ───────────────────────────────────────────────────

describe("today's reporters chip", () => {
  const events = () => ALL.map((symbol, i) => row({ id: i + 1, symbol, release_time: "08:00" }));
  const chips = (shape: Shape): Record<string, string> => {
    const block = buildTodaysReportersBlock(snapshotOf(events(), shape), EVENT_DATE)!;
    const out: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (ALL.includes(cells[2])) out[cells[2]] = cells[3];
    }
    return out;
  };

  it("(a) with the field: held chip on the long, option-only and short-only names", () => {
    const c = chips("with-field");
    expect(c[LONG]).toBe("held");
    expect(c[OPTION_ONLY]).toBe("held");
    expect(c[SHORT_ONLY]).toBe("held");
    expect(c[NEITHER]).not.toBe("held");
  });

  it("(b) old snapshot: held chip on heldSymbols names only, as before", () => {
    const c = chips("old-snapshot");
    expect(Object.keys(c).filter((s) => c[s] === "held").sort()).toEqual([OLD_LIST_ONLY, LONG].sort());
  });

  it("(c) a name in heldSymbols only has no held chip once the field is present", () => {
    expect(chips("with-field")[OLD_LIST_ONLY]).not.toBe("held");
  });
});

// ── Direction and wording ────────────────────────────────────────────────────

describe("position wording for a short-only and an option-only name", () => {
  it("the cloud preview names the short as short and the option as an option, never as long stock", async () => {
    const events = [OPTION_ONLY, SHORT_ONLY].map((symbol, i) => row({ id: i + 1, symbol }));
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(events, "with-field"));
    await runEarningsFallback(makeEnv(), { now: previewNow("16:15") });

    const short = htmlFor(SHORT_ONLY);
    expect(short).toContain(`short ${SHORT_ONLY} (Desk)`);
    expect(short).toContain("short shares");
    expect(short).not.toContain(`long ${SHORT_ONLY}`);
    expect(short).not.toContain("long shares");

    const option = htmlFor(OPTION_ONLY);
    expect(option).toContain(`long ${OPTION_ONLY} $50 calls exp 2027-01-15 (Desk)`);
    expect(option).toContain("long options");
    expect(option).not.toContain("long shares");
    expect(option).not.toContain(`long ${OPTION_ONLY} (Desk)`);
  });

  it("direction only: no share count, contract count or cost basis reaches the email", async () => {
    const events = [OPTION_ONLY, SHORT_ONLY].map((symbol, i) => row({ id: i + 1, symbol }));
    vi.mocked(loadLatestSnapshot).mockResolvedValue(snapshotOf(events, "with-field"));
    await runEarningsFallback(makeEnv(), { now: previewNow("16:15") });
    // The book's quantities (200 short, 3 contracts) and basis figures.
    const positionsOf = (html: string) => html.slice(html.indexOf("Positions"), html.indexOf("Combined exposure") + 80);
    expect(positionsOf(htmlFor(SHORT_ONLY))).not.toMatch(/\b200\b|\b2,?000\b/);
    expect(positionsOf(htmlFor(OPTION_ONLY))).not.toMatch(/\b3 (long|short|contract)|\b300\b/);
  });

  it("renderPositions: a short stock and a short put read as short", () => {
    const text = renderPositions(
      [
        { account_name: "Desk", symbol: SHORT_ONLY, security_type: "Stock", underlying_symbol: null, option_type: null, strike_price: null, expiration_date: null, multiplier: null, quantity: -200, cost_basis: null },
        { account_name: "Desk", symbol: "ZZS   270115P00040000", security_type: "Option", underlying_symbol: SHORT_ONLY, option_type: "PUT", strike_price: 40, expiration_date: "2027-01-15", multiplier: 100, quantity: -1, cost_basis: null },
      ],
      SHORT_ONLY,
      [SHORT_ONLY],
    );
    expect(text).toContain(`- short ${SHORT_ONLY} (Desk)`);
    expect(text).toContain(`- short ${SHORT_ONLY} $40 puts exp 2027-01-15 (Desk)`);
    expect(text).toContain("**Combined exposure:** short shares + short options");
    expect(text).not.toMatch(/long/);
  });
});

// ── Everything else keeps reading heldSymbols ────────────────────────────────

describe("non-earnings readers are untouched by the new field", () => {
  it("only earnings-held.ts reads earningsHeldSymbols, and only the three earnings readers call it", () => {
    const dir = new URL("../src/", import.meta.url);
    const readers: string[] = [];
    const callers: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const code = readFileSync(new URL(name, dir), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      if (/\.earningsHeldSymbols\b/.test(code)) readers.push(name);
      if (/\bearningsHeldSet\s*\(/.test(code) && name !== "earnings-held.ts") callers.push(name);
    }
    expect(readers).toEqual(["earnings-held.ts"]);
    expect(callers.sort()).toEqual(["armed-events.ts", "calendar-enrich.ts", "todays-reporters.ts"]);
  });

  it("no earnings reader still builds its held set from heldSymbols by hand", () => {
    for (const name of ["armed-events.ts", "calendar-enrich.ts", "todays-reporters.ts"]) {
      const code = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code, name).not.toMatch(/\.heldSymbols\b/);
    }
  });

  it("the digest, evening, briefing and newsletter files still read heldSymbols", () => {
    for (const name of ["fallback-digest.ts", "fallback-evening.ts", "fallback-briefing.ts", "newsletter-fetch.ts"]) {
      const code = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
      expect(code, name).toMatch(/\.heldSymbols\b/);
      expect(code, name).not.toMatch(/earningsHeld/);
    }
  });

  it("the evening roster, the evening prompt and the pre-v7 briefing list give one answer with or without the field", () => {
    const withField = snapshotOf([], "with-field");
    const old = snapshotOf([], "old-snapshot");

    const listing = { mentioned_symbols: JSON.stringify(["A", "B", "C", "D", "E", "F", "G", "H"]) };
    const buckets = { [OPTION_ONLY]: [listing], [OLD_LIST_ONLY]: [listing] } as never;
    const roster = (s: Snapshot) => partitionListingOnlyHeldBuckets(buckets, s.heldSymbols).rosterSymbols;
    expect(roster(withField)).toEqual([OLD_LIST_ONLY]);
    expect(roster(withField)).toEqual(roster(old));

    expect(buildSynthesisPrompt({}, withField)).toBe(buildSynthesisPrompt({}, old));
    expect(buildSynthesisPrompt({}, withField)).not.toContain(OPTION_ONLY);

    expect(renderBriefingHoldings(withField)).toBe(renderBriefingHoldings(old));
    expect(renderBriefingHoldings(withField)).toBe(`${LONG}, ${OLD_LIST_ONLY}`);
  });
});
