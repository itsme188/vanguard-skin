/**
 * A pending reaction never prints as a percent in an email, the briefing, the
 * macro-themes prompt, the chat tool or a push (N2, 2026-10-08).
 *
 * lib/calendar/reaction-validity.ts decides "measured" vs "pending". The
 * on-screen chips already obeyed it; these are the TEXT readers. Outbound text
 * and prompts omit a pending leg; only in-app surfaces say "pending".
 *
 * Every snapshot below is the stored shape (lib/calendar/reaction-snapshot-core.ts)
 * with synthetic tickers and invented round prices.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  formatReactionSnapshot,
  renderHeadlineTable,
  buildReadThroughEntries,
} from "@/lib/digest/send-earnings-email";
import { formatReleasedEventForPrompt } from "@/lib/calendar/briefing";
import { buildMacroPromptInputs, buildMacroSignalBlob } from "@/lib/compute/macro-themes";
import { composePrintPushMessage } from "@/lib/alerts/print-push-message";
import { executeTool } from "@/lib/chat/tools";
import { readReactionLegs } from "@/lib/calendar/reaction-validity";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import type { CalendarEvent } from "@/lib/types";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// Release 20:15 UTC, two-hour window: measurable from 22:15 UTC.
const T0 = "2026-09-10T20:15:00.000Z";
const AFTER_WINDOW = "2026-09-10T22:16:00.000Z";
const BEFORE_WINDOW = "2026-09-10T20:20:00.000Z";

const LEGS = {
  symbol: { symbol: "ZZA", t_pre: 100, t_post: 104, delta_pct: 4 },
  spy: { t_pre: 600, t_post: 603, delta_pct: 0.5 },
  qqq: { t_pre: 500, t_post: 496, delta_pct: -0.8 },
  tlt: { t_pre: 90, t_post: 90.9, delta_pct: 1 },
  sector: { symbol: "XLK", t_pre: 200, t_post: 203, delta_pct: 1.5 },
};

/** Captured by the Mac runner after the window ended: every leg is measured. */
const MEASURED = { t0_utc: T0, window_min: 120, source: "tws", pre_anchor: "prior_close", ...LEGS, captured_at: AFTER_WINDOW };
/** Same figures with no capture stamp (older rows): still measured. */
const MEASURED_LEGACY = { t0_utc: T0, window_min: 120, source: "tws", pre_anchor: "prior_close", ...LEGS };
/** Captured five minutes after the release: nothing is a measurement yet. */
const PREMATURE = { ...MEASURED, captured_at: BEFORE_WINDOW };
/** Older row, SPY pre and post are the same price: SPY alone is pending. */
const LEGACY_SPY_ECHO = { ...MEASURED_LEGACY, spy: { t_pre: 600, t_post: 600, delta_pct: 0 } };
/** Older row whose every leg is an identical pre/post pair. */
const LEGACY_ALL_ECHO = {
  t0_utc: T0, window_min: 120, source: "yahoo",
  symbol: { symbol: "ZZA", t_pre: 100, t_post: 100, delta_pct: 0 },
  spy: { t_pre: 600, t_post: 600, delta_pct: 0 },
  qqq: { t_pre: 500, t_post: 500, delta_pct: 0 },
  tlt: { t_pre: 90, t_post: 90, delta_pct: 0 },
};
/** Older row: a 0.00% SPY move that only the row's early enriched_at exposes. */
const LEGACY_ZERO_SPY = { ...MEASURED_LEGACY, spy: { t_pre: 600, t_post: 600.001, delta_pct: 0 } };
const EARLY_ENRICHED_AT = "2026-09-10 20:20:00";
const LATE_ENRICHED_AT = "2026-09-10 22:30:00";

