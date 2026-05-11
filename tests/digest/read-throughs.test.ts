import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getReadThroughReporterSymbols,
  getReadThroughsForTargets,
} from "@/lib/queries/read-through-pairs";
import {
  buildReadThroughEntries,
  renderReadThroughsBlock,
  renderPreviewPrompt,
  renderRecapPrompt,
  isPlausibleEarnings,
  type ReadThroughEntry,
  type EarningsPreviewContext,
  type EarningsRecapContext,
} from "@/lib/digest/send-earnings-email";
import type { CalendarEvent } from "@/lib/types";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedPair(args: {
  reporter: string;
  target: string;
  hypothesis?: string;
  weight?: number;
  groupLabel?: string | null;
}): void {
  db.prepare(
    `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, hypothesis, weight, group_label, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    args.reporter,
    args.target,
    args.hypothesis ?? "test hypothesis",
    args.weight ?? 1.0,
    args.groupLabel ?? null,
  );
}

function seedReporterEvent(args: {
  symbol: string;
  date: string;
  consensus?: string | null;
  actual?: string | null;
  reactionSnapshot?: object | null;
}): void {
  db.prepare(
    `INSERT INTO calendar_events
       (source, event_type, event_date, title, source_key, fetched_at, created_at,
        symbol, consensus_estimate, actual_value, reaction_snapshot)
     VALUES ('finnhub', 'earnings', ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?)`,
  ).run(
    args.date,
    `${args.symbol} earnings`,
    `finnhub:${args.symbol}:${args.date}`,
    args.symbol,
    args.consensus ?? null,
    args.actual ?? null,
    args.reactionSnapshot ? JSON.stringify(args.reactionSnapshot) : null,
  );
}

const fullReaction = (stockPct: number, spyPct = 0.5, qqqPct = 0.8) => ({
  t0_utc: "2026-04-29T20:00:00.000Z",
  window_min: 120,
  source: "yahoo" as const,
  spy: { t_pre: 600, t_post: 600 + spyPct, delta_pct: spyPct },
  qqq: { t_pre: 500, t_post: 500 + qqqPct, delta_pct: qqqPct },
  tlt: { t_pre: 90, t_post: 90, delta_pct: 0 },
  symbol: { symbol: "X", t_pre: 100, t_post: 100 + stockPct, delta_pct: stockPct },
});

// ── Query layer ─────────────────────────────────────────────────────────

describe("getReadThroughReporterSymbols", () => {
  it("returns empty array when table is empty", () => {
    expect(getReadThroughReporterSymbols(db)).toEqual([]);
  });

  it("returns distinct reporter symbols sorted", () => {
    seedPair({ reporter: "ZZZ", target: "AAA" });
    seedPair({ reporter: "AAA", target: "BBB" });
    seedPair({ reporter: "AAA", target: "CCC" }); // duplicate reporter
    expect(getReadThroughReporterSymbols(db)).toEqual(["AAA", "ZZZ"]);
  });
});

describe("getReadThroughsForTargets", () => {
  it("returns empty array for empty target list (avoids SQL syntax error)", () => {
    seedPair({ reporter: "PRTO", target: "XMTR" });
    expect(getReadThroughsForTargets(db, [])).toEqual([]);
  });

  it("filters by target and sorts by weight desc", () => {
    seedPair({ reporter: "GOOGL", target: "APP", weight: 0.85 });
    seedPair({ reporter: "META", target: "APP", weight: 0.85 });
    seedPair({ reporter: "PRTO", target: "APP", weight: 0.95 }); // not actually a real pair, just for sort test
    seedPair({ reporter: "X", target: "Y" }); // unrelated
    const rows = getReadThroughsForTargets(db, ["APP"]);
    expect(rows.map((r) => r.reporter_symbol)).toEqual(["PRTO", "GOOGL", "META"]);
    expect(rows.every((r) => r.target_symbol === "APP")).toBe(true);
  });

  it("supports multi-target lookup (issuerSiblings expansion)", () => {
    seedPair({ reporter: "GOOG-REPORTER", target: "GOOG" });
    seedPair({ reporter: "GOOGL-REPORTER", target: "GOOGL" });
    const rows = getReadThroughsForTargets(db, ["GOOG", "GOOGL"]);
    expect(rows).toHaveLength(2);
  });
});

// ── Build helper ────────────────────────────────────────────────────────

describe("buildReadThroughEntries", () => {
  it("returns empty when no pairs target the family", () => {
    seedPair({ reporter: "X", target: "OTHER" });
    expect(buildReadThroughEntries(db, ["APP"], "2026-05-06")).toEqual([]);
  });

  it("returns empty when pairs exist but no reporter has printed in the window", () => {
    seedPair({ reporter: "GOOGL", target: "APP" });
    // No calendar_events for GOOGL.
    expect(buildReadThroughEntries(db, ["APP"], "2026-05-06")).toEqual([]);
  });

  it("filters out reporters lacking actual_value", () => {
    seedPair({ reporter: "GOOGL", target: "APP" });
    seedReporterEvent({
      symbol: "GOOGL",
      date: "2026-04-29",
      consensus: "EPS 2.20 · Rev 95,000,000,000",
      actual: null, // missing actual
      reactionSnapshot: fullReaction(2.5),
    });
    expect(buildReadThroughEntries(db, ["APP"], "2026-05-06")).toEqual([]);
  });

  it("filters out reporters lacking reaction_snapshot", () => {
    seedPair({ reporter: "GOOGL", target: "APP" });
    seedReporterEvent({
      symbol: "GOOGL",
      date: "2026-04-29",
      consensus: "EPS 2.20 · Rev 95,000,000,000",
      actual: "EPS 2.27 · Rev 96,500,000,000",
      reactionSnapshot: null, // missing reaction
    });
    expect(buildReadThroughEntries(db, ["APP"], "2026-05-06")).toEqual([]);
  });

  it("includes reporter with both actual + reaction in window", () => {
    seedPair({
      reporter: "GOOGL",
      target: "APP",
      hypothesis: "ad-cluster read-through",
      weight: 0.85,
    });
    seedReporterEvent({
      symbol: "GOOGL",
      date: "2026-04-29",
      consensus: "EPS 2.20 · Rev 95,000,000,000",
      actual: "EPS 2.27 · Rev 96,500,000,000",
      reactionSnapshot: fullReaction(2.5, 0.3, 0.8),
    });
    const out = buildReadThroughEntries(db, ["APP"], "2026-05-06");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      reporter: "GOOGL",
      reporterEventDate: "2026-04-29",
      hypothesis: "ad-cluster read-through",
      weight: 0.85,
      consensusEps: 2.2,
      consensusRev: 95_000_000_000,
      actualEps: 2.27,
      actualRev: 96_500_000_000,
      reactionStockPct: 2.5,
      reactionSpyPct: 0.3,
      reactionQqqPct: 0.8,
    });
  });

  it("respects the 14-day lookback window — 14 days ago = include, 15 days = exclude", () => {
    // Anchor target event_date = 2026-05-06.
    // 14 days back = 2026-04-22 → include.
    // 15 days back = 2026-04-21 → exclude.
    seedPair({ reporter: "GOOGL", target: "APP" });
    seedPair({ reporter: "META", target: "APP" });
    seedReporterEvent({
      symbol: "GOOGL",
      date: "2026-04-22",
      actual: "EPS 1 · Rev 1000",
      reactionSnapshot: fullReaction(1),
    });
    seedReporterEvent({
      symbol: "META",
      date: "2026-04-21",
      actual: "EPS 1 · Rev 1000",
      reactionSnapshot: fullReaction(1),
    });
    const out = buildReadThroughEntries(db, ["APP"], "2026-05-06");
    expect(out.map((e) => e.reporter)).toEqual(["GOOGL"]);
  });

  it("dedups same reporter across sibling-class targets, keeping the highest-weight pair's hypothesis", () => {
    // GOOG and GOOGL are dual-class siblings; both targeted by GOOGL-REPORTER (made-up).
    seedPair({
      reporter: "RPR",
      target: "GOOGL",
      hypothesis: "GOOGL-flavored hypothesis",
      weight: 0.7,
    });
    seedPair({
      reporter: "RPR",
      target: "GOOG",
      hypothesis: "GOOG-flavored hypothesis (higher weight)",
      weight: 0.9,
    });
    seedReporterEvent({
      symbol: "RPR",
      date: "2026-05-01",
      actual: "EPS 1 · Rev 1000",
      reactionSnapshot: fullReaction(1),
    });
    const out = buildReadThroughEntries(db, ["GOOGL", "GOOG"], "2026-05-06");
    expect(out).toHaveLength(1);
    expect(out[0].hypothesis).toBe("GOOG-flavored hypothesis (higher weight)");
    expect(out[0].weight).toBe(0.9);
  });

  it("sorts entries by weight desc", () => {
    seedPair({ reporter: "LOW", target: "T", weight: 0.3 });
    seedPair({ reporter: "MID", target: "T", weight: 0.6 });
    seedPair({ reporter: "HIGH", target: "T", weight: 0.95 });
    for (const sym of ["LOW", "MID", "HIGH"]) {
      seedReporterEvent({
        symbol: sym,
        date: "2026-05-01",
        actual: "EPS 1 · Rev 1000",
        reactionSnapshot: fullReaction(1),
      });
    }
    const out = buildReadThroughEntries(db, ["T"], "2026-05-06");
    expect(out.map((e) => e.reporter)).toEqual(["HIGH", "MID", "LOW"]);
  });

  it("keeps the most-recent print when a reporter prints twice in the window", () => {
    seedPair({ reporter: "REP", target: "T" });
    seedReporterEvent({
      symbol: "REP",
      date: "2026-04-25",
      actual: "EPS 1 · Rev 1000",
      reactionSnapshot: fullReaction(1.0),
    });
    seedReporterEvent({
      symbol: "REP",
      date: "2026-05-01",
      actual: "EPS 2 · Rev 2000",
      reactionSnapshot: fullReaction(3.0),
    });
    const out = buildReadThroughEntries(db, ["T"], "2026-05-06");
    expect(out).toHaveLength(1);
    expect(out[0].reporterEventDate).toBe("2026-05-01");
    expect(out[0].actualEps).toBe(2);
    expect(out[0].reactionStockPct).toBe(3.0);
  });

  it("skips reporter with implausible Finnhub actual (GOOGL Q1 2026 reproduction)", () => {
    seedPair({ reporter: "GOOGL", target: "APP" });
    seedReporterEvent({
      symbol: "GOOGL",
      date: "2026-04-29",
      // Real values from the bogus snapshot the audit flagged — confirms
      // the guard intercepts data we know is wrong.
      consensus: "EPS 2.70 · Rev 109,769,274,463",
      actual: "EPS 5.11 · Rev 94,668,000,000",
      reactionSnapshot: fullReaction(2.7),
    });
    const out = buildReadThroughEntries(db, ["APP"], "2026-05-06");
    expect(out).toEqual([]);
  });

  it("keeps reporter with genuinely large but plausible beat (PWR-style +28% EPS)", () => {
    seedPair({ reporter: "PWR", target: "FAKE" });
    seedReporterEvent({
      symbol: "PWR",
      date: "2026-04-30",
      consensus: "EPS 2.09 · Rev 7,067,819,551",
      actual: "EPS 2.68 · Rev 7,874,790,000",
      reactionSnapshot: fullReaction(3.5),
    });
    const out = buildReadThroughEntries(db, ["FAKE"], "2026-05-06");
    expect(out).toHaveLength(1);
    expect(out[0].actualEps).toBe(2.68);
  });

  it("gracefully handles malformed reaction_snapshot JSON", () => {
    seedPair({ reporter: "REP", target: "T" });
    db.prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, source_key, fetched_at, created_at,
          symbol, consensus_estimate, actual_value, reaction_snapshot)
       VALUES ('finnhub', 'earnings', '2026-05-01', 'X', 'finnhub:REP:1', datetime('now'), datetime('now'),
               'REP', 'EPS 1 · Rev 1000', 'EPS 1.1 · Rev 1100', '{not valid json')`,
    ).run();
    const out = buildReadThroughEntries(db, ["T"], "2026-05-06");
    expect(out).toHaveLength(1);
    expect(out[0].reactionStockPct).toBeNull();
    expect(out[0].reactionSpyPct).toBeNull();
  });
});

