import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { confirmEarningsDate } from "@/lib/mutations/confirm-earnings-date";
import { addDays, mondayOf, todayET } from "@/lib/calendar/date-utils";
import { insertCalendarEvent } from "@/lib/mutations/calendar";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { upsertBogey } from "@/lib/mutations/earnings-bogeys";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { upsertSymbolReleaseTime } from "@/lib/earnings/wire-times";
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";
import { readArmedGeneration } from "@/lib/earnings/armed-events-projection";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(
    "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('NVDA','Nvidia','stock','equity',1)",
  ).run();
});

function seedSync(source: string, date: string): number {
  return db
    .prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, raw_json)
       VALUES (?, 'earnings', ?, 'NVDA earnings', 'NVDA', ?, '{}')`,
    )
    .run(source, date, `${source}:NVDA:${date}`).lastInsertRowid as number;
}

describe("confirmEarningsDate", () => {
  it("writes a locked user_confirmed manual row and supersedes the sync rows", () => {
    const finn = seedSync("finnhub", "2026-06-11");
    const nas = seedSync("nasdaq", "2026-06-13");

    confirmEarningsDate(db, {
      symbol: "NVDA",
      confirmedDate: "2026-06-12",
      confirmedTime: "amc",
      today: "2026-06-08",
    });

    const manual = db
      .prepare(
        "SELECT event_date, release_time, date_status, superseded, security_id FROM calendar_events WHERE source='manual' AND symbol='NVDA'",
      )
      .get() as {
      event_date: string;
      release_time: string;
      date_status: string;
      superseded: number;
      security_id: number | null;
    };
    expect(manual.event_date).toBe("2026-06-12");
    expect(manual.release_time).toBe("16:15"); // amc
    expect(manual.date_status).toBe("user_confirmed");
    expect(manual.superseded).toBe(0);
    expect(manual.security_id).not.toBeNull();

    // Sync rows in the cluster are superseded.
    const sup = (id: number) =>
      (db.prepare("SELECT superseded FROM calendar_events WHERE id=?").get(id) as { superseded: number }).superseded;
    expect(sup(finn)).toBe(1);
    expect(sup(nas)).toBe(1);
  });

  it("re-confirming updates the same manual row in place (idempotent on source_key)", () => {
    seedSync("finnhub", "2026-06-11");
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "amc", today: "2026-06-08" });
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "bmo", today: "2026-06-08" });

    const rows = db.prepare("SELECT release_time FROM calendar_events WHERE source='manual' AND symbol='NVDA'").all() as { release_time: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].release_time).toBe("08:00"); // bmo on the re-confirm
  });

  it("[L3] un-hiding an existing manual row mints an armed-events generation", () => {
    seedSync("finnhub", "2026-06-11");
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "amc", today: "2026-06-08" });
    const manual = db
      .prepare(`SELECT id FROM calendar_events WHERE source = 'manual' AND symbol = 'NVDA'`)
      .get() as { id: number };

    db.prepare(`UPDATE calendar_events SET superseded = 1 WHERE id = ?`).run(manual.id);
    db.transaction(() => writeArmedEventsOutboxRow(db, { today: "2026-06-08" })).immediate();
    const beforeGeneration = readArmedGeneration(db);

    const res = confirmEarningsDate(db, {
      symbol: "NVDA",
      confirmedDate: "2026-06-12",
      confirmedTime: "amc",
      today: "2026-06-08",
    });

    expect(res.ok).toBe(true);
    expect(readArmedGeneration(db)).toBe(beforeGeneration + 1);
    const payload = JSON.parse(
      (
        db.prepare(`SELECT payload_json FROM cloud_outbox ORDER BY generation DESC LIMIT 1`).get() as {
          payload_json: string;
        }
      ).payload_json,
    ) as { supersededEventIds: number[] };
    expect(payload.supersededEventIds).not.toContain(manual.id);
  });

  it("routes through the release-time cascade: a standing user override wins over the BMO/AMC default", () => {
    seedSync("finnhub", "2026-06-11");
    upsertSymbolReleaseTime(db, { symbol: "NVDA", releaseTime: "07:15", source: "user" });

    confirmEarningsDate(db, {
      symbol: "NVDA",
      confirmedDate: "2026-06-12",
      confirmedTime: "bmo",
      today: "2026-06-08",
    });

    const manual = db
      .prepare("SELECT release_time FROM calendar_events WHERE source='manual' AND symbol='NVDA'")
      .get() as { release_time: string };
    expect(manual.release_time).toBe("07:15"); // the user override, not the 08:00 bmo default
  });

  it("a symbol with no wire data still resolves to the cascade's BMO/AMC default", () => {
    seedSync("finnhub", "2026-07-01");

    confirmEarningsDate(db, {
      symbol: "NVDA",
      confirmedDate: "2026-07-02",
      confirmedTime: "amc",
      today: "2026-06-28",
    });

    const manual = db
      .prepare("SELECT release_time FROM calendar_events WHERE source='manual' AND symbol='NVDA'")
      .get() as { release_time: string };
    expect(manual.release_time).toBe("16:15"); // amc default, no wire data / override for NVDA
  });
});

// ── Past-date refusal (qa: conflict popover offers a prior-quarter date) ──
// A stale prior-quarter vendor date can appear as a conflict candidate;
// confirming it would silently move an upcoming held print into the past and
// off every forward-looking surface. Mirror applyVerdict's guard: a past
// confirmedDate is refused, never written.
describe("confirmEarningsDate past-date guard", () => {
  it("refuses a confirmedDate before today and writes nothing", () => {
    const finn = seedSync("finnhub", "2026-06-11");
    void finn;

    const result = confirmEarningsDate(db, {
      symbol: "NVDA",
      confirmedDate: "2026-05-28", // prior-quarter stale date
      confirmedTime: "amc",
      today: "2026-06-08",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusedReason).toMatch(/past/i);

    const manual = db
      .prepare("SELECT COUNT(*) AS c FROM calendar_events WHERE source='manual' AND symbol='NVDA'")
      .get() as { c: number };
    expect(manual.c).toBe(0);
    // The sync row is untouched — not superseded by a refused confirm.
    const sync = db
      .prepare("SELECT COALESCE(superseded,0) AS s FROM calendar_events WHERE source='finnhub'")
      .get() as { s: number };
    expect(sync.s).toBe(0);
  });

  it("accepts today's date (an AMC print confirmed on the day)", () => {
    seedSync("finnhub", "2026-06-08");
    const result = confirmEarningsDate(db, {
      symbol: "NVDA",
      confirmedDate: "2026-06-08",
      confirmedTime: "amc",
      today: "2026-06-08",
    });
    expect(result.ok).toBe(true);
  });
});

describe("confirmEarningsDate scope", () => {
  // QA 2026-09-26 (today-earningshub-confirm-date--folds-other-symbols-manual-rows-whole-book-reconcile):
  // confirming NKE re-ran the reconciler over the WHOLE book, so every other
  // symbol that carried a user_confirmed row had its manual siblings folded
  // (MU 10/2 and 10/3 vanished from the hub). The confirm must only touch the
  // confirmed issuer's family.
  it("only reconciles the confirmed symbol's family — other symbols' manual rows are untouched", () => {
    db.prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('MU','Micron','stock','equity',1)",
    ).run();
    const manual = (symbol: string, date: string, status: string | null) =>
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, raw_json, date_status, superseded)
           VALUES ('manual', 'earnings', ?, ?, ?, ?, NULL, ?, 0)`,
        )
        .run(date, `${symbol} earnings`, symbol, `manual:${symbol}:${date}:earnings`, status).lastInsertRowid as number;
    const muLocked = manual("MU", "2026-09-30", "user_confirmed");
    const muA = manual("MU", "2026-10-02", null);
    const muB = manual("MU", "2026-10-03", null);
    seedSync("nasdaq", "2026-10-01");

    const res = confirmEarningsDate(db, {
      symbol: "NVDA",
      confirmedDate: "2026-10-01",
      confirmedTime: "amc",
      today: "2026-09-26",
    });
    expect(res.ok).toBe(true);

    const sup = (id: number) =>
      (db.prepare("SELECT superseded FROM calendar_events WHERE id=?").get(id) as { superseded: number }).superseded;
    expect(sup(muLocked)).toBe(0);
    expect(sup(muA)).toBe(0);
    expect(sup(muB)).toBe(0);
    const visibleMu = db
      .prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE symbol='MU' AND superseded=0")
      .get() as { n: number };
    expect(visibleMu.n).toBe(3);
  });
});

