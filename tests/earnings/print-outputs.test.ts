/**
 * `evaluatePrintOutputs` — the two buttons on an armed print's row (live print
 * v2 slice E, Task 7; contract §2).
 *
 * The object this returns IS the cross-slice contract: slice F renders it and
 * never re-derives a gate, so every refusal string is asserted against the
 * exported constant (never a re-typed string) and the `RecapSendState` union is
 * pinned at compile time below.
 *
 * The fixture helpers are the ones from tests/earnings/recap-nudge-gate.test.ts
 * — the same `line()` with its metric-aware default value and the same
 * `promote()` that writes exactly what POST /api/print-watch/accept
 * { promoteHeadline: true } writes — so a seeded pair is a pair a real promote
 * could have produced. Every date is seeded relative to `todayET()`; a literal
 * would go stale tomorrow.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines, acceptLineCandidate } from "@/lib/print-watch/store";
import {
  evaluatePrintOutputs,
  PRINT_SHEET_DISABLED,
  type RecapSendState,
} from "@/lib/earnings/print-outputs";
import {
  GATE_NO_PRINT,
  GATE_NOT_ACCEPTED,
  GATE_NOT_PROMOTED,
  GATE_PAIR_CHANGED,
} from "@/lib/earnings/recap-nudge-gate";
import { mergeFinnhubActual } from "@/lib/format/finnhub-figure";
import { todayET } from "@/lib/calendar/date-utils";
import type { PrintWatchLine } from "@/lib/print-watch/types";

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

function insertEvent(): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings',?,'XMPL earnings','XMPL','k1')`,
      )
      .run(TODAY).lastInsertRowid,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
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

/** The recap audit row, written the way a send writes it. The DB sentinels are
 *  typed as literals ON PURPOSE here: this test is the place that pins the
 *  stored spelling against the DISPLAY word the contract publishes, so reading
 *  them from the vocabulary module would make the mapping assert itself. */