// ── Render helper ───────────────────────────────────────────────────────

describe("renderReadThroughsBlock", () => {
  it("returns empty string when no entries", () => {
    expect(renderReadThroughsBlock({ symbol: "APP", readThroughs: [] })).toBe("");
  });

  it("renders a full bullet with consensus + actual + beats + reaction + hypothesis", () => {
    const entry: ReadThroughEntry = {
      reporter: "GOOGL",
      reporterEventDate: "2026-04-29",
      hypothesis: "ad-platform read-through",
      weight: 0.85,
      consensusEps: 2.2,
      consensusRev: 95_000_000_000,
      actualEps: 2.27,
      actualRev: 96_500_000_000,
      reactionStockPct: 2.5,
      reactionSpyPct: 0.3,
      reactionQqqPct: 0.8,
    };
    const out = renderReadThroughsBlock({ symbol: "APP", readThroughs: [entry] });
    expect(out).toContain("## Read-throughs from this earnings season");
    expect(out).toContain("**GOOGL** reported 2026-04-29");
    expect(out).toContain("Consensus: EPS $2.20 · Rev $95.00B");
    expect(out).toContain("Actual: EPS $2.27 · Rev $96.50B");
    // EPS dollar delta, revenue percent (96.5B vs 95B = +1.6%)
    expect(out).toContain("EPS +$0.07");
    expect(out).toContain("Rev +1.6%");
    expect(out).toContain("GOOGL +2.5% · SPY +0.3% · QQQ +0.8%");
    expect(out).toContain("ad-platform read-through");
  });

  it("uses dollar delta (not percent) for negative-consensus EPS", () => {
    // Loss-making name: consensus EPS −0.20, actual −0.18 → "+$0.02" (a beat)
    const entry: ReadThroughEntry = {
      reporter: "LOSS",
      reporterEventDate: "2026-04-30",
      hypothesis: null,
      weight: 1.0,
      consensusEps: -0.2,
      consensusRev: 1_000_000_000,
      actualEps: -0.18,
      actualRev: 1_010_000_000,
      reactionStockPct: 1,
      reactionSpyPct: 0,
      reactionQqqPct: 0,
    };
    const out = renderReadThroughsBlock({ symbol: "FOO", readThroughs: [entry] });
    expect(out).toContain("EPS +$0.02"); // dollar delta, not "%"
    expect(out).toContain("Rev +1.0%");
  });

  it("omits beat clause when consensus or actual is missing", () => {
    const entry: ReadThroughEntry = {
      reporter: "X",
      reporterEventDate: "2026-04-30",
      hypothesis: null,
      weight: 1.0,
      consensusEps: null,
      consensusRev: null,
      actualEps: 1.5,
      actualRev: 5_000_000_000,
      reactionStockPct: 1,
      reactionSpyPct: 0.1,
      reactionQqqPct: null,
    };
    const out = renderReadThroughsBlock({ symbol: "FOO", readThroughs: [entry] });
    expect(out).toContain("Actual: EPS $1.50 · Rev $5.00B."); // No "(EPS +..., Rev +...)" tail
    expect(out).not.toContain("Consensus:");
    expect(out).not.toContain("QQQ"); // QQQ omitted when null
  });

  it("omits hypothesis line when hypothesis is null", () => {
    const entry: ReadThroughEntry = {
      reporter: "X",
      reporterEventDate: "2026-05-01",
      hypothesis: null,
      weight: 1.0,
      consensusEps: 1,
      consensusRev: 100,
      actualEps: 1.1,
      actualRev: 110,
      reactionStockPct: 0.5,
      reactionSpyPct: 0.1,
      reactionQqqPct: 0.2,
    };
    const out = renderReadThroughsBlock({ symbol: "FOO", readThroughs: [entry] });
    expect(out).not.toContain("*Hypothesis:*");
  });
});