const j = (o: unknown) => JSON.stringify(o);

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 1,
    source: "finnhub",
    event_type: "earnings",
    event_date: "2026-09-10",
    event_time: "AMC",
    title: "ZZA earnings",
    description: null,
    security_id: null,
    symbol: "ZZA",
    ib_con_id: null,
    expected_impact: null,
    consensus_estimate: "EPS 1.00 · Rev 500M",
    previous_value: null,
    raw_json: null,
    source_key: "finnhub:ZZA:2026-09-10",
    week_of: "2026-09-07",
    fetched_at: "2026-09-01 00:00:00",
    created_at: "2026-09-01 00:00:00",
    release_time: "16:15",
    actual_value: "EPS 1.10 · Rev 520M",
    consensus_value: null,
    reaction_snapshot: null,
    enriched_at: LATE_ENRICHED_AT,
    ...overrides,
  } as CalendarEvent;
}

describe("readReactionLegs — the one read path", () => {
  it("sorts legs into measured and pending and returns null for nothing readable", () => {
    expect(readReactionLegs(null)).toBeNull();
    expect(readReactionLegs("{not json")).toBeNull();
    expect(readReactionLegs("7")).toBeNull();
    const all = readReactionLegs(j(MEASURED))!;
    expect(Object.keys(all.measured).sort()).toEqual(["qqq", "sector", "spy", "symbol", "tlt"]);
    expect(all.pending).toEqual([]);
    const early = readReactionLegs(j(PREMATURE))!;
    expect(early.measured).toEqual({});
    expect(early.pending.sort()).toEqual(["qqq", "sector", "spy", "symbol", "tlt"]);
    const echo = readReactionLegs(LEGACY_SPY_ECHO as never)!;
    expect(echo.pending).toEqual(["spy"]);
    expect(echo.measured.qqq?.delta_pct).toBe(-0.8);
    // The enriched_at rule only bites with the row's stamp in hand.
    expect(readReactionLegs(j(LEGACY_ZERO_SPY))!.pending).toEqual([]);
    expect(readReactionLegs(j(LEGACY_ZERO_SPY), { rowEnrichedAt: EARLY_ENRICHED_AT })!.pending).toEqual(["spy"]);
    expect(readReactionLegs(j(LEGACY_ZERO_SPY), { rowEnrichedAt: LATE_ENRICHED_AT })!.pending).toEqual([]);
  });
});

describe("recap prompt block (formatReactionSnapshot)", () => {
  const FULL = [
    "- Window: moves vs prior close, measured at T+120 minutes (source: tws)",
    "- ZZA: +4.00%",
    "- SPY: +0.50%",
    "- QQQ: -0.80%",
    "- TLT: +1.00%",
    "- XLK: +1.50%",
  ].join("\n");

  it("all legs measured: unchanged text", () => {
    expect(formatReactionSnapshot(j(MEASURED))).toBe(FULL);
    expect(formatReactionSnapshot(j(MEASURED_LEGACY))).toBe(FULL);
  });
  it("one pending leg: that leg is absent, the rest unchanged", () => {
    expect(formatReactionSnapshot(j(LEGACY_SPY_ECHO))).toBe(
      FULL.split("\n").filter((l) => !l.includes("SPY")).join("\n"),
    );
  });
  it("all pending: null, so the prompt takes its not-yet-captured branch", () => {
    expect(formatReactionSnapshot(j(PREMATURE))).toBeNull();
    expect(formatReactionSnapshot(j(LEGACY_ALL_ECHO))).toBeNull();
  });
  it("legacy zero move on a row enriched before the window: pending with the stamp", () => {
    expect(formatReactionSnapshot(j(LEGACY_ZERO_SPY))).toContain("- SPY: +0.00%");
    expect(formatReactionSnapshot(j(LEGACY_ZERO_SPY), { rowEnrichedAt: EARLY_ENRICHED_AT })).not.toContain("SPY");
  });
});

