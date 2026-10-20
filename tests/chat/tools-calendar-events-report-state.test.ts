/**
 * QA finding chat-mobile-overlay-earnings-calendar-answer-all-accounts-chat-
 * says-unh-gs-and-jpm-already-reported-hours-befo (2026-10-13): at 04:20 ET
 * the chat told the owner three pre-open reporters "all reported before this
 * morning's open". The calendar tool handed the model dated rows with no word
 * on whether a result was on file, so the model guessed from the slot.
 *
 * Every row now carries a report_state and the result carries the Eastern
 * clock. Synthetic tickers only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";

let db: Database.Database;

type Row = { symbol: string; actual_value: string | null; report_state: string };
type Out = { data: { events: Row[]; now_et: string } };

beforeEach(() => {
  vi.useFakeTimers();
  // Tue 2026-03-10 04:20 ET (08:20 UTC, daylight time starts 2026-03-08).
  vi.setSystemTime(new Date("2026-03-10T08:20:00Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const ins = db.prepare(
    `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, title, symbol, actual_value, superseded, source_key, week_of)
     VALUES ('manual', 'earnings', ?, ?, ?, ?, ?, 0, ?, '2026-03-09')`,
  );
  ins.run("2026-03-10", "07:00", "AAA earnings (pre-open, not out yet)", "AAA", null, "t:aaa");
  ins.run("2026-03-09", "16:05", "BBB earnings (reported)", "BBB", "EPS 1.20", "t:bbb");
  ins.run("2026-03-09", "16:05", "CCC earnings (no result on file)", "CCC", null, "t:ccc");
  ins.run("2026-03-12", "07:00", "DDD earnings (later this week)", "DDD", null, "t:ddd");
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("chat query_calendar_events says whether a result is on file", () => {
  it("labels every row and carries the Eastern clock", async () => {
    const out = (await executeTool(db, "query_calendar_events", { event_type: "earnings", days_back: 2 })) as Out;
    const by = Object.fromEntries(out.data.events.map((e) => [e.symbol, e]));

    expect(by.AAA.actual_value).toBeNull();
    expect(by.AAA.report_state).toMatch(/^not yet reported/);
    expect(by.AAA.report_state).toMatch(/today/);
    expect(by.BBB.report_state).toBe("reported");
    expect(by.CCC.report_state).toMatch(/^not yet reported/);
    expect(by.CCC.report_state).not.toMatch(/today/);
    expect(by.DDD.report_state).toBe("upcoming");

    expect(out.data.now_et).toMatch(/^2026-03-10 04:20/);
  });
});

/**
 * Review of 30c73e22: a figure can be saved before the print (Today shows it
 * with a "pre-release" chip). The chat must not call such a row "reported",
 * and a vendor figure that fails the plausibility guard is withheld.
 */
describe("chat query_calendar_events: pre-release figures and implausible actuals", () => {
  function insert(
    symbol: string,
    date: string,
    time: string | null,
    actual: string | null,
    extra: { consensus?: string; manualAt?: string } = {},
  ): void {
    db.prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, title, symbol, actual_value,
          consensus_estimate, manual_actuals_at, superseded, source_key, week_of)
       VALUES ('manual', 'earnings', ?, ?, ?, ?, ?, ?, ?, 0, ?, '2026-03-09')`,
    ).run(date, time, `${symbol} earnings`, symbol, actual, extra.consensus ?? null, extra.manualAt ?? null, `t:${symbol}`);
  }

  async function bySymbol(): Promise<Record<string, Row & Record<string, unknown>>> {
    const out = (await executeTool(db, "query_calendar_events", { event_type: "earnings", days_back: 2 })) as {
      data: { events: Array<Row & Record<string, unknown>> };
    };
    return Object.fromEntries(out.data.events.map((e) => [e.symbol, e]));
  }

  it("a figure on an event dated tomorrow is a pre-release figure, not a result", async () => {
    insert("PRE", "2026-03-11", "07:00", "EPS 1.00");
    const by = await bySymbol();
    expect(by.PRE.report_state).toMatch(/^pre_release_figure/);
    expect(by.PRE.report_state).toMatch(/NOT a reported result/);
    expect(by.PRE.report_state).toMatch(/2026-03-11/);
    expect(by.PRE.actual_value).toBeNull();
    expect(by.PRE.figure_saved_before_release).toBe("EPS 1.00");
    expect(by.PRE).not.toHaveProperty("raw_json");
  });

  it("an after-close event today with a figure, asked before 16:00 ET, is a pre-release figure", async () => {
    // 11:38 ET on 2026-03-10 (15:38 UTC).
    vi.setSystemTime(new Date("2026-03-10T15:38:00Z"));
    insert("AMC", "2026-03-10", "16:15", "EPS 2.00", { manualAt: "2026-03-10 15:00:00" });
    const by = await bySymbol();
    expect(by.AMC.report_state).toMatch(/^pre_release_figure/);
    expect(by.AMC.report_state).toMatch(/today at 16:15 ET; it is now 11:38 ET/);
    expect(by.AMC.entered_manually).toBe(true);
  });

  it("the same row once the after-close window opens is reported", async () => {
    // 16:20 ET.
    vi.setSystemTime(new Date("2026-03-10T20:20:00Z"));
    insert("AMC", "2026-03-10", "16:15", "EPS 2.00");
    const by = await bySymbol();
    expect(by.AMC.report_state).toBe("reported");
    expect(by.AMC.actual_value).toBe("EPS 2.00");
  });

  it("a before-open row today with a figure is pre-release at 04:20 ET", async () => {
    insert("BMO", "2026-03-10", "07:00", "EPS 0.50");
    const by = await bySymbol();
    expect(by.BMO.report_state).toMatch(/^pre_release_figure/);
  });

  it("a vendor figure on a slot-less row is reported, not held back by the stored 16:15 default", async () => {
    // 10:30 ET on 2026-03-10. Only a stored default release time, no slot.
    vi.setSystemTime(new Date("2026-03-10T14:30:00Z"));
    const add = (symbol: string, manualAt: string | null) =>
      db.prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, event_time, release_time, title, symbol, actual_value,
            manual_actuals_at, superseded, source_key, week_of)
         VALUES ('finnhub', 'earnings', '2026-03-10', NULL, '16:15', ?, ?, 'EPS 1.00', ?, 0, ?, '2026-03-09')`,
      ).run(`${symbol} earnings`, symbol, manualAt, `t:${symbol}`);
    add("VND", null);
    add("HND", "2026-03-10 09:00:00");
    const by = await bySymbol();
    expect(by.VND.report_state).toBe("reported");
    expect(by.VND.actual_value).toBe("EPS 1.00");
    // A hand-entered figure keeps the stored time as its floor.
    expect(by.HND.report_state).toMatch(/^pre_release_figure/);
  });

  it("an implausible vendor figure is withheld; a hand-accepted one is not", async () => {
    insert("BAD", "2026-03-09", "16:05", "EPS 5.00", { consensus: "EPS 1.00" });
    insert("OKM", "2026-03-09", "16:05", "EPS 5.00", { consensus: "EPS 1.00", manualAt: "2026-03-09 21:00:00" });
    const by = await bySymbol();
    expect(by.BAD.actual_value).toBeNull();
    expect(by.BAD.report_state).toMatch(/^reported, figure withheld/);
    expect(JSON.stringify(by.BAD)).not.toContain("5.00");
    expect(by.OKM.report_state).toBe("reported");
    expect(by.OKM.actual_value).toBe("EPS 5.00");
  });
});
