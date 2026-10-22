/**
 * The filing summary's event-merge handler (Hardening 2, R14). Synthetic data
 * on the migrated in-memory schema; the handler runs inside a transaction
 * before the donor event is deleted, as `mergeEarningsEventState` calls it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  mergeFilingSummaryState,
  FILING_SUMMARY_MERGE_HANDLER_NAME,
} from "@/lib/filing-summary/merge";
import {
  beginPush,
  claimNextSection,
  createRun,
  getChoice,
  getEventState,
  insertFiling,
  listDocuments,
  listFilings,
  listRuns,
  listSections,
  setChoice,
  upsertDocument,
  upsertEventState,
} from "@/lib/filing-summary/store";
import {
  listEventMergeHandlers,
  __resetEventMergeHandlersForTests,
} from "@/lib/earnings/event-merge";
import {
  registerFilingSummary,
  __resetFilingSummaryRegisterForTests,
} from "@/lib/filing-summary/register";

const NOW = Date.parse("2026-10-21T20:30:00.000Z");

let db: Database.Database;
let donor: number;
let target: number;

function seedEvent(date: string, key: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('finnhub','earnings',?, 'ACME earnings', ?, 'ACME')`,
      )
      .run(date, key).lastInsertRowid,
  );
}

function addFiling(eventId: number, accession: string, form = "8-K"): number {
  const id = insertFiling(db, {
    eventId,
    accession,
    cik: "0000123456",
    form,
    role: form === "8-K" ? "earnings" : "companion",
    items: null,
    acceptedAt: "2026-10-21T20:05:00.000Z",
    discoveredAt: "2026-10-21T20:06:00.000Z",
    identityVerdict: "accepted",
    identityReason: null,
    fetchState: "fetched",
  }).id;
  upsertDocument(db, {
    filingId: id,
    fileName: "doc.htm",
    docType: form,
    sequence: 1,
    status: "fetched",
    skipReason: null,
    sha256: "a".repeat(64),
    byteLen: 10,
    storedPath: `/tmp/x/${accession}/doc.htm`,
  });
  return id;
}

function addRun(eventId: number, filingIds: number[]): number {
  return createRun(db, {
    eventId,
    trigger: "auto",
    choice: { family: "opus", effort: "high" },
    modelId: null,
    fallbackNote: null,
    requestKey: null,
    bogeySnapshotJson: "{}",
    filingIds,
  }).runId;
}

function merge() {
  return db.transaction(() => mergeFilingSummaryState({ db, donorEventId: donor, targetEventId: target }))();
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  donor = seedEvent("2026-10-20", "fs-merge-donor");
  target = seedEvent("2026-10-21", "fs-merge-target");
});

describe("mergeFilingSummaryState", () => {
  it("Review Focus 5: shared accession folds into one filing; the running donor section is re-pointed and released; run numbers stay unique", () => {
    const targetFiling = addFiling(target, "0000123456-26-000101");
    const targetRun = addRun(target, [targetFiling]);
    const donorFiling = addFiling(donor, "0000123456-26-000101");
    const donorCompanion = addFiling(donor, "0000123456-26-000102", "PRE 14C");
    const donorRun1 = addRun(donor, [donorFiling]);
    const donorRun2 = addRun(donor, [donorFiling, donorCompanion]);
    const claimed = claimNextSection(db, donor, "donor-token", NOW);
    expect(claimed?.runId).toBe(donorRun1);

    const report = merge();
    db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(donor);

    const filings = listFilings(db, target);
    expect(filings.map((f) => f.accession)).toEqual(["0000123456-26-000101", "0000123456-26-000102"]);
    expect(filings[0].id).toBe(targetFiling);
    expect(new Set(filings.map((f) => f.discoverySeq)).size).toBe(2);
    expect(listDocuments(db, targetFiling)).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM filing_summary_filings WHERE id = ?`).get(donorFiling)).toEqual({ n: 0 });

    const runs = listRuns(db, target);
    expect(runs.map((r) => [r.id, r.runNo])).toEqual([
      [targetRun, 1],
      [donorRun1, 2],
      [donorRun2, 3],
    ]);
    const [s1] = listSections(db, donorRun1);
    expect(s1).toMatchObject({ filingId: targetFiling, status: "pending", claimToken: null, heartbeatAt: null });
    expect(listSections(db, donorRun2).map((s) => s.filingId)).toEqual([targetFiling, donorCompanion]);

    // The old worker's finalize cannot land: its claim is gone.
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM filing_summary_sections WHERE claim_token = 'donor-token'`)
        .get(),
    ).toEqual({ n: 0 });

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const byTable = Object.fromEntries(report.map((t) => [t.table, t]));
    expect(byTable.filing_summary_filings).toMatchObject({ moved: 1, merged: 1, deleted: 1 });
    expect(byTable.filing_summary_runs.moved).toBe(2);
    expect(byTable.filing_summary_sections.merged).toBe(1);
  });

  it("event row: the donor's moves when the target has none", () => {
    setChoice(db, donor, { family: "fable", effort: "medium" });
    upsertEventState(db, donor, { pollState: "found", cik: "0000123456" });
    merge();
    expect(getEventState(db, donor)).toBeNull();
    expect(getEventState(db, target)).toMatchObject({ pollState: "found", family: "fable", effort: "medium" });
  });

  it("event row: a locked donor choice wins over an unlocked target; the target keeps its poll state", () => {
    setChoice(db, donor, { family: "sonnet", effort: "medium" });
    addRun(donor, [addFiling(donor, "0000123456-26-000101")]); // locks the donor
    setChoice(db, target, { family: "fable", effort: "high" });
    upsertEventState(db, target, { pollState: "waiting" });
    merge();
    const c = getChoice(db, target);
    expect(c.choice).toEqual({ family: "sonnet", effort: "medium" });
    expect(c.locked).toBe(true);
    expect(getEventState(db, target)!.pollState).toBe("waiting");
    expect(getEventState(db, donor)).toBeNull();
  });

  it("event row: both locked → the target's choice stands", () => {
    setChoice(db, donor, { family: "sonnet", effort: "medium" });
    addRun(donor, [addFiling(donor, "0000123456-26-000101")]);
    setChoice(db, target, { family: "fable", effort: "high" });
    addRun(target, [addFiling(target, "0000123456-26-000201")]);
    merge();
    expect(getChoice(db, target).choice).toEqual({ family: "fable", effort: "high" });
  });

  it("pushes move to the target", () => {
    beginPush(db, "push-1", donor, "title", "message");
    merge();
    expect(
      db.prepare(`SELECT event_id FROM filing_summary_pushes WHERE push_key = 'push-1'`).get(),
    ).toEqual({ event_id: target });
  });

  it("is registered under its name by registerFilingSummary (once)", () => {
    __resetEventMergeHandlersForTests();
    __resetFilingSummaryRegisterForTests();
    registerFilingSummary();
    registerFilingSummary();
    expect(listEventMergeHandlers()).toEqual([FILING_SUMMARY_MERGE_HANDLER_NAME]);
  });
});
