import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { repairReconcileStrippedActuals } from "@/scripts/repair-reconcile-stripped-actuals";

// Synthetic symbols, ids and figures only (the repo is public).

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const PRINT = "2026-09-23";
const TODAY = "2026-09-25";
const FIGURE = "EPS 1.25 · Rev 100,000,000";

function insertEvent(r: {
  source: string;
  symbol: string;
  date: string;
  dateStatus?: string | null;
  superseded?: number;
  actualValue?: string | null;
  enrichedAt?: string | null;
  reaction?: string | null;
  consensus?: string | null;
  createdAt?: string;
}): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, date_status, superseded,
          actual_value, enriched_at, reaction_snapshot, consensus_estimate, raw_json, created_at)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, COALESCE(?, datetime('now')))`,
    )
    .run(
      r.source,
      r.date,
      `${r.symbol} earnings`,
      r.symbol,
      `${r.source}:${r.symbol}:${r.date}`,
      r.dateStatus ?? null,
      r.superseded ?? 0,
      r.actualValue ?? null,
      r.enrichedAt ?? null,
      r.reaction ?? null,
      r.consensus ?? null,
      r.createdAt ?? null,
    ).lastInsertRowid as number;
}

function email(eventId: number, phase: string, sentAt: string, error: string | null = null): number {
  return db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, sent_at, error)
       VALUES (?, ?, 'x@y.com', 'md', ?, ?)`,
    )
    .run(eventId, phase, sentAt, error).lastInsertRowid as number;
}

/** The damaged shape the pre-fix whole-book reconcile left behind. */
function seedDamaged(symbol: string) {
  const manual = insertEvent({
    source: "manual",
    symbol,
    date: PRINT,
    dateStatus: "user_confirmed",
    createdAt: "2026-09-10 09:00:00",
    consensus: "EPS 1.10",
  });
  email(manual, "preview", "2026-09-23 09:00:00");
  email(manual, "recap", "2026-09-23 13:00:00");
  const twin = insertEvent({
    source: "finnhub",
    symbol,
    date: PRINT,
    dateStatus: "confirmed",
    actualValue: FIGURE,
    enrichedAt: "2026-09-23 13:05:00",
    reaction: JSON.stringify({ pct: 1.5 }),
    consensus: "EPS 1.10",
  });
  // The duplicate recap the debrief sent against the resurfaced twin.
  const dupRecap = email(twin, "recap", "2026-09-24 11:00:00");
  const archived = insertEvent({
    source: "nasdaq",
    symbol,
    date: PRINT,
    superseded: 1,
    actualValue: FIGURE,
    enrichedAt: "2026-09-23 13:05:00",
  });
  return { manual, twin, dupRecap, archived };
}

function snapshot() {
  return {
    events: db.prepare("SELECT * FROM calendar_events ORDER BY id").all(),
    emails: db.prepare("SELECT * FROM earnings_emails ORDER BY id").all(),
    outbox: db.prepare("SELECT COUNT(*) AS n FROM cloud_outbox").get(),
  };
}

function ev(id: number) {
  return db
    .prepare(
      "SELECT superseded, date_status, actual_value, enriched_at, reaction_snapshot FROM calendar_events WHERE id = ?",
    )
    .get(id) as {
    superseded: number;
    date_status: string | null;
    actual_value: string | null;
    enriched_at: string | null;
    reaction_snapshot: string | null;
  };
}