describe("confirmEarningsDate far-future guard", () => {
  const today = "2026-06-08";
  const manualCount = () =>
    (db.prepare("SELECT COUNT(*) AS c FROM calendar_events WHERE source='manual'").get() as { c: number }).c;
  const run = (confirmedDate: string) =>
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate, confirmedTime: "amc", today });

  it("refuses a far-future date and writes nothing", () => {
    const result = run("2099-01-15");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusedReason).toMatch(/more than 400 days out/i);
    expect(manualCount()).toBe(0);
  });

  it("accepts today + 30 days", () => {
    expect(run(addDays(today, 30)).ok).toBe(true);
  });

  it("accepts today + 400 and refuses today + 401", () => {
    expect(run(addDays(today, 400)).ok).toBe(true);
    expect(manualCount()).toBe(1);
    expect(run(addDays(today, 401)).ok).toBe(false);
    expect(manualCount()).toBe(1);
  });

  function seedManual(date: string, eventTime: string | null, releaseTime: string | null): void {
    db.prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol, source_key, week_of)
       VALUES ('manual', 'earnings', ?, ?, ?, 'NVDA earnings', 'NVDA', ?, '2026-06-08')`,
    ).run(date, eventTime, releaseTime, `manual:NVDA:${date}:earnings`);
  }
  const manualRow = () =>
    db
      .prepare("SELECT event_time, release_time FROM calendar_events WHERE source='manual' AND symbol='NVDA'")
      .get() as { event_time: string | null; release_time: string | null };

  it("confirming with the same slot keeps a typed clock time", () => {
    seedManual("2026-06-12", "16:05", "16:05");
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "amc", today: "2026-06-08" });
    expect(manualRow()).toEqual({ event_time: "16:05", release_time: "16:05" });
  });

  it("picking the other slot moves a typed time to that slot's default", () => {
    seedManual("2026-06-12", "07:30", "07:30");
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "amc", today: "2026-06-08" });
    expect(manualRow()).toEqual({ event_time: "AMC", release_time: "16:15" });
  });

  it("un-hiding a hidden hand-entered row keeps its typed time on a same-slot confirm", () => {
    seedManual("2026-06-12", "16:05", "16:05");
    db.prepare("UPDATE calendar_events SET superseded = 1 WHERE source = 'manual'").run();
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "amc", today: "2026-06-08" });
    const row = db
      .prepare("SELECT superseded, event_time, release_time FROM calendar_events WHERE source='manual' AND symbol='NVDA'")
      .get() as { superseded: number; event_time: string | null; release_time: string | null };
    expect(row).toEqual({ superseded: 0, event_time: "16:05", release_time: "16:05" });
  });

  // Review finding: the Hub's add form stores a slot word in event_time, so a
  // typed time usually lives in release_time alone.
  it("keeps a typed time stored in release_time alone, on a same-slot confirm", () => {
    seedManual("2026-06-12", "amc", "17:00");
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "amc", today: "2026-06-08" });
    expect(manualRow()).toEqual({ event_time: "AMC", release_time: "17:00" });
  });

  it("moves a release_time-only typed time when the other slot is picked", () => {
    seedManual("2026-06-12", "AMC", "17:00");
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "bmo", today: "2026-06-08" });
    expect(manualRow()).toEqual({ event_time: "BMO", release_time: "08:00" });
  });

  it("a slot's default time is not a typed time: the cascade still decides it", () => {
    seedManual("2026-06-12", "AMC", "16:15");
    upsertSymbolReleaseTime(db, { symbol: "NVDA", releaseTime: "16:20", source: "user" });
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "amc", today: "2026-06-08" });
    expect(manualRow()).toEqual({ event_time: "AMC", release_time: "16:20" });
  });

  it("a confirm that names no time keeps a typed morning time", () => {
    seedManual("2026-06-12", "07:30", "07:30");
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", today: "2026-06-08" });
    expect(manualRow()).toEqual({ event_time: "07:30", release_time: "07:30" });
  });

  it("a single-digit hour counts as a typed time", () => {
    seedManual("2026-06-12", "9:30", "9:30");
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "bmo", today: "2026-06-08" });
    expect(manualRow()).toEqual({ event_time: "9:30", release_time: "9:30" });
  });

  it("stores a picked slot upper-case on a first insert", () => {
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", confirmedTime: "bmo", today: "2026-06-08" });
    expect(manualRow()).toEqual({ event_time: "BMO", release_time: "08:00" });
  });

  it("an absent time still stores no slot", () => {
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: "2026-06-12", today: "2026-06-08" });
    expect(manualRow().event_time).toBeNull();
    expect(manualRow().release_time).toBe("16:15");
  });
});

// ── Owner ruling 2026-10-08: confirming a DIFFERENT date moves the row ──
// A symbol with one showing hand-entered row for the upcoming print, confirmed
// on another date, used to end with TWO hand-entered rows (the upsert keys on
// the date). The existing row now moves, keeping its id and everything
// attached to it. Dates derive from todayET() because armWorksheet reads the
// real clock for its armed-events projection.
describe("confirmEarningsDate moves the existing hand-entered row", () => {
  const today = todayET();
  const dateA = addDays(today, 10);
  const dateB = addDays(today, 12);

  function addManual(date: string, eventTime = "AMC", releaseTime?: string): number {
    return insertCalendarEvent(db, {
      symbol: "NVDA",
      event_date: date,
      event_time: eventTime,
      release_time: releaseTime,
      week_of: mondayOf(date),
    }).id;
  }
  interface ManualRow {
    id: number;
    event_date: string;
    week_of: string;
    source_key: string;
    date_status: string | null;
    event_time: string | null;
    release_time: string | null;
    superseded: number;
  }
  const manualRows = (): ManualRow[] =>
    db
      .prepare(
        `SELECT id, event_date, week_of, source_key, date_status, event_time, release_time,
                COALESCE(superseded, 0) AS superseded
           FROM calendar_events WHERE source = 'manual' AND symbol = 'NVDA' ORDER BY id`,
      )
      .all() as ManualRow[];
  const showing = () => manualRows().filter((r) => r.superseded === 0);

  it("manual row on A, feed row on B, confirm B: one showing manual row, same id, on B", () => {
    const manualId = addManual(dateA, "AMC", "16:05");
    const feedId = seedSync("finnhub", dateB);

    const res = confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });

    expect(res).toEqual({ ok: true, movedEventId: manualId });
    expect(manualRows()).toEqual([
      {
        id: manualId,
        event_date: dateB,
        week_of: mondayOf(dateB),
        source_key: `manual:NVDA:${dateB}:earnings`,
        date_status: "user_confirmed",
        event_time: "AMC",
        release_time: "16:05", // typed clock kept: same slot
        superseded: 0,
      },
    ]);
    const feed = db.prepare("SELECT superseded FROM calendar_events WHERE id = ?").get(feedId) as { superseded: number };
    expect(feed.superseded).toBe(1);
  });

  it("picking the other slot on a move drops the typed clock for that slot's default", () => {
    const manualId = addManual(dateA, "AMC", "16:05");
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "bmo", today });
    expect(showing()).toHaveLength(1);
    expect(showing()[0]).toMatchObject({ id: manualId, event_date: dateB, event_time: "BMO", release_time: "08:00" });
  });

  it("bogeys and the arm flag stay attached to the moved row", () => {
    const manualId = addManual(dateA);
    upsertBogey(db, { event_id: manualId, source: "manual", eps_consensus: 1.5 });
    armWorksheet(db, manualId);
    seedSync("finnhub", dateB);

    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });

    expect(showing().map((r) => r.id)).toEqual([manualId]);
    const bogeys = db.prepare("SELECT event_id, eps_consensus FROM earnings_bogeys").all();
    expect(bogeys).toEqual([{ event_id: manualId, eps_consensus: 1.5 }]);
    const flags = db.prepare("SELECT event_id FROM earnings_worksheet_flags").all();
    expect(flags).toEqual([{ event_id: manualId }]);
  });

  it("moving an armed row mints exactly one armed-events generation carrying the new date", () => {
    const manualId = addManual(dateA);
    armWorksheet(db, manualId);
    const beforeGeneration = readArmedGeneration(db);

    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });

    expect(readArmedGeneration(db)).toBe(beforeGeneration + 1);
    const payload = JSON.parse(
      (db.prepare(`SELECT payload_json FROM cloud_outbox ORDER BY generation DESC LIMIT 1`).get() as {
        payload_json: string;
      }).payload_json,
    ) as { entries: Array<{ eventId: number; eventDate: string; sourceKey: string; removed?: boolean }> };
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]).toMatchObject({
      eventId: manualId,
      eventDate: dateB,
      sourceKey: `manual:NVDA:${dateB}:earnings`,
    });
    expect(payload.entries[0].removed).toBeFalsy();
  });

  it("a reported manual row is a past print: never moved", () => {
    const reportedId = addManual(dateA);
    db.prepare("UPDATE calendar_events SET actual_value = 'EPS 1.50' WHERE id = ?").run(reportedId);

    const res = confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });

    expect(res).toEqual({ ok: true });
    const rows = manualRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: reportedId, event_date: dateA });
    expect(rows[1]).toMatchObject({ event_date: dateB, date_status: "user_confirmed" });
  });

  it("a manual row dated before today is a past print: never moved", () => {
    const pastId = addManual(addDays(today, -3));
    const res = confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });
    expect(res).toEqual({ ok: true });
    expect(manualRows().find((r) => r.id === pastId)?.event_date).toBe(addDays(today, -3));
    expect(manualRows()).toHaveLength(2);
  });

  it("a manual row more than 45 days from the confirmed date is another print: never moved", () => {
    const farId = addManual(addDays(dateB, 46));
    const res = confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });
    expect(res).toEqual({ ok: true });
    expect(manualRows().find((r) => r.id === farId)?.event_date).toBe(addDays(dateB, 46));
    expect(manualRows()).toHaveLength(2);
  });

  it("a row exactly 45 days away still moves", () => {
    const id = addManual(addDays(dateB, 45));
    const res = confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });
    expect(res).toEqual({ ok: true, movedEventId: id });
    expect(manualRows()).toHaveLength(1);
  });

  it("two future manual rows: no move, a notice, and today's behaviour", () => {
    const first = addManual(dateA);
    const second = addManual(addDays(dateA, 1));

    const res = confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.notice).toMatch(/several hand-entered dates/i);
    const rows = manualRows();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === first)?.event_date).toBe(dateA);
    expect(rows.find((r) => r.id === second)?.event_date).toBe(addDays(dateA, 1));
    expect(rows.filter((r) => r.event_date === dateB)).toHaveLength(1);
  });

  it("another symbol's hand-entered row is never moved", () => {
    db.prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('ZZA','Zed A','stock','equity',1)",
    ).run();
    const other = insertCalendarEvent(db, { symbol: "ZZA", event_date: dateA, week_of: mondayOf(dateA) }).id;
    confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });
    const row = db.prepare("SELECT symbol, event_date FROM calendar_events WHERE id = ?").get(other);
    expect(row).toEqual({ symbol: "ZZA", event_date: dateA });
  });

  it("a hidden hand-entered row on another date is not moved", () => {
    const hidden = addManual(dateA);
    db.prepare("UPDATE calendar_events SET superseded = 1 WHERE id = ?").run(hidden);
    const res = confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });
    expect(res).toEqual({ ok: true });
    expect(manualRows().find((r) => r.id === hidden)?.event_date).toBe(dateA);
  });

  describe("a hand-entered row already sits on the confirmed date", () => {
    it("the confirmed row is updated in place; the other row's bogeys and arm move over and the emptied row is deleted", () => {
      const oldId = addManual(dateA);
      const keptId = addManual(dateB);
      upsertBogey(db, { event_id: oldId, source: "manual", eps_consensus: 1.5 });
      armWorksheet(db, oldId);

      const res = confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });

      expect(res).toEqual({ ok: true, deletedEventId: oldId });
      // Exactly one hand-entered row for the symbol, showing or hidden.
      expect(manualRows().map((r) => r.id)).toEqual([keptId]);
      expect(manualRows()[0]).toMatchObject({ event_date: dateB, date_status: "user_confirmed", superseded: 0 });
      expect(db.prepare("SELECT event_id, eps_consensus FROM earnings_bogeys").all()).toEqual([
        { event_id: keptId, eps_consensus: 1.5 },
      ]);
      expect(db.prepare("SELECT event_id FROM earnings_worksheet_flags").all()).toEqual([{ event_id: keptId }]);
    });

    it("a following reconcile pass still leaves exactly one row", () => {
      addManual(dateA);
      const keptId = addManual(dateB);
      confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });

      const pass = reconcileEarningsDates(db, { today });

      expect(pass.restored).toEqual([]);
      expect(manualRows().map((r) => r.id)).toEqual([keptId]);
      expect(showing()).toHaveLength(1);
    });

    it("the outbox hears that the armed row moved to the kept row and that the old id is gone", () => {
      const oldId = addManual(dateA);
      const keptId = addManual(dateB);
      armWorksheet(db, oldId);
      const beforeGeneration = readArmedGeneration(db);

      confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });

      expect(readArmedGeneration(db)).toBe(beforeGeneration + 1);
      const payload = JSON.parse(
        (db.prepare(`SELECT payload_json FROM cloud_outbox ORDER BY generation DESC LIMIT 1`).get() as {
          payload_json: string;
        }).payload_json,
      ) as {
        entries: Array<{ eventId: number; eventDate: string; removed?: boolean }>;
        removedEventIds: Array<{ id: number; eventDate: string }>;
      };
      const live = payload.entries.filter((e) => !e.removed);
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ eventId: keptId, eventDate: dateB });
      expect(payload.removedEventIds.map((r) => ({ id: r.id, eventDate: r.eventDate }))).toEqual([
        { id: oldId, eventDate: dateA },
      ]);
    });

    it("an unarmed pair still tells the outbox the old id is gone", () => {
      const oldId = addManual(dateA);
      addManual(dateB);
      confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });
      const row = db.prepare(`SELECT payload_json FROM cloud_outbox ORDER BY generation DESC LIMIT 1`).get() as
        | { payload_json: string }
        | undefined;
      expect(row).toBeDefined();
      const payload = JSON.parse(row!.payload_json) as { removedEventIds: Array<{ id: number }> };
      expect(payload.removedEventIds.map((r) => r.id)).toEqual([oldId]);
    });

    it("a record still on the old row keeps it: hidden, not deleted, and the result says so", () => {
      const oldId = addManual(dateA);
      const keptId = addManual(dateB);
      // A preview sent for the old date long before the confirmed print: the
      // fold leaves it behind (it is no promise about the confirmed date).
      db.prepare(
        `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at)
         VALUES (?, 'preview', 'desk@example.com', ?)`,
      ).run(oldId, `${addDays(today, -20)} 12:00:00`);
      upsertBogey(db, { event_id: oldId, source: "manual", eps_consensus: 1.5 });

      const res = confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.foldedEventId).toBe(oldId);
      expect(res.deletedEventId).toBeUndefined();
      expect(res.note).toMatch(/earnings_emails/);
      expect(manualRows().find((r) => r.id === oldId)).toMatchObject({ event_date: dateA, superseded: 1 });
      expect(showing().map((r) => r.id)).toEqual([keptId]);
      // The preview is still on file; the bogey moved.
      expect(db.prepare("SELECT event_id FROM earnings_emails").all()).toEqual([{ event_id: oldId }]);
      expect(db.prepare("SELECT event_id FROM earnings_bogeys").all()).toEqual([{ event_id: keptId }]);
    });

    it("a HIDDEN row on the confirmed date comes back and takes the print (no unique-key failure)", () => {
      const oldId = addManual(dateA);
      const keptId = addManual(dateB);
      db.prepare("UPDATE calendar_events SET superseded = 1 WHERE id = ?").run(keptId);

      const res = confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });

      expect(res).toEqual({ ok: true, deletedEventId: oldId });
      expect(manualRows().map((r) => r.id)).toEqual([keptId]);
      expect(showing().map((r) => r.id)).toEqual([keptId]);
    });

    it("with two other showing rows nothing is hidden and the notice is returned", () => {
      const a = addManual(dateA);
      const b = addManual(addDays(dateA, 1));
      const keptId = addManual(dateB);

      const res = confirmEarningsDate(db, { symbol: "NVDA", confirmedDate: dateB, confirmedTime: "amc", today });

      expect(res.ok).toBe(true);
      if (res.ok) expect(res.notice).toMatch(/several hand-entered dates/i);
      expect(showing().map((r) => r.id).sort()).toEqual([a, b, keptId].sort());
    });
  });
});
