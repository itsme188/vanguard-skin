import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { confirmEarningsDate } from "@/lib/mutations/confirm-earnings-date";

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
});
