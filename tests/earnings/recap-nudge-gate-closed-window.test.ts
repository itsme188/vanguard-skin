/**
 * A print whose watch window has closed is a read-only record: its Promote
 * control is permanently disabled, so the recap gate must not tell the desk to
 * promote or accept on the sheet. It points to the bogeys editor's Save actuals.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines, setPrintState } from "@/lib/print-watch/store";
import {
  evaluateRecapNudge,
  GATE_NOT_ACCEPTED,
  GATE_NOT_PROMOTED,
  GATE_WINDOW_CLOSED_NO_ACTUAL,
  isPrintWindowClosed,
} from "@/lib/earnings/recap-nudge-gate";
import { mergeFinnhubActual } from "@/lib/format/finnhub-figure";
import { todayET } from "@/lib/calendar/date-utils";
import type { PrintWatchLine } from "@/lib/print-watch/types";

const TODAY = todayET();
let db: Database.Database;
let eventId: number;
let printId: number;

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
    value: metricId === "revenue_q" ? 100_000_000 : 2,
    value_high: null,
    snippet: null,
    source_doc_id: null,
    candidates_json: "[]",
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings',?,'XMPL earnings','XMPL','k1')`,
      )
      .run(TODAY).lastInsertRowid,
  );
  printId = upsertPrint(db, eventId, "XMPL", TODAY, "16:05");
});

const acceptedPair = () => upsertLines(db, printId, [line("eps_adj_q"), line("revenue_q")]);
const unacceptedPair = () =>
  upsertLines(db, printId, [
    line("eps_adj_q", { state: "agreed" }),
    line("revenue_q", { state: "agreed" }),
  ]);

describe("recap gate on a closed watch window", () => {
  it("helper: expired and disarmed are closed, the rest are not", () => {
    expect(isPrintWindowClosed("expired")).toBe(true);
    expect(isPrintWindowClosed("disarmed")).toBe(true);
    expect(isPrintWindowClosed("window_open")).toBe(false);
    expect(isPrintWindowClosed("scheduled")).toBe(false);
  });

  it("closed + no accepted pair -> the Save actuals sentence", () => {
    unacceptedPair();
    setPrintState(db, printId, "expired");
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: false, reason: GATE_WINDOW_CLOSED_NO_ACTUAL });
  });

  it("closed + accepted pair, nothing promoted -> the Save actuals sentence", () => {
    acceptedPair();
    setPrintState(db, printId, "expired");
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: false, reason: GATE_WINDOW_CLOSED_NO_ACTUAL });
  });

  it("open window keeps the sheet-first sentences", () => {
    unacceptedPair();
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: false, reason: GATE_NOT_ACCEPTED });
    acceptedPair();
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: false, reason: GATE_NOT_PROMOTED });
  });

  it("closed + actuals saved by hand matching the pair -> ok", () => {
    acceptedPair();
    setPrintState(db, printId, "expired");
    db.prepare(
      `UPDATE calendar_events SET actual_value = ?, manual_actuals_at = datetime('now') WHERE id = ?`,
    ).run(mergeFinnhubActual(null, { eps: 2, revenue: 100_000_000 }), eventId);
    expect(evaluateRecapNudge(db, printId)).toEqual({ ok: true, eventId, symbol: "XMPL" });
  });
});
