import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  findMisplacedPreviewRows,
  findPhantomOculDeleteCandidate,
  findOculBackfillCandidate,
  repairEarningsPreviewAudit,
} from "@/scripts/repair-earnings-preview-audit";

// ─── DB fixtures ────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

interface SeedEventOpts {
  source: string;
  symbol: string;
  date: string;
  sourceKey?: string;
  superseded?: 0 | 1;
  dateStatus?: string | null;
  actualValue?: string | null;
  epsActual?: number | null;
  releaseTime?: string | null;
}

function seedEvent(db: Database.Database, o: SeedEventOpts): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, title, symbol, source_key, superseded,
          date_status, actual_value, release_time, raw_json)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.source,
      o.date,
      `${o.symbol} earnings`,
      o.symbol,
      o.sourceKey ?? `${o.source}:${o.symbol}:${o.date}`,
      o.superseded ?? 0,
      o.dateStatus ?? null,
      o.actualValue ?? null,
      o.releaseTime ?? "16:15",
      JSON.stringify({ entry: { epsActual: o.epsActual ?? null } }),
    ).lastInsertRowid as number;
}

function seedPreviewEmail(db: Database.Database, eventId: number, sentAt: string): number {
  return db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, sent_at)
       VALUES (?, 'preview', 'x@y.com', 'md', ?)`,
    )
    .run(eventId, sentAt).lastInsertRowid as number;
}

function seedRecapEmail(db: Database.Database, eventId: number, sentAt: string): number {
  return db
    .prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, sent_at)
       VALUES (?, 'recap', 'x@y.com', 'md', ?)`,
    )
    .run(eventId, sentAt).lastInsertRowid as number;
}

function seedPreviewSkip(db: Database.Database, eventId: number, skippedAt: string): number {
  return db
    .prepare(`INSERT INTO earnings_email_skips (event_id, phase, skipped_at) VALUES (?, 'preview', ?)`)
    .run(eventId, skippedAt).lastInsertRowid as number;
}

