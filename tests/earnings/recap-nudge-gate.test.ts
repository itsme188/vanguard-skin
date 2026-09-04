/**
 * The "send recap now" gate (live print v2 slice E, Task 6a).
 *
 * Three conditions, all about the SAME print: the headline pair is accepted
 * with real numbers, a promote landed on the event (cluster-scoped stamp +
 * actual_value), and the stored actual STILL reflects the pair that is
 * accepted right now (R-E3).
 *
 * The refusal copy is a cross-slice contract — slice F renders `reason`
 * verbatim — so every refusal is asserted against the exported constant, never
 * a re-typed string.
 *
 * The last describe block is the parity check (M-E16): the gate RE-STATES the
 * promote rule instead of importing it (it lives in a route and in a client
 * component, neither of which slice E may import), so the test drives the real
 * POST /api/print-watch/accept over a matrix and asserts the two answers agree.
 *
 * Every date fixture is seeded relative to `todayET()` — a literal would go
 * stale tomorrow.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines, acceptLineCandidate } from "@/lib/print-watch/store";
import {
  evaluateRecapNudge,
  hasAcceptedHeadlinePair,
  acceptedHeadlinePair,
  GATE_NO_PRINT,
  GATE_NOT_ACCEPTED,
  GATE_NOT_PROMOTED,
  GATE_NO_ACTUAL,
  GATE_PAIR_CHANGED,
} from "@/lib/earnings/recap-nudge-gate";
import { mergeFinnhubActual } from "@/lib/format/finnhub-figure";
import { todayET } from "@/lib/calendar/date-utils";
import type { PrintWatchLine } from "@/lib/print-watch/types";

// The accept route reads the db singleton; the gate takes `db` by DI. Both
// point at the SAME in-memory database so the parity block can seed with the
// store and assert through the route.
const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let db: Database.Database;
let eventId: number;
let printId: number;
const TODAY = todayET(); // every fixture is seeded relative to today, never a literal

function line(metricId: string, over: Partial<PrintWatchLine> = {}): PrintWatchLine {
  return {
    metric_id: metricId,
    contract: {
      metric_id: metricId,
      label: metricId,
      definition: "d",
      basis: "na",
      period: "Q",
      currency: "USD",
      unit: metricId === "revenue_q" ? "usd" : "per_share",
      kind: "point",
      segment: null,
    },
    expected: { value: 1, value_high: null, whisper: null, source_label: "VK" },
    state: "accepted",
    // Metric-aware so the fixture pair is a pair a real promote could write:
    // revenue in dollars, EPS per share.
    value: metricId === "revenue_q" ? 100_000_000 : 2,
    value_high: null,
    snippet: null,
    source_doc_id: null,
    candidates_json: "[]",
    ...over,
  };
}

let sourceKeySeq = 0;
function insertEvent(): number {
  sourceKeySeq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings',?,'XMPL earnings','XMPL',?)`,
      )
      .run(TODAY, `k${sourceKeySeq}`).lastInsertRowid,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  sourceKeySeq = 0;
  eventId = insertEvent();
  printId = upsertPrint(db, eventId, "XMPL", TODAY, "16:05");
});

/** Exactly what POST /api/print-watch/accept { promoteHeadline: true } writes:
 *  saveManualActuals -> mergeFinnhubActual, against whatever the event held. */
function promote(eps = 2, revenue = 100_000_000) {
  const current = (
    db.prepare(`SELECT actual_value FROM calendar_events WHERE id = ?`).get(eventId) as {
      actual_value: string | null;
    }
  ).actual_value;
  db.prepare(
    `UPDATE calendar_events SET actual_value = ?, manual_actuals_at = datetime('now') WHERE id = ?`,
  ).run(mergeFinnhubActual(current, { eps, revenue }), eventId);
}

