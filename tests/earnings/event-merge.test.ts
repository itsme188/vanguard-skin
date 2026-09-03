/**
 * mergeEarningsEventState — the cross-slice merge registry (live print v2, slice A §4.1).
 *
 * One `it` per row of the spec's merge matrix. Every symbol is synthetic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { upsertBogey } from "@/lib/mutations/earnings-bogeys";
import {
  mergeEarningsEventState,
  registerEventMergeHandler,
  listEventMergeHandlers,
  __resetEventMergeHandlersForTests,
} from "@/lib/earnings/event-merge";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  __resetEventMergeHandlersForTests();
});
afterEach(() => __resetEventMergeHandlersForTests());

const seed = (symbol: string, date: string) =>
  Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('manual','earnings',?,?,?,?)`,
      )
      .run(date, symbol, `k:${symbol}:${date}`, symbol).lastInsertRowid,
  );

const step = (eventId: number, name: string, status: string, fp: string, attempts = 0) =>
  db
    .prepare(
      `INSERT INTO earnings_prepare_steps (event_id, step, status, input_fingerprint, attempts)
       VALUES (?,?,?,?,?)`,
    )
    .run(eventId, name, status, fp, attempts);

const scan = (eventId: number, articleId: number, status: string) =>
  db
    .prepare(
      `INSERT INTO earnings_bogey_scans (event_id, article_id, extractor_version, status)
       VALUES (?,?,1,?)`,
    )
    .run(eventId, articleId, status);

describe("mergeEarningsEventState — A's merge matrix (spec §4.1)", () => {
  it("flags: target keeps its row; printed_at is the non-null side; donor flag deleted", () => {
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    armWorksheet(db, donor);
    db.prepare(
      `UPDATE earnings_worksheet_flags SET printed_at = '2026-09-01 10:00:00' WHERE event_id = ?`,
    ).run(donor);
    armWorksheet(db, target);

    const report = db.transaction(() => mergeEarningsEventState(db, donor, target))();

    expect(db.prepare(`SELECT event_id, printed_at FROM earnings_worksheet_flags`).all()).toEqual([
      { event_id: target, printed_at: "2026-09-01 10:00:00" },
    ]);
    expect(report.handlers.map((h) => h.name)).toContain("builtin:worksheet_flags");
  });

  it("flags: an armed donor moving onto an unarmed target arms the target", () => {
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    armWorksheet(db, donor);

    db.transaction(() => mergeEarningsEventState(db, donor, target))();

    expect(db.prepare(`SELECT event_id FROM earnings_worksheet_flags`).all()).toEqual([
      { event_id: target },
    ]);
  });

  it("prepare steps: equal fingerprints keep the more advanced status; differing fingerprints reset to pending/0", () => {
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    step(donor, "intel", "done", "fpA", 1);
    step(target, "intel", "failed", "fpA", 3);
    step(donor, "con_id", "done", "fpX", 1);
    step(target, "con_id", "pending", "fpY", 0);
    step(donor, "consensus_row", "done", "fpC", 1); // absent on target → moves

    db.transaction(() => mergeEarningsEventState(db, donor, target))();

    const rows = db
      .prepare(
        `SELECT step, status, attempts, input_fingerprint FROM earnings_prepare_steps
          WHERE event_id = ? ORDER BY step`,
      )
      .all(target);
    expect(rows).toEqual([
      { step: "con_id", status: "pending", attempts: 0, input_fingerprint: null },
      { step: "consensus_row", status: "done", attempts: 1, input_fingerprint: "fpC" },
      { step: "intel", status: "done", attempts: 1, input_fingerprint: "fpA" },
    ]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM earnings_prepare_steps WHERE event_id = ?`).get(donor),
    ).toEqual({ n: 0 });
  });

  it("[C-12] a live claim on the target outranks a donor's failure", () => {
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    step(donor, "intel", "failed", "fpA", 4);
    step(target, "intel", "claimed", "fpA", 1);

    db.transaction(() => mergeEarningsEventState(db, donor, target))();

    expect(
      db
        .prepare(`SELECT status, attempts FROM earnings_prepare_steps WHERE event_id = ? AND step = 'intel'`)
        .get(target),
    ).toEqual({ status: "claimed", attempts: 1 });
  });

  it("scan ledger: terminal precedence hit > no_numbers > error > claimed; a donor hit is never lost", () => {
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    db.prepare(`INSERT INTO research_sources (name) VALUES ('src')`).run();
    for (const id of [1, 2, 3])
      db.prepare(
        `INSERT INTO research_articles (id, source_id, subject, sender, received_at, raw_text)
         VALUES (?, 1, 's', 'from@example.com', '2026-09-01', 'x')`,
      ).run(id);
    scan(donor, 1, "hit");
    scan(target, 1, "claimed");
    scan(donor, 2, "error");
    scan(target, 2, "no_numbers");
    scan(donor, 3, "no_numbers");

    db.transaction(() => mergeEarningsEventState(db, donor, target))();

    expect(
      db
        .prepare(
          `SELECT article_id, status FROM earnings_bogey_scans WHERE event_id = ? ORDER BY article_id`,
        )
        .all(target),
    ).toEqual([
      { article_id: 1, status: "hit" },
      { article_id: 2, status: "no_numbers" },
      { article_id: 3, status: "no_numbers" },
    ]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogey_scans WHERE event_id = ?`).get(donor),
    ).toEqual({ n: 0 });
  });

  it("bogeys: existing repoint kept; on a (source, source_label) collision the newer uploaded_at wins field-by-field where the other is null", () => {
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    upsertBogey(db, {
      event_id: target,
      source: "newsletter",
      source_label: "Desk Notes 8/21",
      eps_consensus: 0.6,
      revenue_consensus_usd: null,
    });
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-21 09:00:00' WHERE event_id = ?`).run(
      target,
    );
    upsertBogey(db, {
      event_id: donor,
      source: "newsletter",
      source_label: "Desk Notes 8/21",
      eps_consensus: null,
      revenue_consensus_usd: 1.5e9,
      guidance_notes: "product rev 1.49B",
    });
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-25 09:00:00' WHERE event_id = ?`).run(
      donor,
    );
    upsertBogey(db, { event_id: donor, source: "manual", source_label: "desk", eps_consensus: 0.62 }); // no collision → repoints

    db.transaction(() => mergeEarningsEventState(db, donor, target))();

    const rows = db
      .prepare(
        `SELECT source, source_label, eps_consensus, revenue_consensus_usd, guidance_notes
           FROM earnings_bogeys WHERE event_id = ? ORDER BY source`,
      )
      .all(target);
    expect(rows).toEqual([
      {
        source: "manual",
        source_label: "desk",
        eps_consensus: 0.62,
        revenue_consensus_usd: null,
        guidance_notes: null,
      },
      {
        source: "newsletter",
        source_label: "Desk Notes 8/21",
        eps_consensus: 0.6,
        revenue_consensus_usd: 1.5e9,
        guidance_notes: "product rev 1.49B",
      },
    ]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys WHERE event_id = ?`).get(donor),
    ).toEqual({ n: 0 });
  });

  it("bogeys: when BOTH sides publish the same column, the newer uploaded_at wins and the older value is destroyed with the donor row", () => {
    // The destructive branch: not "fill in a null" but "two numbers disagree".
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    upsertBogey(db, {
      event_id: target,
      source: "newsletter",
      source_label: "Desk Notes",
      eps_consensus: 0.5,
      revenue_consensus_usd: 1.0e9,
      guidance_notes: "older read",
      source_url: "https://example.test/old",
      ai_extraction_model: "m-old",
    });
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-20 09:00:00' WHERE event_id = ?`).run(
      target,
    );
    upsertBogey(db, {
      event_id: donor,
      source: "newsletter",
      source_label: "Desk Notes",
      eps_consensus: 0.55,
      revenue_consensus_usd: 1.2e9,
      guidance_notes: "newer read",
      notes: "donor-only column", // absent on the target → the union still carries it
      source_url: "https://example.test/new",
      ai_extraction_model: "m-new",
    });
    const donorBogeyId = (
      db.prepare(`SELECT id FROM earnings_bogeys WHERE event_id = ?`).get(donor) as { id: number }
    ).id;
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-25 09:00:00' WHERE event_id = ?`).run(
      donor,
    );

    db.transaction(() => mergeEarningsEventState(db, donor, target))();

    const rows = db
      .prepare(
        `SELECT event_id, eps_consensus, revenue_consensus_usd, guidance_notes, notes,
                source_url, ai_extraction_model, uploaded_at
           FROM earnings_bogeys`,
      )
      .all();
    // Exactly one surviving row, on the target, carrying every newer value…
    expect(rows).toEqual([
      {
        event_id: target,
        eps_consensus: 0.55,
        revenue_consensus_usd: 1.2e9,
        guidance_notes: "newer read",
        notes: "donor-only column",
        source_url: "https://example.test/new",
        ai_extraction_model: "m-new",
        uploaded_at: "2026-08-25 09:00:00",
      },
    ]);
    // …and the donor ROW itself is gone, not merely repointed.
    expect(
      db.prepare(`SELECT id FROM earnings_bogeys WHERE id = ?`).get(donorBogeyId),
    ).toBeUndefined();
  });

  it("bogeys: an ISO-T uploaded_at never mis-orders against the space form (datetime() on both sides)", () => {
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    upsertBogey(db, { event_id: target, source: "manual", source_label: "desk", eps_consensus: 0.5 });
    // SAME DAY, target an hour LATER — so the target is genuinely newer and
    // its 0.5 must survive. A raw string compare gets this backwards: the two
    // strings first differ at index 10, where the donor's 'T' (0x54) beats the
    // target's ' ' (0x20), so the donor would be declared newer and 0.7 would
    // win. datetime() on both sides normalises the T away.
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-25 10:00:00' WHERE event_id = ?`).run(
      target,
    );
    upsertBogey(db, { event_id: donor, source: "manual", source_label: "desk", eps_consensus: 0.7 });
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-25T09:00:00' WHERE event_id = ?`).run(
      donor,
    );

    db.transaction(() => mergeEarningsEventState(db, donor, target))();

    expect(db.prepare(`SELECT eps_consensus FROM earnings_bogeys`).all()).toEqual([
      { eps_consensus: 0.5 },
    ]);
  });

  it("[C-13] reports changed=true only when something moved, merged, or was deleted; it never writes the outbox itself", () => {
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    expect(db.transaction(() => mergeEarningsEventState(db, donor, target))().changed).toBe(false);

    armWorksheet(db, donor); // gen 1
    const report = db.transaction(() => mergeEarningsEventState(db, donor, target))();

    expect(report.changed).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cloud_outbox`).get()).toEqual({ n: 1 }); // still only the arm's row
  });

  it("[C-5] email audit: a donor's delivered recap replaces the target's failed row; a live in_progress claim is never touched; a skip on either side survives", () => {
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    const email = (eventId: number, phase: string, error: string | null) =>
      db
        .prepare(
          `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error)
           VALUES (?, ?, 'me@example.com', datetime('now'), ?)`,
        )
        .run(eventId, phase, error);
    email(donor, "recap", null);
    email(target, "recap", "provider 500"); // delivered donor vs failed target → donor wins
    email(donor, "preview", "sent-by-cloud");
    email(target, "preview", "in_progress"); // live claim → untouched
    db.prepare(
      `INSERT INTO earnings_email_skips (event_id, phase, skipped_at) VALUES (?, 'recap', datetime('now'))`,
    ).run(donor);

    db.transaction(() => mergeEarningsEventState(db, donor, target))();

    const rows = db
      .prepare(`SELECT event_id, phase, error FROM earnings_emails ORDER BY phase, event_id`)
      .all();
    expect(rows).toEqual([
      { event_id: donor, phase: "preview", error: "sent-by-cloud" }, // stays on the donor (dies with the cascade later)
      { event_id: target, phase: "preview", error: "in_progress" },
      { event_id: target, phase: "recap", error: null }, // the delivered row, re-homed
    ]);
    expect(db.prepare(`SELECT event_id FROM earnings_email_skips`).all()).toEqual([
      { event_id: target },
    ]);
  });

  it("[NBIS] a donor preview whose send date could not have covered the target's print stays behind", () => {
    const donor = seed("ACME", "2026-07-29");
    const target = seed("ACME", "2026-08-12");
    db.prepare(
      `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at) VALUES (?, 'preview', 'me@example.com', '2026-07-29 18:16:54')`,
    ).run(donor);
    db.prepare(
      `INSERT INTO earnings_email_skips (event_id, phase, skipped_at) VALUES (?, 'preview', '2026-07-29 18:16:54')`,
    ).run(donor);

    db.transaction(() => mergeEarningsEventState(db, donor, target))();

    expect(db.prepare(`SELECT event_id FROM earnings_emails`).all()).toEqual([{ event_id: donor }]);
    expect(db.prepare(`SELECT event_id FROM earnings_email_skips`).all()).toEqual([
      { event_id: donor },
    ]);
  });

  it("[C-6] a winning donor value carries its provenance onto the surviving row", () => {
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    upsertBogey(db, {
      event_id: target,
      source: "pdf_upload",
      source_label: "sheet",
      eps_consensus: null,
      raw_pdf_r2_key: "r2/old.pdf",
      ai_extraction_model: "m-old",
    });
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-20 09:00:00' WHERE event_id = ?`).run(
      target,
    );
    upsertBogey(db, {
      event_id: donor,
      source: "pdf_upload",
      source_label: "sheet",
      eps_consensus: 0.61,
      raw_pdf_r2_key: "r2/new.pdf",
      ai_extraction_model: "m-new",
    });
    db.prepare(`UPDATE earnings_bogeys SET uploaded_at = '2026-08-25 09:00:00' WHERE event_id = ?`).run(
      donor,
    );

    db.transaction(() => mergeEarningsEventState(db, donor, target))();

    expect(
      db
        .prepare(
          `SELECT eps_consensus, raw_pdf_r2_key, ai_extraction_model FROM earnings_bogeys WHERE event_id = ?`,
        )
        .get(target),
    ).toEqual({ eps_consensus: 0.61, raw_pdf_r2_key: "r2/new.pdf", ai_extraction_model: "m-new" });
  });

  it("registered handlers run after the built-ins, in registration order, and duplicates throw", () => {
    const donor = seed("ACME", "2026-09-02");
    const target = seed("ACME", "2026-09-03");
    const order: string[] = [];
    registerEventMergeHandler("b", () => {
      order.push("b");
      return [{ table: "t", moved: 1, merged: 0, deleted: 0, notes: [] }];
    });
    registerEventMergeHandler("c", () => {
      order.push("c");
      return [];
    });
    expect(() => registerEventMergeHandler("b", () => [])).toThrow(/duplicate/);

    const report = db.transaction(() => mergeEarningsEventState(db, donor, target))();

    expect(order).toEqual(["b", "c"]);
    expect(listEventMergeHandlers()).toEqual(["b", "c"]);
    expect(report.handlers.at(-2)).toEqual({
      name: "b",
      tables: [{ table: "t", moved: 1, merged: 0, deleted: 0, notes: [] }],
    });
  });

  it("refuses to run outside a transaction, and a donor === target call is a no-op", () => {
    const donor = seed("ACME", "2026-09-02");
    expect(() => mergeEarningsEventState(db, donor, donor)).toThrow(/transaction/);

    armWorksheet(db, donor);
    const report = db.transaction(() => mergeEarningsEventState(db, donor, donor))();
    expect(report.changed).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_worksheet_flags`).get()).toEqual({ n: 1 });
  });
});