function seedBogey(db: Database.Database, eventId: number): number {
  return db
    .prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus)
       VALUES (?, 'manual', 'test', 1.0)`,
    )
    .run(eventId).lastInsertRowid as number;
}

function emailRow(db: Database.Database, id: number): { event_id: number } {
  return db.prepare("SELECT event_id FROM earnings_emails WHERE id = ?").get(id) as {
    event_id: number;
  };
}

function eventRow(
  db: Database.Database,
  id: number,
): { actual_value: string | null; enriched_at: string | null } | undefined {
  return db
    .prepare("SELECT actual_value, enriched_at FROM calendar_events WHERE id = ?")
    .get(id) as { actual_value: string | null; enriched_at: string | null } | undefined;
}

const TODAY = "2026-08-10";

// ─── findMisplacedPreviewRows ───────────────────────────────────────

describe("findMisplacedPreviewRows", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("(a) finds the correct origin among multiple candidates, preferring the future-side on a distance tie", () => {
    // Misplaced/current: a non-superseded event dated well after the sent
    // date — the preview was dragged here and no longer plausibly covers it.
    const misplaced = seedEvent(db, { source: "nasdaq", symbol: "XYZ", date: "2026-07-01" });
    const rowId = seedPreviewEmail(db, misplaced, "2026-06-10 14:00:00");

    // Candidates within [sentDate-1, sentDate+3] = [2026-06-09, 2026-06-13].
    const candPast = seedEvent(db, { source: "nasdaq", symbol: "XYZ", date: "2026-06-09" }); // distance 1, past
    const candFuture = seedEvent(db, { source: "finnhub", symbol: "XYZ", date: "2026-06-11" }); // distance 1, future — expected winner
    seedEvent(db, { source: "nasdaq", symbol: "XYZ", date: "2026-06-13" }); // distance 3, farther — must lose
    seedEvent(db, { source: "finnhub", symbol: "XYZ", date: "2026-06-08" }); // outside range — must be excluded

    const result = findMisplacedPreviewRows(db);
    expect(result.skipped).toHaveLength(0);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].row.rowId).toBe(rowId);
    expect(result.plans[0].row.currentEventId).toBe(misplaced);
    expect(result.plans[0].originEventId).toBe(candFuture);
    expect(result.plans[0].originEventId).not.toBe(candPast);
  });

  it("(b) reports a skip (never guesses) when no origin candidate exists in the window", () => {
    const misplaced = seedEvent(db, { source: "nasdaq", symbol: "LONER", date: "2026-07-01" });
    const rowId = seedPreviewEmail(db, misplaced, "2026-06-10 14:00:00");
    // No other LONER events at all.

    const result = findMisplacedPreviewRows(db);
    expect(result.plans).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].row.rowId).toBe(rowId);

    // Applying must leave the row untouched.
    const before = emailRow(db, rowId);
    repairEarningsPreviewAudit(db, { apply: true, today: TODAY });
    expect(emailRow(db, rowId)).toEqual(before);
  });

  it("ignores a preview row whose current event is already superseded (not eligible for this pass)", () => {
    const superseded = seedEvent(db, {
      source: "nasdaq",
      symbol: "SUP",
      date: "2026-07-01",
      superseded: 1,
    });
    seedPreviewEmail(db, superseded, "2026-06-10 14:00:00");
    seedEvent(db, { source: "finnhub", symbol: "SUP", date: "2026-06-11" });

    const result = findMisplacedPreviewRows(db);
    expect(result.plans).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("ignores a preview row whose sent date plausibly covers its current event (not stale)", () => {
    const current = seedEvent(db, { source: "nasdaq", symbol: "OK", date: "2026-07-01" });
    seedPreviewEmail(db, current, "2026-06-30 14:00:00"); // 1 day before — plausible

    const result = findMisplacedPreviewRows(db);
    expect(result.plans).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("also scans earnings_email_skips (preview-phase) with the same rule", () => {
    const misplaced = seedEvent(db, { source: "nasdaq", symbol: "SKP", date: "2026-07-01" });
    const rowId = seedPreviewSkip(db, misplaced, "2026-06-10 12:00:00");
    const origin = seedEvent(db, { source: "finnhub", symbol: "SKP", date: "2026-06-11" });

    const result = findMisplacedPreviewRows(db);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].row.table).toBe("earnings_email_skips");
    expect(result.plans[0].row.rowId).toBe(rowId);
    expect(result.plans[0].originEventId).toBe(origin);
  });
});

// ─── findPhantomOculDeleteCandidate ─────────────────────────────────

describe("findPhantomOculDeleteCandidate", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  const PHANTOM_KEY = "manual:OCUL:2026-08-10:earnings";

  it("(c1) refuses when the phantom row still has children (earnings_emails)", () => {
    const phantom = seedEvent(db, {
      source: "manual",
      symbol: "OCUL",
      date: "2026-08-10",
      sourceKey: PHANTOM_KEY,
      dateStatus: "user_confirmed",
    });
    seedPreviewEmail(db, phantom, "2026-08-10 14:00:00"); // still attached
    seedEvent(db, {
      source: "nasdaq",
      symbol: "OCUL",
      date: "2026-08-03",
      actualValue: "EPS -0.35",
      epsActual: -0.35,
    });

    const check = findPhantomOculDeleteCandidate(db);
    expect(check.eligible).toBe(false);
    expect(check.reason).toMatch(/child/i);
  });

  it("(c1b) refuses when the phantom row still has an earnings_bogeys child", () => {
    const phantom = seedEvent(db, {
      source: "manual",
      symbol: "OCUL",
      date: "2026-08-10",
      sourceKey: PHANTOM_KEY,
      dateStatus: "user_confirmed",
    });
    seedBogey(db, phantom);
    seedEvent(db, {
      source: "nasdaq",
      symbol: "OCUL",
      date: "2026-08-03",
      actualValue: "EPS -0.35",
      epsActual: -0.35,
    });

    const check = findPhantomOculDeleteCandidate(db);
    expect(check.eligible).toBe(false);
    expect(check.reason).toMatch(/child/i);
  });

  it("(c2) refuses when no reported sibling exists within 14 days before it", () => {
    const phantom = seedEvent(db, {
      source: "manual",
      symbol: "OCUL",
      date: "2026-08-10",
      sourceKey: PHANTOM_KEY,
      dateStatus: "user_confirmed",
    });
    // A sibling exists but has NO reported evidence (epsActual null, actual_value null).
    seedEvent(db, { source: "nasdaq", symbol: "OCUL", date: "2026-08-03" });
    void phantom;

    const check = findPhantomOculDeleteCandidate(db);
    expect(check.eligible).toBe(false);
    expect(check.reason).toMatch(/sibling/i);
  });

  it("is eligible when the source_key matches, has zero children, and a reported sibling exists within 14 days before", () => {
    const phantom = seedEvent(db, {
      source: "manual",
      symbol: "OCUL",
      date: "2026-08-10",
      sourceKey: PHANTOM_KEY,
      dateStatus: "user_confirmed",
    });
    seedEvent(db, {
      source: "nasdaq",
      symbol: "OCUL",
      date: "2026-08-03",
      epsActual: -0.35,
    });

    const check = findPhantomOculDeleteCandidate(db);
    expect(check.eligible).toBe(true);
    expect(check.eventId).toBe(phantom);
  });

  it("reports not-eligible when no row has that exact source_key", () => {
    const check = findPhantomOculDeleteCandidate(db);
    expect(check.eligible).toBe(false);
    expect(check.reason).toMatch(/no calendar_events row/i);
  });
});

// ─── findOculBackfillCandidate ──────────────────────────────────────

describe("findOculBackfillCandidate", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  const REAL_PRINT_KEY = "nasdaq:OCUL:2026-08-03";

  it("(d1) is eligible and extracts epsActual when actual_value is NULL and raw_json has a numeric epsActual", () => {
    const real = seedEvent(db, {
      source: "nasdaq",
      symbol: "OCUL",
      date: "2026-08-03",
      sourceKey: REAL_PRINT_KEY,
      epsActual: -0.35,
    });

    const check = findOculBackfillCandidate(db);
    expect(check.eligible).toBe(true);
    expect(check.eventId).toBe(real);
    expect(check.epsActual).toBe(-0.35);
  });

  it("(d2) refuses when actual_value is already set (never overwrites)", () => {
    seedEvent(db, {
      source: "nasdaq",
      symbol: "OCUL",
      date: "2026-08-03",
      sourceKey: REAL_PRINT_KEY,
      actualValue: "EPS -0.35",
      epsActual: -0.35,
    });

    const check = findOculBackfillCandidate(db);
    expect(check.eligible).toBe(false);
    expect(check.reason).toMatch(/already has actual_value/i);
  });

  it("refuses when raw_json has no numeric epsActual", () => {
    seedEvent(db, {
      source: "nasdaq",
      symbol: "OCUL",
      date: "2026-08-03",
      sourceKey: REAL_PRINT_KEY,
      epsActual: null,
    });

    const check = findOculBackfillCandidate(db);
    expect(check.eligible).toBe(false);
    expect(check.reason).toMatch(/epsActual/);
  });

  it("refuses when no row has that exact source_key", () => {
    const check = findOculBackfillCandidate(db);
    expect(check.eligible).toBe(false);
  });
});

// ─── repairEarningsPreviewAudit — apply writes the backfill ────────

describe("repairEarningsPreviewAudit — backfill write", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("(d) writes 'EPS <n>' + enriched_at + a recap skip row on apply", () => {
    const real = seedEvent(db, {
      source: "nasdaq",
      symbol: "OCUL",
      date: "2026-08-03",
      sourceKey: "nasdaq:OCUL:2026-08-03",
      epsActual: -0.35,
    });

    const result = repairEarningsPreviewAudit(db, { apply: true, today: TODAY });
    expect(result.backfilled).toBe(true);

    const after = eventRow(db, real)!;
    expect(after.actual_value).toBe("EPS -0.35");
    expect(after.enriched_at).not.toBeNull();

    const skip = db
      .prepare("SELECT phase FROM earnings_email_skips WHERE event_id = ?")
      .get(real) as { phase: string } | undefined;
    expect(skip?.phase).toBe("recap");
  });

  it("dry-run (apply:false) computes the identical plan but writes nothing", () => {
    const real = seedEvent(db, {
      source: "nasdaq",
      symbol: "OCUL",
      date: "2026-08-03",
      sourceKey: "nasdaq:OCUL:2026-08-03",
      epsActual: -0.35,
    });

    const before = eventRow(db, real);
    const result = repairEarningsPreviewAudit(db, { apply: false, today: TODAY });
    expect(result.backfill.eligible).toBe(true);
    expect(result.backfilled).toBe(false); // reported but not committed... unless we chose to report actual write flag
    expect(eventRow(db, real)).toEqual(before);
    const skip = db
      .prepare("SELECT COUNT(*) AS c FROM earnings_email_skips WHERE event_id = ?")
      .get(real) as { c: number };
    expect(skip.c).toBe(0);
  });
});

// ─── Full pipeline — the live NBIS + OCUL shape ─────────────────────

describe("repairEarningsPreviewAudit — full pipeline (live NBIS/OCUL shape)", () => {
  let db: Database.Database;
  let nbisPhantom: number;
  let nbisNasdaq: number;
  let nbisAgreeingFinnhub: number;
  let oculReal: number;
  let oculNasdaqGuess: number;
  let oculManualPhantom: number;
  let oculFinnhubDup: number;
  let previewNbisId: number;
  let previewOculId: number;

  beforeEach(() => {
    db = createTestDb();

    // NBIS: finnhub phantom (07-29) got a preview sent; nasdaq + finnhub
    // later agree on the real print 08-12 (14 days later).
    nbisPhantom = seedEvent(db, { source: "finnhub", symbol: "NBIS", date: "2026-07-29" });
    previewNbisId = seedPreviewEmail(db, nbisPhantom, "2026-07-29 18:16:54");
    nbisNasdaq = seedEvent(db, { source: "nasdaq", symbol: "NBIS", date: "2026-08-12" });
    nbisAgreeingFinnhub = seedEvent(db, {
      source: "finnhub",
      symbol: "NBIS",
      date: "2026-08-12",
      releaseTime: "08:00",
    });
    void nbisNasdaq;

    // Simulate reconcile already having run once before (the pre-fix
    // defect): the preview got dragged onto the nasdaq row, which is the
    // "misplaced" state this script must repair. (In the live DB this is
    // exactly what happened — a prior reconcile pass already repointed it.)
    db.prepare("UPDATE earnings_emails SET event_id = ? WHERE id = ?").run(
      nbisNasdaq,
      previewNbisId,
    );
    // The nasdaq row is superseded=0 in this "already dragged" snapshot
    // (matches the pre-rerun live state before this script's step 4 runs).

    // OCUL: real print 08-03 (nasdaq, has epsActual in raw_json but
    // actual_value column not yet backfilled); a provisional nasdaq guess at
    // 08-04 got a preview sent, then a manual "next quarter" row landed on
    // 08-10 and (pre-fix) stole the preview + became canonical over 08-04.
    oculReal = seedEvent(db, {
      source: "nasdaq",
      symbol: "OCUL",
      date: "2026-08-03",
      sourceKey: "nasdaq:OCUL:2026-08-03",
      epsActual: -0.35,
    });
    oculNasdaqGuess = seedEvent(db, {
      source: "nasdaq",
      symbol: "OCUL",
      date: "2026-08-04",
      superseded: 1,
    });
    oculManualPhantom = seedEvent(db, {
      source: "manual",
      symbol: "OCUL",
      date: "2026-08-10",
      sourceKey: "manual:OCUL:2026-08-10:earnings",
      dateStatus: "user_confirmed",
    });
    oculFinnhubDup = seedEvent(db, {
      source: "finnhub",
      symbol: "OCUL",
      date: "2026-08-10",
      superseded: 1,
    });
    previewOculId = seedPreviewEmail(db, oculNasdaqGuess, "2026-08-04 18:15:45");
    // Pre-fix drag: the preview ends up on the manual row.
    db.prepare("UPDATE earnings_emails SET event_id = ? WHERE id = ?").run(
      oculManualPhantom,
      previewOculId,
    );
  });

  it("(dry-run) reports exactly the 2 expected preview repoints, the phantom delete, and the backfill — writes nothing", () => {
    const result = repairEarningsPreviewAudit(db, { apply: false, today: TODAY });

    expect(result.previewRepoints.plans).toHaveLength(2);
    const byRowId = new Map(result.previewRepoints.plans.map((p) => [p.row.rowId, p]));
    expect(byRowId.get(previewNbisId)?.originEventId).toBe(nbisPhantom);
    expect(byRowId.get(previewOculId)?.originEventId).toBe(oculNasdaqGuess);

    expect(result.phantomDelete.eligible).toBe(true);
    expect(result.phantomDelete.eventId).toBe(oculManualPhantom);
    expect(result.backfill.eligible).toBe(true);
    expect(result.backfill.eventId).toBe(oculReal);

    // Nothing committed.
    expect(emailRow(db, previewNbisId).event_id).toBe(nbisNasdaq);
    expect(emailRow(db, previewOculId).event_id).toBe(oculManualPhantom);
    expect(
      db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(oculManualPhantom),
    ).toBeDefined();
    expect(eventRow(db, oculReal)!.actual_value).toBeNull();
  });

  it("(apply) repoints both previews home, deletes the phantom, backfills the real print, and reconciles", () => {
    const result = repairEarningsPreviewAudit(db, { apply: true, today: TODAY });

    expect(result.repointedCount).toBe(2);
    expect(result.deleted).toBe(true);
    expect(result.backfilled).toBe(true);

    // NBIS preview stays on the phantom (07-29) — it never covered 08-12.
    expect(emailRow(db, previewNbisId).event_id).toBe(nbisPhantom);

    // OCUL preview is now correctly homed. After reconcile re-clusters
    // (manual phantom gone), the whole OCUL family folds onto the real
    // print (oculReal) — including the now-correctly-homed preview, since
    // its send date is >= the canonical print date minus 1 day (a
    // later-than-print send still documents that print per the reconcile
    // gate).
    const oculEmail = emailRow(db, previewOculId).event_id;
    const oculEmailEvent = db
      .prepare("SELECT symbol, superseded FROM calendar_events WHERE id = ?")
      .get(oculEmail) as { symbol: string; superseded: number };
    expect(oculEmailEvent.symbol).toBe("OCUL");
    expect(oculEmailEvent.superseded).toBe(0);

    // Phantom manual row is gone.
    expect(
      db.prepare("SELECT id FROM calendar_events WHERE id = ?").get(oculManualPhantom),
    ).toBeUndefined();

    // Real print backfilled.
    const real = eventRow(db, oculReal)!;
    expect(real.actual_value).toBe("EPS -0.35");
    expect(real.enriched_at).not.toBeNull();

    // NBIS canonical (post-reconcile) is now the agreeing 08-12 row and
    // carries no preview-phase email or skip — it's preview-candidate
    // eligible for the sweep.
    const nbisCanonical = db
      .prepare(
        "SELECT id, superseded, release_time FROM calendar_events WHERE symbol = 'NBIS' AND superseded = 0",
      )
      .get() as { id: number; superseded: number; release_time: string | null };
    expect(nbisCanonical.id).toBe(nbisAgreeingFinnhub);
    expect(nbisCanonical.release_time).not.toBeNull();
    const previewOnCanonical = db
      .prepare(
        "SELECT COUNT(*) AS c FROM earnings_emails WHERE event_id = ? AND phase = 'preview'",
      )
      .get(nbisCanonical.id) as { c: number };
    expect(previewOnCanonical.c).toBe(0);
    const skipOnCanonical = db
      .prepare(
        "SELECT COUNT(*) AS c FROM earnings_email_skips WHERE event_id = ? AND phase = 'preview'",
      )
      .get(nbisCanonical.id) as { c: number };
    expect(skipOnCanonical.c).toBe(0);
  });

  it("(e) is idempotent — a second full apply run finds nothing further to do", () => {
    repairEarningsPreviewAudit(db, { apply: true, today: TODAY });

    const snapshotAfterFirst = db.prepare("SELECT * FROM calendar_events ORDER BY id").all();
    const emailsAfterFirst = db.prepare("SELECT * FROM earnings_emails ORDER BY id").all();
    const skipsAfterFirst = db.prepare("SELECT * FROM earnings_email_skips ORDER BY id").all();

    const second = repairEarningsPreviewAudit(db, { apply: true, today: "2026-08-11" });
    expect(second.repointedCount).toBe(0);
    expect(second.deleted).toBe(false);
    expect(second.backfilled).toBe(false);
    expect(second.previewRepoints.plans).toHaveLength(0);

    expect(db.prepare("SELECT * FROM calendar_events ORDER BY id").all()).toEqual(
      snapshotAfterFirst,
    );
    expect(db.prepare("SELECT * FROM earnings_emails ORDER BY id").all()).toEqual(
      emailsAfterFirst,
    );
    expect(db.prepare("SELECT * FROM earnings_email_skips ORDER BY id").all()).toEqual(
      skipsAfterFirst,
    );
  });

  it("affectedEvents summarizes NBIS + OCUL events with preview-email/skip presence", () => {
    const result = repairEarningsPreviewAudit(db, { apply: true, today: TODAY });
    const symbols = new Set(result.affectedEvents.map((e) => e.symbol));
    expect(symbols.has("NBIS")).toBe(true);
    expect(symbols.has("OCUL")).toBe(true);
    // The deleted phantom must not appear.
    expect(result.affectedEvents.some((e) => e.id === oculManualPhantom)).toBe(false);
    void oculFinnhubDup;
  });
});