describe("repairReconcileStrippedActuals", () => {
  it("dry-run finds the damaged cluster and changes nothing", () => {
    const { manual, twin, dupRecap } = seedDamaged("ZZFS");
    const before = snapshot();

    const report = repairReconcileStrippedActuals(db, { apply: false, today: TODAY });

    expect(report.applied).toBe(false);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].manualId).toBe(manual);
    expect(report.clusters[0].twinIds).toEqual([twin]);
    expect(report.clusters[0].twinEmails.map((e) => e.id)).toEqual([dupRecap]);
    // The plan names the columns it would change.
    const manualChange = report.changes.find((c) => c.id === manual)!;
    expect(Object.keys(manualChange.columns)).toEqual(
      expect.arrayContaining(["actual_value", "enriched_at", "reaction_snapshot"]),
    );
    const twinChange = report.changes.find((c) => c.id === twin)!;
    expect(twinChange.columns.superseded).toEqual({ before: 0, after: 1 });
    expect(twinChange.columns.date_status).toEqual({ before: "confirmed", after: null });

    expect(snapshot()).toEqual(before);
  });

  it("apply restores the manual row's actuals and re-supersedes the twin, leaving every email row in place", () => {
    const { manual, twin, dupRecap, archived } = seedDamaged("ZZFS");
    const emailsBefore = db.prepare("SELECT * FROM earnings_emails ORDER BY id").all();

    const report = repairReconcileStrippedActuals(db, { apply: true, today: TODAY });
    expect(report.applied).toBe(true);

    expect(ev(manual).superseded).toBe(0);
    expect(ev(manual).date_status).toBe("user_confirmed");
    expect(ev(manual).actual_value).toBe(FIGURE);
    expect(ev(manual).enriched_at).toBe("2026-09-23 13:05:00");
    expect(ev(manual).reaction_snapshot).not.toBeNull();
    expect(ev(twin).superseded).toBe(1);
    expect(ev(twin).date_status).toBeNull();
    expect(ev(archived).superseded).toBe(1);

    // The duplicate recap is a real delivery: untouched, still on the twin.
    expect(db.prepare("SELECT * FROM earnings_emails ORDER BY id").all()).toEqual(emailsBefore);
    expect(
      (db.prepare("SELECT event_id FROM earnings_emails WHERE id = ?").get(dupRecap) as { event_id: number })
        .event_id,
    ).toBe(twin);

    // The fixed reconciler leaves the repaired cluster alone.
    reconcileEarningsDates(db, { today: TODAY });
    expect(ev(manual).actual_value).toBe(FIGURE);
    expect(ev(twin).superseded).toBe(1);
  });

  it("a rerun after apply is a no-op", () => {
    seedDamaged("ZZFS");
    repairReconcileStrippedActuals(db, { apply: true, today: TODAY });
    const after = snapshot();

    const rerun = repairReconcileStrippedActuals(db, { apply: true, today: TODAY });

    expect(rerun.clusters).toHaveLength(0);
    expect(rerun.changes).toHaveLength(0);
    expect(snapshot()).toEqual(after);
  });

  it("--symbol narrows the repair to one name", () => {
    const fs = seedDamaged("ZZFS");
    const nk = seedDamaged("ZZNK");

    const report = repairReconcileStrippedActuals(db, { apply: true, today: TODAY, symbol: "zznk" });

    expect(report.clusters.map((c) => c.manualId)).toEqual([nk.manual]);
    expect(ev(nk.manual).actual_value).toBe(FIGURE);
    expect(ev(fs.manual).actual_value).toBeNull();
    expect(ev(fs.twin).superseded).toBe(0);
  });

  it("ignores manual rows without a delivered email, future-dated rows, and twins without actuals", () => {
    // No delivered email: only a live claim.
    const a = insertEvent({ source: "manual", symbol: "ZZAA", date: PRINT, dateStatus: "user_confirmed" });
    email(a, "recap", "2026-09-23 13:00:00", "in_progress");
    insertEvent({ source: "finnhub", symbol: "ZZAA", date: PRINT, actualValue: FIGURE });
    // Future-dated.
    const b = insertEvent({ source: "manual", symbol: "ZZBB", date: "2026-09-30", dateStatus: "user_confirmed" });
    email(b, "preview", "2026-09-30 09:00:00");
    insertEvent({ source: "finnhub", symbol: "ZZBB", date: "2026-09-30", actualValue: FIGURE });
    // Twin without actuals.
    const c = insertEvent({ source: "manual", symbol: "ZZCC", date: PRINT, dateStatus: "user_confirmed" });
    email(c, "preview", "2026-09-23 09:00:00");
    insertEvent({ source: "finnhub", symbol: "ZZCC", date: PRINT });

    const report = repairReconcileStrippedActuals(db, { apply: false, today: TODAY });
    expect(report.clusters).toHaveLength(0);
  });
});
