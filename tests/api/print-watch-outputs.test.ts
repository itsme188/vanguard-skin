/**
 * The status route's half of Task 7 (live print v2 slice E): every print entry
 * carries an `outputs` object, and the GET stays the pure read it has always
 * been.
 *
 * Pattern per tests/api/print-watch-routes.test.ts — vi.mock the db singleton
 * with an in-memory migrated getter, dynamic-import the route. Nothing here
 * mocks the watcher: `getWatchStatus` runs for real, so this is the actual
 * shape the panel polls.
 *
 * The plan asked whether tests/api/print-watch-routes.test.ts's narrow GET-body
 * scan needed extending. It does NOT: that test greps the extracted GET body
 * for the token `ensure`, and neither `evaluatePrintOutputs` nor its import
 * line contains it. The repo-wide scan in tests/api/no-state-changing-get.test.ts
 * is the same story — the helper's name matches none of its
 * `upsert*`/`ensure*`/`set(Last|Cached|Marker)*`/`record*` families, and the
 * second test below pins the behaviour rather than the spelling.
 *
 * Fixtures are seeded relative to `todayET()`; a literal date would go stale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertPrint, upsertLines } from "@/lib/print-watch/store";
import { PRINT_SHEET_DISABLED } from "@/lib/earnings/print-outputs";
import { GATE_NOT_ACCEPTED } from "@/lib/earnings/recap-nudge-gate";
import { todayET } from "@/lib/calendar/date-utils";
import type { PrintWatchLine } from "@/lib/print-watch/types";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

const TODAY = todayET();
let printId: number;
let eventId: number;

function pendingLine(metricId: string): PrintWatchLine {
  return {
    metric_id: metricId,
    contract: {
      metric_id: metricId,
      label: metricId,
      definition: "d",
      basis: "na",
      period: "Q",
      currency: "USD",
      unit: "usd",
      kind: "point",
      segment: null,
    },
    expected: null,
    state: "pending",
    value: null,
    value_high: null,
    snippet: null,
    source_doc_id: null,
    candidates_json: "[]",
  };
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);

  eventId = Number(
    hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key)
         VALUES ('manual','earnings',?,'XMPL earnings','XMPL','k1')`,
      )
      .run(TODAY).lastInsertRowid,
  );
  printId = upsertPrint(hoisted.db, eventId, "XMPL", TODAY, "16:05");
  // Nothing accepted and no figure yet — the state an armed row sits in before
  // the wire lands, which is where BOTH buttons must be dark.
  upsertLines(hoisted.db, printId, [pendingLine("revenue_q")]);
});

afterEach(() => {
  hoisted.db.close();
});

describe("GET /api/print-watch/status carries outputs per print", () => {
  it("adds outputs to every print entry and leaves slice C and D's fields alone", async () => {
    const { GET } = await import("@/app/api/print-watch/status/route");
    const body = await (await GET()).json();
    const entry = body.data.prints.find((p: { printId: number }) => p.printId === printId);
    expect(entry.outputs).toEqual({
      printSheet: { enabled: false, reason: PRINT_SHEET_DISABLED },
      sendRecap: {
        enabled: false,
        reason: GATE_NOT_ACCEPTED,
        state: "unsent",
        providerMessageId: null,
      },
    });
    // D's and C's fields survive untouched.
    for (const key of [
      "read",
      "activeRead",
      "lastAttempt",
      "callouts",
      "effectiveWindow",
      "goRequest",
      "documentRoads",
      "documents",
      "lines",
      "sources",
      "coverage",
      "forcedOpenAt",
      "windowExtendedUntil",
      "state",
      "symbol",
      "eventId",
    ]) {
      expect(entry, key).toHaveProperty(key);
    }
  });

  it("stays a pure read: nothing in the DB changes across two GETs", async () => {
    const { GET } = await import("@/app/api/print-watch/status/route");
    const db = hoisted.db;
    const snap = () =>
      JSON.stringify(
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
          .all()
          .map((t) => db.prepare(`SELECT COUNT(*) c FROM "${(t as { name: string }).name}"`).get()),
      );
    const before = snap();
    await GET();
    await GET();
    expect(snap()).toBe(before);
  });
});