// ── Prompt-integration regressions (read-throughs slot into both flows) ──

function makeMinimalPreviewCtx(
  overrides: Partial<EarningsPreviewContext> = {},
): EarningsPreviewContext {
  const event: CalendarEvent = {
    id: 1,
    source: "finnhub",
    source_key: "finnhub:APP:2026-05-12",
    event_type: "earnings",
    event_date: "2026-05-12",
    event_time: "AMC",
    release_time: "16:01",
    title: "APP earnings",
    description: null,
    expected_impact: null,
    actual_value: null,
    consensus_estimate: "EPS $2.10 · Rev $1.10B",
    consensus_value: null,
    previous_value: null,
    reaction_snapshot: null,
    enriched_at: null,
    symbol: "APP",
    security_id: null,
    ib_con_id: null,
    week_of: "2026-05-11",
    raw_json: null,
    fetched_at: "2026-05-04 00:00:00",
    created_at: "2026-05-04 00:00:00",
  };

  return {
    symbol: "APP",
    family: ["APP"],
    event,
    positions: [],
    combinedShares: 0,
    combinedContracts: 0,
    userNotes: [],
    recentArticles: [],
    recommendationTrend: null,
    priceTarget: null,
    ratingChanges: null,
    recentPressReleases: null,
    priorTranscript: null,
    bogeys: [],
    readThroughs: [],
    ...overrides,
  };
}