function insertRecapRow(error: string | null, providerMessageId: string | null = null) {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error, provider_message_id)
     VALUES (?, 'recap', 'me@example.com', datetime('now'), ?, ?)`,
  ).run(eventId, error, providerMessageId);
}

describe("the published contract", () => {
  it("carries the print-sheet refusal copy verbatim (slice F renders it as-is)", () => {
    expect(PRINT_SHEET_DISABLED).toBe(
      "No line has a value yet — the sheet prints once the first figure lands.",
    );
  });

  it("pins RecapSendState to exactly the contract's five words", () => {
    // A Record over the union rejects BOTH a missing key and an extra one, so
    // this fails to compile if the union ever drifts from contract §2. The
    // module writes the union as `"unsent" | DeliveryStateWord`; this is the
    // assertion that the alias really is those five values.
    const cover: Record<RecapSendState, true> = {
      unsent: true,
      "in-flight": true,
      sent: true,
      "sent-by-cloud": true,
      "delivery-unknown": true,
    };
    expect(Object.keys(cover).sort()).toEqual([
      "delivery-unknown",
      "in-flight",
      "sent",
      "sent-by-cloud",
      "unsent",
    ]);
  });
});

describe("printSheet", () => {
  it("is disabled with the domain copy while no line carries a value", () => {
    upsertLines(db, printId, [line("revenue_q", { state: "pending", value: null })]);
    expect(evaluatePrintOutputs(db, printId).printSheet).toEqual({
      enabled: false,
      reason: PRINT_SHEET_DISABLED,
    });
  });

  it("is enabled as soon as ONE non-retired line has a value, whatever its state", () => {
    upsertLines(db, printId, [line("revenue_q", { state: "single_source", value: 1e8 })]);
    expect(evaluatePrintOutputs(db, printId).printSheet).toEqual({ enabled: true, reason: null });
  });

  it("ignores a retired line that still carries its historical value", () => {
    upsertLines(db, printId, [line("x_old_Q", { state: "retired", value: 5 })]);
    expect(evaluatePrintOutputs(db, printId).printSheet.enabled).toBe(false);
  });

  it("is disabled for a print that does not exist", () => {
    expect(evaluatePrintOutputs(db, 999999).printSheet).toEqual({
      enabled: false,
      reason: PRINT_SHEET_DISABLED,
    });
  });
});

describe("sendRecap", () => {
  it("is unsent + disabled with the gate's copy before the pair is accepted", () => {
    upsertLines(db, printId, [line("eps_adj_q")]);
    expect(evaluatePrintOutputs(db, printId).sendRecap).toEqual({
      enabled: false,
      reason: GATE_NOT_ACCEPTED,
      state: "unsent",
      providerMessageId: null,
    });
  });

  it("is unsent + disabled with the promote copy once accepted but not promoted", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    expect(evaluatePrintOutputs(db, printId).sendRecap.reason).toBe(GATE_NOT_PROMOTED);
  });

  it("is enabled exactly when the gate passes and nothing has been sent", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    promote();
    expect(evaluatePrintOutputs(db, printId).sendRecap).toEqual({
      enabled: true,
      reason: null,
      state: "unsent",
      providerMessageId: null,
    });
  });

  it("surfaces the pair-changed refusal verbatim once the sheet moves past the promote", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    promote();
    expect(evaluatePrintOutputs(db, printId).sendRecap.enabled).toBe(true);
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
    expect(evaluatePrintOutputs(db, printId).sendRecap).toEqual({
      enabled: false,
      reason: GATE_PAIR_CHANGED,
      state: "unsent",
      providerMessageId: null,
    });
  });

  it.each([
    [null, "sent", null],
    ["sent-by-cloud", "sent-by-cloud", null],
    ["in_progress", "in-flight", null],
    ["sending", "in-flight", "<m@d>"],
    ["delivery_unknown", "delivery-unknown", "<m@d>"],
    ["Send failed: boom", "sent", null],
  ])("reports the row state %s as %s and disables the button", (error, state, mid) => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    promote();
    insertRecapRow(error, mid);
    const out = evaluatePrintOutputs(db, printId).sendRecap;
    expect(out.state).toBe(state);
    expect(out.enabled).toBe(false);
    expect(out.reason).toBe(state);
  });

  it("carries providerMessageId only for a sent (local) or delivery-unknown row", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    promote();
    insertRecapRow(null, "<m1@d>");
    expect(evaluatePrintOutputs(db, printId).sendRecap.providerMessageId).toBe("<m1@d>");
    db.prepare(`UPDATE earnings_emails SET error = 'in_progress' WHERE event_id = ?`).run(eventId);
    expect(evaluatePrintOutputs(db, printId).sendRecap.providerMessageId).toBeNull();
    // ...and a terminal-but-unknown row keeps it: that id is the only handle a
    // manual reconcile has on the provider.
    db.prepare(`UPDATE earnings_emails SET error = 'delivery_unknown' WHERE event_id = ?`).run(
      eventId,
    );
    expect(evaluatePrintOutputs(db, printId).sendRecap.providerMessageId).toBe("<m1@d>");
  });

  it("a state that is not 'unsent' outranks a gate refusal in `reason`", () => {
    // Sent, but the sheet's acceptances were later cleared: the useful thing to
    // say is "sent", not "accept the pair".
    promote();
    insertRecapRow(null);
    const out = evaluatePrintOutputs(db, printId).sendRecap;
    expect(out).toMatchObject({ enabled: false, state: "sent", reason: "sent" });
  });

  it("is unsent + refused for a print that does not exist", () => {
    // No print means no event, so there is no send row to consult either.
    expect(evaluatePrintOutputs(db, 999999).sendRecap).toEqual({
      enabled: false,
      reason: GATE_NO_PRINT,
      state: "unsent",
      providerMessageId: null,
    });
  });
});

describe("purity", () => {
  it("writes nothing — it is called from a GET body", () => {
    upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
    promote();
    insertRecapRow(null, "<m1@d>");
    const snap = () =>
      JSON.stringify({
        event: db
          .prepare(`SELECT actual_value, manual_actuals_at, enriched_at FROM calendar_events`)
          .all(),
        lines: db
          .prepare(`SELECT metric_id, state, value FROM print_watch_lines ORDER BY metric_id`)
          .all(),
        emails: db.prepare(`SELECT event_id, phase, error, provider_message_id FROM earnings_emails`).all(),
      });
    const before = snap();
    evaluatePrintOutputs(db, printId);
    evaluatePrintOutputs(db, printId);
    expect(snap()).toBe(before);
  });
});