describe("scoreboard reaction rows (renderHeadlineTable)", () => {
  const INTEL = {
    impliedMovePct: 4.8,
    impliedMethod: "straddle",
    impliedExpiry: "2026-09-18",
    summary: { avgAbsMovePct: 4.6, beatCount: 4, missCount: 4, quarterCount: 8 },
  } as never;
  const rowsOf = (md: string) => md.split("\n").filter((l) => l.includes("@ T+2h") || l.includes("**Expected move**"));

  it("all legs measured: unchanged rows", () => {
    const md = renderHeadlineTable(makeEvent({ reaction_snapshot: j(MEASURED) }), "ZZA", "recap", INTEL);
    const rows = rowsOf(md);
    expect(rows[0]).toMatch(/\| \+4\.0% \| inside \|$/);
    expect(rows.slice(1)).toEqual([
      "| **ZZA @ T+2h** | — | +4.00% | — |",
      "| **SPY @ T+2h** | — | +0.50% | — |",
      "| **QQQ @ T+2h** | — | -0.80% | — |",
    ]);
  });
  it("one pending leg: the email scoreboard shows a dash for it, never the percent", () => {
    const rows = rowsOf(renderHeadlineTable(makeEvent({ reaction_snapshot: j(LEGACY_SPY_ECHO) }), "ZZA", "recap", INTEL));
    expect(rows.slice(1)).toEqual([
      "| **ZZA @ T+2h** | — | +4.00% | — |",
      "| **SPY @ T+2h** | — | — | — |",
      "| **QQQ @ T+2h** | — | -0.80% | — |",
    ]);
  });
  it("all pending: every reaction cell is a dash and no inside/outside verdict is published", () => {
    const md = renderHeadlineTable(makeEvent({ reaction_snapshot: j(PREMATURE) }), "ZZA", "recap", INTEL);
    const rows = rowsOf(md);
    expect(rows[0]).toMatch(/\| — \| — no reaction quote \|$/);
    expect(rows.slice(1)).toEqual([
      "| **ZZA @ T+2h** | — | — | — |",
      "| **SPY @ T+2h** | — | — | — |",
      "| **QQQ @ T+2h** | — | — | — |",
    ]);
    expect(md).not.toContain("pending");
    expect(md).not.toContain("%  |");
  });
  it("threads the row's enriched_at for the legacy zero-move rule", () => {
    const late = rowsOf(renderHeadlineTable(makeEvent({ reaction_snapshot: j(LEGACY_ZERO_SPY) }), "ZZA", "recap", INTEL));
    expect(late).toContain("| **SPY @ T+2h** | — | +0.00% | — |");
    const early = rowsOf(
      renderHeadlineTable(makeEvent({ reaction_snapshot: j(LEGACY_ZERO_SPY), enriched_at: EARLY_ENRICHED_AT }), "ZZA", "recap", INTEL),
    );
    expect(early).toContain("| **SPY @ T+2h** | — | — | — |");
  });
  it("in-app viewer mode says pending where the email shows a dash", () => {
    const rows = rowsOf(
      renderHeadlineTable(makeEvent({ reaction_snapshot: j(PREMATURE) }), "ZZA", "recap", INTEL, { pendingReactionLabel: true }),
    );
    expect(rows[0]).toMatch(/\| — \| — reaction pending \|$/);
    expect(rows.slice(1)).toEqual([
      "| **ZZA @ T+2h** | — | pending | — |",
      "| **SPY @ T+2h** | — | pending | — |",
      "| **QQQ @ T+2h** | — | pending | — |",
    ]);
    // Measured legs read the same in both modes.
    expect(
      renderHeadlineTable(makeEvent({ reaction_snapshot: j(MEASURED) }), "ZZA", "recap", INTEL, { pendingReactionLabel: true }),
    ).toBe(renderHeadlineTable(makeEvent({ reaction_snapshot: j(MEASURED) }), "ZZA", "recap", INTEL));
  });
});