const READ_THROUGH_FIXTURE: ReadThroughEntry = {
  reporter: "META",
  reporterEventDate: "2026-04-30",
  hypothesis: "ad-platform read-through",
  weight: 0.85,
  consensusEps: 5.0,
  consensusRev: 38_000_000_000,
  actualEps: 5.4,
  actualRev: 38_800_000_000,
  reactionStockPct: 4.2,
  reactionSpyPct: 0.3,
  reactionQqqPct: 0.8,
};

describe("renderPreviewPrompt — read-throughs integration", () => {
  it("renders the read-throughs section when entries exist", () => {
    const ctx = makeMinimalPreviewCtx({ readThroughs: [READ_THROUGH_FIXTURE] });
    const out = renderPreviewPrompt(ctx);
    expect(out).toContain("## Read-throughs from this earnings season");
    expect(out).toContain("**META** reported 2026-04-30");
    expect(out).toContain("ad-platform read-through");
  });

  it("omits the section silently when readThroughs is empty", () => {
    const ctx = makeMinimalPreviewCtx({ readThroughs: [] });
    const out = renderPreviewPrompt(ctx);
    expect(out).not.toContain("## Read-throughs");
  });
});

describe("renderRecapPrompt — read-throughs integration (sibling of preview)", () => {
  function makeRecapCtx(
    readThroughs: ReadThroughEntry[],
  ): EarningsRecapContext {
    const base = makeMinimalPreviewCtx({ readThroughs });
    return {
      ...base,
      reactionSnapshotMarkdown: "Stock +1.2%, SPY +0.3%, QQQ +0.5% (T+2h)",
      freshPressReleases: null,
    };
  }

  it("renders the read-throughs section when entries exist (recap mirror of preview)", () => {
    const out = renderRecapPrompt(makeRecapCtx([READ_THROUGH_FIXTURE]));
    expect(out).toContain("## Read-throughs from this earnings season");
    expect(out).toContain("**META** reported 2026-04-30");
    expect(out).toContain("ad-platform read-through");
    expect(out).toContain("EPS +$0.40"); // beat math present
  });

  it("omits the section silently when readThroughs is empty", () => {
    const out = renderRecapPrompt(makeRecapCtx([]));
    expect(out).not.toContain("## Read-throughs");
  });

  it("slots the section between newsletters and analyst (positionally consistent with preview)", () => {
    const out = renderRecapPrompt(makeRecapCtx([READ_THROUGH_FIXTURE]));
    const readThroughIdx = out.indexOf("## Read-throughs");
    // Both blocks may render as empty strings when there's no data, so we
    // check that read-throughs appears BEFORE the "Your task" output-spec
    // section (which comes after all context blocks).
    const taskIdx = out.indexOf("## Your task");
    expect(readThroughIdx).toBeGreaterThan(0);
    expect(taskIdx).toBeGreaterThan(readThroughIdx);
  });
});