describe("acceptedHeadlinePair / hasAcceptedHeadlinePair", () => {
  it("needs an accepted EPS line (adj preferred, gaap fallback) AND an accepted revenue_q, both with a number", () => {
    expect(hasAcceptedHeadlinePair([])).toBe(false);
    expect(hasAcceptedHeadlinePair([line("eps_adj_q")])).toBe(false);
    expect(hasAcceptedHeadlinePair([line("revenue_q")])).toBe(false);
    expect(hasAcceptedHeadlinePair([line("eps_adj_q"), line("revenue_q")])).toBe(true);
    expect(hasAcceptedHeadlinePair([line("eps_gaap_q"), line("revenue_q")])).toBe(true);
    expect(hasAcceptedHeadlinePair([line("eps_adj_q", { state: "agreed" }), line("revenue_q")])).toBe(
      false,
    );
    expect(hasAcceptedHeadlinePair([line("eps_adj_q", { value: null }), line("revenue_q")])).toBe(
      false,
    );
    expect(
      hasAcceptedHeadlinePair([line("eps_adj_q"), line("revenue_q", { state: "blank", value: null })]),
    ).toBe(false);
  });

  it("returns the pair's numbers, preferring adjusted EPS over GAAP", () => {
    expect(acceptedHeadlinePair([line("eps_adj_q"), line("revenue_q")])).toEqual({
      eps: 2,
      revenue: 100_000_000,
    });
    expect(
      acceptedHeadlinePair([line("eps_gaap_q", { value: 1.75 }), line("revenue_q")]),
    ).toEqual({ eps: 1.75, revenue: 100_000_000 });
    // adj wins when both are accepted with a number
    expect(
      acceptedHeadlinePair([
        line("eps_adj_q", { value: 2.4 }),
        line("eps_gaap_q", { value: 1.1 }),
        line("revenue_q"),
      ]),
    ).toEqual({ eps: 2.4, revenue: 100_000_000 });
    // …and GAAP is the fallback when adj is present but unusable
    expect(
      acceptedHeadlinePair([
        line("eps_adj_q", { state: "conflict", value: null }),
        line("eps_gaap_q", { value: 1.1 }),
        line("revenue_q"),
      ]),
    ).toEqual({ eps: 1.1, revenue: 100_000_000 });
    expect(acceptedHeadlinePair([line("eps_adj_q")])).toBeNull();
  });
});