describe("weekly briefing released-event line (formatReleasedEventForPrompt)", () => {
  const line = (snapshot: unknown, enriched_at = LATE_ENRICHED_AT) =>
    formatReleasedEventForPrompt(makeEvent({ reaction_snapshot: j(snapshot), enriched_at }), 1);

  it("all legs measured: unchanged text", () => {
    expect(line(MEASURED)).toBe(
      "- 1. **ZZA earnings** (2026-09-10) — actual EPS 1.10 · Rev 520M · SPY +0.50% / QQQ -0.80% / TLT +1.00% / XLK +1.50%",
    );
    expect(line(MEASURED_LEGACY)).toBe(line(MEASURED));
  });
  it("one pending leg: that leg is absent", () => {
    expect(line(LEGACY_SPY_ECHO)).toBe(
      "- 1. **ZZA earnings** (2026-09-10) — actual EPS 1.10 · Rev 520M · QQQ -0.80% / TLT +1.00% / XLK +1.50%",
    );
  });
  it("all pending: no reaction text at all", () => {
    const bare = "- 1. **ZZA earnings** (2026-09-10) — actual EPS 1.10 · Rev 520M";
    expect(line(PREMATURE)).toBe(bare);
    expect(line(LEGACY_ALL_ECHO)).toBe(bare);
  });
  it("uses the row's enriched_at for the legacy zero-move rule", () => {
    expect(line(LEGACY_ZERO_SPY)).toContain("SPY 0.00%");
    expect(line(LEGACY_ZERO_SPY, EARLY_ENRICHED_AT)).not.toContain("SPY");
  });
});

describe("print push message (composePrintPushMessage)", () => {
  const push = (snapshot: unknown) =>
    composePrintPushMessage({
      symbol: "ZZA",
      actualValue: "EPS 1.10",
      consensusValue: "EPS 1.00",
      reactionJson: j(snapshot),
    }).message;

  it("all legs measured: unchanged text", () => {
    expect(push(MEASURED)).toBe("EPS 1.10 vs 1.00 est · ZZA +4.00% vs SPY +0.50% (T+2h)");
    expect(push(MEASURED_LEGACY)).toBe("EPS 1.10 vs 1.00 est · ZZA +4.00% vs SPY +0.50% (T+2h)");
  });
  it("a pending leg on either side drops the whole reaction tail", () => {
    expect(push(LEGACY_SPY_ECHO)).toBe("EPS 1.10 vs 1.00 est");
    expect(push(PREMATURE)).toBe("EPS 1.10 vs 1.00 est");
    expect(push(LEGACY_ALL_ECHO)).toBe("EPS 1.10 vs 1.00 est");
  });
  it("agrees with reactionLegVerdict on what the snapshot alone can prove", () => {
    const table: unknown[] = [
      MEASURED, MEASURED_LEGACY, PREMATURE, LEGACY_SPY_ECHO, LEGACY_ALL_ECHO, LEGACY_ZERO_SPY,
      { ...MEASURED, captured_at: "2026-09-10T22:15:00.000Z" }, // exactly at the window end
      { ...MEASURED, captured_at: "2026-09-10T22:14:59.000Z" },
      { ...MEASURED, captured_at: "2026-09-10 22:16:00" }, // SQLite UTC form
      { ...MEASURED, window_min: undefined },
      { ...MEASURED, window_min: 30, captured_at: "2026-09-10T20:50:00.000Z" },
      { ...MEASURED, t0_utc: "soon" },
      { ...MEASURED_LEGACY, t0_utc: undefined },
      { ...MEASURED, symbol: { symbol: "ZZA", t_pre: 0, t_post: 0, delta_pct: 0 } },
    ];
    for (const snapshot of table) {
      const read = readReactionLegs(j(snapshot))!;
      const bothMeasured = read.measured.symbol != null && read.measured.spy != null;
      expect(push(snapshot).includes("(T+2h)"), j(snapshot)).toBe(bothMeasured);
    }
  });
  it("a capture stamp with an unreadable release instant fails closed", () => {
    expect(push({ ...MEASURED, t0_utc: "soon" })).toBe("EPS 1.10 vs 1.00 est");
  });
});