describe("isPlausibleEarnings", () => {
  it("returns true when both fields are null (no claim either way)", () => {
    expect(isPlausibleEarnings(null, null, null, null)).toBe(true);
  });

  it("returns true on small beats/misses", () => {
    expect(isPlausibleEarnings(2.7, 2.62, 110_000_000_000, 109_900_000_000)).toBe(true);
  });

  it("returns true on a 28% EPS beat (PWR Q1 2026 — real)", () => {
    expect(isPlausibleEarnings(2.09, 2.68, 7_067_819_551, 7_874_790_000)).toBe(true);
  });

  it("returns false on EPS ≥ 70% above consensus (GOOGL bogus case 1.89×)", () => {
    expect(isPlausibleEarnings(2.7, 5.11, null, null)).toBe(false);
  });

  it("returns false on EPS ≤ 50% of consensus", () => {
    expect(isPlausibleEarnings(2.0, 0.5, null, null)).toBe(false);
  });

  it("returns false on revenue ≥ 40% above consensus", () => {
    expect(isPlausibleEarnings(null, null, 100_000_000, 145_000_000)).toBe(false);
  });

  it("returns false on revenue ≤ 70% of consensus (clear scrape error)", () => {
    expect(isPlausibleEarnings(null, null, 100_000_000, 60_000_000)).toBe(false);
  });

  it("preserves plausible 14% revenue miss (GOOGL real-world case)", () => {
    // Stored 94.67B vs consensus 109.77B → 0.86 ratio. NOT bogus by itself —
    // a 14% rev miss is unusual but realistic for guide-cut quarters.
    // The GOOGL row gets caught by the EPS guard, not this one.
    expect(
      isPlausibleEarnings(null, null, 109_769_274_463, 94_668_000_000),
    ).toBe(true);
  });

  it("does not divide by zero or trip on negative consensus", () => {
    expect(isPlausibleEarnings(0, 1, null, null)).toBe(true);
    expect(isPlausibleEarnings(-0.2, -0.18, null, null)).toBe(true);
  });

  it("returns true when negative consensus has matched-magnitude actual", () => {
    // Loss-making name: EPS -0.20 → -0.18 is a small beat. Not bogus.
    expect(isPlausibleEarnings(-0.2, -0.18, 1_000_000, 1_010_000)).toBe(true);
  });

  it("trailing — null safety on partial data", () => {
    expect(isPlausibleEarnings(2.0, null, 100_000_000, 99_000_000)).toBe(true);
    expect(isPlausibleEarnings(2.0, 2.1, null, null)).toBe(true);
  });
});