describe("evaluateRecapNudge", () => {
  it("refuses an unknown print with the domain copy", () => {
    expect(evaluateRecapNudge(db, 999999)).toEqual({ ok: false, reason: GATE_NO_PRINT });
  });

  it("refuses when the headline pair is not accepted", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q", { state: "agreed" })]);
    promote();
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: false, reason: GATE_NOT_ACCEPTED });
  });

  it("refuses when the pair is accepted but nothing has been promoted", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: false, reason: GATE_NOT_PROMOTED });
  });

  it("refuses when a promote stamped the cluster but no actual landed", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    db.prepare(`UPDATE calendar_events SET manual_actuals_at = datetime('now') WHERE id = ?`).run(
      eventId,
    );
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: false, reason: GATE_NO_ACTUAL });
  });

  it("passes once the pair is accepted and promoted, returning the event and symbol", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    promote();
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: true, eventId, symbol: "XMPL" });
  });

  it("accepts a promote stamp that lives on a superseded twin of the same print (cluster-scoped)", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    const actual = mergeFinnhubActual(null, { eps: 2, revenue: 100_000_000 });
    db.prepare(`UPDATE calendar_events SET actual_value = ? WHERE id = ?`).run(actual, eventId);
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, actual_value, manual_actuals_at, superseded)
       VALUES ('finnhub','earnings',?,'XMPL earnings','XMPL','twin',?,datetime('now'),1)`,
    ).run(TODAY, actual);
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: true, eventId, symbol: "XMPL" });
  });

  it("refuses when the accepted pair no longer matches what was promoted, with the copy verbatim", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    promote();
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: true, eventId, symbol: "XMPL" });
    // The desk accepts a DIFFERENT EPS candidate after promoting. That is the
    // per-candidate accept path (`acceptLineCandidate`), NOT a re-upsert:
    // `upsertLines` deliberately preserves an accepted line's own figure, so a
    // second upsert would be a silent no-op and prove nothing.
    acceptLineCandidate(db, printId, "eps_adj_q", {
      value: 2.5,
      value_high: null,
      snippet: null,
      source_doc_id: null,
    });
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: false, reason: GATE_PAIR_CHANGED });
    // Promoting again closes it.
    promote(2.5, 100_000_000);
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: true, eventId, symbol: "XMPL" });
  });

  it("refuses when only the revenue line moved after the promote", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    promote();
    acceptLineCandidate(db, printId, "revenue_q", {
      value: 101_000_000,
      value_high: null,
      snippet: null,
      source_doc_id: null,
    });
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: false, reason: GATE_PAIR_CHANGED });
  });

  it("refuses a manual 'Save actuals' entry that no promote ever produced", () => {
    // saveManualActuals stamps manual_actuals_at + actual_value on its own —
    // the exact state the old gate mistook for a promote.
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    db.prepare(
      `UPDATE calendar_events SET actual_value = ?, manual_actuals_at = datetime('now') WHERE id = ?`,
    ).run(mergeFinnhubActual(null, { eps: 9.99, revenue: 1 }), eventId);
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: false, reason: GATE_PAIR_CHANGED });
  });

  it("is a pure read — it writes nothing", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    promote();
    const before = db
      .prepare(`SELECT actual_value, manual_actuals_at, enriched_at FROM calendar_events WHERE id = ?`)
      .get(eventId);
    const linesBefore = db
      .prepare(`SELECT metric_id, state, value FROM print_watch_lines WHERE print_id = ? ORDER BY metric_id`)
      .all(printId);
    evaluateRecapNudge(db, printId);
    expect(
      db
        .prepare(`SELECT actual_value, manual_actuals_at, enriched_at FROM calendar_events WHERE id = ?`)
        .get(eventId),
    ).toEqual(before);
    expect(
      db
        .prepare(`SELECT metric_id, state, value FROM print_watch_lines WHERE print_id = ? ORDER BY metric_id`)
        .all(printId),
    ).toEqual(linesBefore);
  });
});

describe("parity with the server's own promote rule", () => {
  /** Seeds a fresh event + print with `lines`, then drives the REAL accept
   *  route with promoteHeadline:true and returns its status. */
  async function promoteThroughAcceptRoute(lines: PrintWatchLine[]): Promise<number> {
    const caseEventId = insertEvent();
    const casePrintId = upsertPrint(db, caseEventId, "XMPL", TODAY, "16:05");
    upsertLines(db, casePrintId, lines);
    const mod = await import("@/app/api/print-watch/accept/route");
    const res = await mod.POST(
      new NextRequest("http://test/api/print-watch/accept", {
        method: "POST",
        body: JSON.stringify({ eventId: caseEventId, promoteHeadline: true }),
      }),
    );
    return res.status;
  }

  it("agrees with POST /api/print-watch/accept over the whole matrix", async () => {
    // See M-E16: the gate re-states the rule rather than importing it, so this
    // drives the ROUTE that owns it. (The panel's promoteSummary is not used —
    // slice F deletes that file.)
    const cases: Array<{ lines: PrintWatchLine[]; expectOk: boolean }> = [
      { lines: [line("eps_adj_q"), line("revenue_q")], expectOk: true },
      { lines: [line("eps_gaap_q"), line("revenue_q")], expectOk: true },
      { lines: [line("eps_adj_q")], expectOk: false },
      {
        lines: [line("eps_adj_q"), line("revenue_q", { value: null, state: "blank" })],
        expectOk: false,
      },
    ];
    for (const c of cases) {
      expect(hasAcceptedHeadlinePair(c.lines)).toBe(c.expectOk);
      const status = await promoteThroughAcceptRoute(c.lines);
      expect(status === 200).toBe(c.expectOk);
    }
  });
});