describe("readers that load rows from the database", () => {
  let db: Database.Database;
  let seq = 0;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    hoisted.db = db;
    seq = 0;
  });

  function seedEvent(opts: {
    symbol: string | null;
    type?: string;
    date: string;
    snapshot: unknown;
    enrichedAt?: string;
  }): number {
    seq += 1;
    return Number(
      db
        .prepare(
          `INSERT INTO calendar_events
             (source, source_key, event_type, event_date, week_of, title, symbol, actual_value,
              consensus_estimate, consensus_value, enriched_at, reaction_snapshot)
           VALUES ('finnhub', ?, ?, ?, ?, ?, ?, 'EPS 1.10', 'EPS 1.00', 'EPS 1.00', ?, ?)`,
        )
        .run(
          `test:n2:${seq}`,
          opts.type ?? "earnings",
          opts.date,
          opts.date,
          `${opts.symbol ?? "Synthetic release"} ${seq}`,
          opts.symbol,
          opts.enrichedAt ?? LATE_ENRICHED_AT,
          j(opts.snapshot),
        ).lastInsertRowid,
    );
  }

  describe("read-through bullets (buildReadThroughEntries)", () => {
    function entryFor(snapshot: unknown, enrichedAt?: string) {
      db.prepare(
        `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, hypothesis, weight, group_label, created_at)
         VALUES ('ZZA', 'ZZB', 'synthetic read-through', 1.0, NULL, datetime('now'))`,
      ).run();
      seedEvent({ symbol: "ZZA", date: "2026-09-10", snapshot, enrichedAt });
      const entries = buildReadThroughEntries(db, ["ZZB"], "2026-09-12");
      expect(entries).toHaveLength(1);
      return entries[0];
    }

    it("all legs measured: the figures are carried", () => {
      const e = entryFor(MEASURED);
      expect([e.reactionStockPct, e.reactionSpyPct, e.reactionQqqPct]).toEqual([4, 0.5, -0.8]);
    });
    it("one pending leg: that figure is null", () => {
      const e = entryFor(LEGACY_SPY_ECHO);
      expect([e.reactionStockPct, e.reactionSpyPct, e.reactionQqqPct]).toEqual([4, null, -0.8]);
    });
    it("all pending: no figure at all", () => {
      const e = entryFor(PREMATURE);
      expect([e.reactionStockPct, e.reactionSpyPct, e.reactionQqqPct]).toEqual([null, null, null]);
    });
    it("legacy zero move on a row enriched before the window: null", () => {
      const e = entryFor(LEGACY_ZERO_SPY, EARLY_ENRICHED_AT);
      expect(e.reactionSpyPct).toBeNull();
      expect(e.reactionStockPct).toBe(4);
    });
  });

  describe("macro-themes event line", () => {
    const WEEK = "2026-09-12";
    function reactionSent(snapshot: unknown, enrichedAt?: string): string | undefined {
      seedEvent({ symbol: null, type: "macro", date: "2026-09-10", snapshot, enrichedAt });
      const blob = buildMacroSignalBlob(db, "all", WEEK);
      expect(blob.enrichedEvents).toHaveLength(1);
      const { json } = buildMacroPromptInputs(blob, new Set());
      const parsed = JSON.parse(json) as { enriched_events: Array<{ reaction?: string }> };
      expect(parsed.enriched_events).toHaveLength(1);
      return parsed.enriched_events[0].reaction;
    }

    it("all legs measured: unchanged text", () => {
      expect(reactionSent(MEASURED)).toBe("SPY +0.50%, QQQ -0.80%, TLT +1.00%, XLK +1.50%, ZZA +4.00%");
    });
    it("one pending leg: that leg is absent", () => {
      expect(reactionSent(LEGACY_SPY_ECHO)).toBe("QQQ -0.80%, TLT +1.00%, XLK +1.50%, ZZA +4.00%");
    });
    it("all pending: no reaction field", () => {
      expect(reactionSent(PREMATURE)).toBeUndefined();
    });
    it("legacy identical pairs: no reaction field", () => {
      expect(reactionSent(LEGACY_ALL_ECHO)).toBeUndefined();
    });
    it("reads the row's enriched_at for the legacy zero-move rule", () => {
      expect(reactionSent(LEGACY_ZERO_SPY, EARLY_ENRICHED_AT)).toBe("QQQ -0.80%, TLT +1.00%, XLK +1.50%, ZZA +4.00%");
    });
  });

  describe("chat tool query_release_reactions", () => {
    type Leg = { t_pre?: number; t_post?: number; delta_pct?: number; state?: string; symbol?: string };
    type Reaction = { spy?: Leg; qqq?: Leg; tlt?: Leg; sector?: Leg; symbol?: Leg; state?: string; t0_utc?: string } | null;

    async function reactionFor(snapshot: unknown): Promise<Reaction> {
      seedEvent({ symbol: "ZZA", date: addDays(todayET(), -3), snapshot });
      const result = (await executeTool(db, "query_release_reactions", {})) as {
        error?: string;
        data: { releases: Array<{ reaction: Reaction }> };
      };
      expect(result.error).toBeUndefined();
      return result.data.releases[0].reaction;
    }

    it("all legs measured: the legs as stored, no state field anywhere", async () => {
      const r = await reactionFor(MEASURED);
      expect(r).toEqual({
        spy: LEGS.spy, qqq: LEGS.qqq, tlt: LEGS.tlt, sector: LEGS.sector, symbol: LEGS.symbol,
        t0_utc: T0, window_min: 120, source: "tws", pre_anchor: "prior_close",
      });
    });
    it("one pending leg: marked pending with no price and no percent", async () => {
      const r = await reactionFor(LEGACY_SPY_ECHO);
      expect(r?.spy).toEqual({ state: "pending" });
      expect(r?.qqq).toEqual(LEGS.qqq);
      expect(r?.state).toBeUndefined();
    });
    it("all pending: the reaction itself is pending and carries no figure", async () => {
      const r = await reactionFor(PREMATURE);
      expect(r?.state).toBe("pending");
      expect(r?.spy).toEqual({ state: "pending" });
      expect(r?.symbol).toEqual({ state: "pending", symbol: "ZZA" });
      expect(JSON.stringify(r)).not.toContain("delta_pct");
      expect(JSON.stringify(r)).not.toContain("t_post");
    });
    it("legacy identical pairs are pending too", async () => {
      const r = await reactionFor(LEGACY_ALL_ECHO);
      expect(r?.state).toBe("pending");
      expect(JSON.stringify(r)).not.toContain("delta_pct");
    });
  });

  describe("email viewer's rebuilt scoreboard (GET /api/earnings/email-content)", () => {
    async function viewer(snapshot: unknown, enrichedAt?: string) {
      const eventId = seedEvent({ symbol: "ZZA", date: "2026-09-10", snapshot, enrichedAt });
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md)
         VALUES (?, 'recap', 'desk@example.com', '2026-09-10 20:27:00', 'The print in prose.')`,
      ).run(eventId);
      const { GET } = await import("@/app/api/earnings/email-content/route");
      const res = await GET(
        new Request(`http://localhost/api/earnings/email-content?eventId=${eventId}&phase=recap`),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { fullHtml: string; reactionLegAt: string | null };
    }
    // Table cells as text: tags become one bar; a recap page prints a dash cell as a dash (previews keep the fill-in box).
    const cells = (html: string) =>
      html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

    it("all legs measured: the percents and the measured-at instant", async () => {
      const body = await viewer(MEASURED);
      const text = cells(body.fullHtml);
      expect(text).toContain("ZZA @ T+2h|—|+4.00%|");
      expect(text).toContain("SPY @ T+2h|—|+0.50%|");
      expect(text).not.toContain("pending");
      expect(body.reactionLegAt).toBe("2026-09-10T22:15:00.000Z");
    });
    it("one pending leg: that row says pending", async () => {
      const text = cells((await viewer(LEGACY_SPY_ECHO)).fullHtml);
      expect(text).toContain("SPY @ T+2h|—|pending|");
      expect(text).toContain("QQQ @ T+2h|—|-0.80%|");
    });
    it("all pending: every row says pending and no measured-at instant is claimed", async () => {
      const body = await viewer(PREMATURE);
      const text = cells(body.fullHtml);
      expect(text).toContain("ZZA @ T+2h|—|pending|");
      expect(text).toContain("SPY @ T+2h|—|pending|");
      expect(text).toContain("QQQ @ T+2h|—|pending|");
      expect(text).not.toContain("+4.00%");
      expect(body.reactionLegAt).toBeNull();
    });
    it("legacy zero move on a row enriched before the window: pending", async () => {
      const text = cells((await viewer(LEGACY_ZERO_SPY, EARLY_ENRICHED_AT)).fullHtml);
      expect(text).toContain("SPY @ T+2h|—|pending|");
    });
  });
});
