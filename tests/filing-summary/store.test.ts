/**
 * Filing summary store (migration 099): runs, sections, the claim CAS, filings
 * and push rows, against the migrated in-memory schema. Synthetic data only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  appendSection,
  beginPush,
  claimNextSection,
  createRun,
  finalizeSection,
  getChoice,
  getEventState,
  heartbeatSection,
  insertFiling,
  listEventsWithPendingSections,
  listFilings,
  listRuns,
  listSections,
  markPush,
  markSendingAsUnknown,
  requeueSection,
  setChoice,
  upsertDocument,
  listDocuments,
  upsertEventState,
  type NewFiling,
  type SectionResult,
} from "@/lib/filing-summary/store";

const T0 = Date.parse("2026-10-22T20:30:00.000Z");
const MIN = 60_000;

let db: Database.Database;
let eventId: number;

function seedEvent(symbol: string, key: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('finnhub','earnings','2026-10-22',?,?,?)`,
      )
      .run(`${symbol} earnings`, key, symbol).lastInsertRowid,
  );
}

function filing(accession: string, over: Partial<NewFiling> = {}): NewFiling {
  return {
    eventId,
    accession,
    cik: "0000000001",
    form: "8-K",
    role: "earnings",
    items: "2.02,9.01",
    acceptedAt: "2026-10-22T16:05:00-04:00",
    discoveredAt: "2026-10-22T20:06:00.000Z",
    identityVerdict: "accepted",
    identityReason: null,
    ...over,
  };
}

function result(status: "done" | "failed"): SectionResult {
  return {
    status,
    modelId: "model-x",
    effort: "high",
    inputFingerprint: "fp",
    outputJson: status === "done" ? "{}" : null,
    checkedJson: status === "done" ? "{}" : null,
    coverageJson: "[]",
    incomplete: false,
    countsJson: null,
    usageJson: null,
    versionsJson: null,
    errorClass: status === "failed" ? "model_error" : null,
    errorText: status === "failed" ? "boom" : null,
  };
}

function newRun(filingIds: number[], requestKey: string | null = null) {
  return createRun(db, {
    eventId,
    trigger: "auto",
    choice: { family: "opus", effort: "high" },
    modelId: "model-x",
    fallbackNote: null,
    requestKey,
    bogeySnapshotJson: "[]",
    filingIds,
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = seedEvent("ACME", "acme-1");
});

describe("event state and choice", () => {
  it("defaults the choice and lets it change until a run locks it", () => {
    expect(getEventState(db, eventId)).toBeNull();
    expect(getChoice(db, eventId)).toEqual({
      choice: { family: "opus", effort: "high" },
      isDefault: true,
      locked: false,
    });
    expect(setChoice(db, eventId, { family: "sonnet", effort: "medium" })).toEqual({ ok: true });
    expect(getChoice(db, eventId)).toEqual({
      choice: { family: "sonnet", effort: "medium" },
      isDefault: false,
      locked: false,
    });
  });

  it("upsertEventState creates then patches the row", () => {
    upsertEventState(db, eventId, { pollState: "found", cik: "0000000001" });
    upsertEventState(db, eventId, { catchupDone: true });
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("found");
    expect(s.cik).toBe("0000000001");
    expect(s.catchupDone).toBe(true);
    expect(s.lockedAt).toBeNull();
  });
});

describe("createRun", () => {
  it("is idempotent on request_key, numbers runs, orders sections, and locks the choice", () => {
    const a = insertFiling(db, filing("0000000001-26-000001")).id;
    const b = insertFiling(db, filing("0000000001-26-000002", { role: "companion" })).id;
    const r1 = newRun([b, a], "k1");
    expect(r1.created).toBe(true);
    const again = newRun([a], "k1");
    expect(again).toEqual({ runId: r1.runId, created: false });
    const r2 = newRun([a], "k2");
    expect(r2.created).toBe(true);
    const runs = listRuns(db, eventId);
    expect(runs.map((r) => r.runNo)).toEqual([1, 2]);
    expect(runs[0].status).toBe("running");
    const secs = listSections(db, r1.runId);
    expect(secs.map((s) => [s.seq, s.filingId, s.status])).toEqual([
      [1, b, "pending"],
      [2, a, "pending"],
    ]);
    expect(getChoice(db, eventId).locked).toBe(true);
    expect(setChoice(db, eventId, { family: "fable", effort: "high" })).toEqual({
      ok: false,
      reason: "locked",
    });
    expect(getChoice(db, eventId).choice).toEqual({ family: "opus", effort: "high" });
  });

  it("appendSection adds the next seq once per filing", () => {
    const a = insertFiling(db, filing("A")).id;
    const b = insertFiling(db, filing("B")).id;
    const { runId } = newRun([a]);
    const id = appendSection(db, runId, b);
    expect(id).not.toBeNull();
    expect(appendSection(db, runId, b)).toBeNull();
    expect(listSections(db, runId).map((s) => s.seq)).toEqual([1, 2]);
  });
});

describe("claimNextSection", () => {
  it("refuses while a fresh section of the event runs, takes over a stale one", () => {
    const a = insertFiling(db, filing("A")).id;
    const b = insertFiling(db, filing("B")).id;
    newRun([a, b]);
    const first = claimNextSection(db, eventId, "tok1", T0)!;
    expect(first.seq).toBe(1);
    expect(first.attempts).toBe(1);
    expect(first.status).toBe("running");
    expect(claimNextSection(db, eventId, "tok2", T0 + MIN)).toBeNull();
    expect(heartbeatSection(db, first.id, "tok1", T0 + MIN)).toBe(true);
    expect(heartbeatSection(db, first.id, "nope", T0 + MIN)).toBe(false);
    // Heartbeat at T0+1m; six minutes later it is stale.
    const taken = claimNextSection(db, eventId, "tok2", T0 + 7 * MIN)!;
    expect(taken.id).toBe(first.id);
    expect(taken.attempts).toBe(2);
    expect(taken.claimToken).toBe("tok2");
    expect(listEventsWithPendingSections(db)).toEqual([eventId]);
  });

  it("finalize with a stale token writes nothing", () => {
    const a = insertFiling(db, filing("A")).id;
    const { runId } = newRun([a]);
    const s = claimNextSection(db, eventId, "tok1", T0)!;
    claimNextSection(db, eventId, "tok2", T0 + 6 * MIN);
    expect(finalizeSection(db, s.id, "tok1", result("done"))).toBe(false);
    const row = listSections(db, runId)[0];
    expect(row.checkedJson).toBeNull();
    expect(row.status).toBe("running");
  });

  it("requeue puts the section back to pending with its error", () => {
    const a = insertFiling(db, filing("A")).id;
    const { runId } = newRun([a]);
    const s = claimNextSection(db, eventId, "tok1", T0)!;
    expect(requeueSection(db, s.id, "bad", "timeout", "x")).toBe(false);
    expect(requeueSection(db, s.id, "tok1", "timeout", "slow")).toBe(true);
    const row = listSections(db, runId)[0];
    expect(row.status).toBe("pending");
    expect(row.errorClass).toBe("timeout");
    expect(row.claimToken).toBeNull();
    expect(claimNextSection(db, eventId, "tok2", T0)!.attempts).toBe(2);
  });
});

describe("run status", () => {
  it("one done and one failed makes the run failed", () => {
    const a = insertFiling(db, filing("A")).id;
    const b = insertFiling(db, filing("B")).id;
    const { runId } = newRun([a, b]);
    const s1 = claimNextSection(db, eventId, "t1", T0)!;
    expect(finalizeSection(db, s1.id, "t1", result("done"))).toBe(true);
    expect(listRuns(db, eventId)[0].status).toBe("running");
    const s2 = claimNextSection(db, eventId, "t2", T0)!;
    expect(finalizeSection(db, s2.id, "t2", result("failed"))).toBe(true);
    const run = listRuns(db, eventId)[0];
    expect(run.status).toBe("failed");
    expect(run.finishedAt).not.toBeNull();
    expect(listSections(db, runId)[1].errorClass).toBe("model_error");
    expect(listEventsWithPendingSections(db)).toEqual([]);
  });

  it("all done makes the run done", () => {
    const a = insertFiling(db, filing("A")).id;
    const b = insertFiling(db, filing("B")).id;
    newRun([a, b]);
    for (const t of ["t1", "t2"]) {
      const s = claimNextSection(db, eventId, t, T0)!;
      expect(finalizeSection(db, s.id, t, result("done"))).toBe(true);
    }
    expect(listRuns(db, eventId)[0].status).toBe("done");
    expect(claimNextSection(db, eventId, "t3", T0)).toBeNull();
  });
});

describe("filings and documents", () => {
  it("dedupes on accession and numbers discovery per event", () => {
    const first = insertFiling(db, filing("A"));
    expect(first.inserted).toBe(true);
    expect(insertFiling(db, filing("A"))).toEqual({ id: first.id, inserted: false });
    insertFiling(db, filing("B"));
    const other = seedEvent("BETA", "beta-1");
    insertFiling(db, filing("A", { eventId: other }));
    expect(listFilings(db, eventId).map((f) => [f.accession, f.discoverySeq])).toEqual([
      ["A", 1],
      ["B", 2],
    ]);
    expect(listFilings(db, other).map((f) => f.discoverySeq)).toEqual([1]);
  });

  it("upserts documents by file name and lists them by sequence", () => {
    const f = insertFiling(db, filing("A")).id;
    const d2 = upsertDocument(db, {
      filingId: f, fileName: "ex99.htm", docType: "EX-99.1", sequence: 2,
      status: "fetched", skipReason: null, sha256: "aa", byteLen: 10, storedPath: "/x/ex99.htm",
    });
    upsertDocument(db, {
      filingId: f, fileName: "main.htm", docType: "8-K", sequence: 1,
      status: "skipped", skipReason: "r", sha256: null, byteLen: null, storedPath: null,
    });
    const again = upsertDocument(db, {
      filingId: f, fileName: "ex99.htm", docType: "EX-99.1", sequence: 2,
      status: "failed", skipReason: null, sha256: null, byteLen: null, storedPath: null,
    });
    expect(again).toBe(d2);
    const docs = listDocuments(db, f);
    expect(docs.map((d) => [d.fileName, d.status])).toEqual([
      ["main.htm", "skipped"],
      ["ex99.htm", "failed"],
    ]);
  });
});

describe("push rows", () => {
  it("begins once and sweeps sending to delivery_unknown", () => {
    expect(beginPush(db, "p1", eventId, "ACME", "msg")).toBe(true);
    expect(beginPush(db, "p1", eventId, "ACME", "msg")).toBe(false);
    beginPush(db, "p2", eventId, "ACME", "msg");
    markPush(db, "p1", "sending");
    markPush(db, "p2", "sent");
    expect(markSendingAsUnknown(db)).toBe(1);
    const states = db
      .prepare("SELECT push_key, state FROM filing_summary_pushes ORDER BY push_key")
      .all();
    expect(states).toEqual([
      { push_key: "p1", state: "delivery_unknown" },
      { push_key: "p2", state: "sent" },
    ]);
  });
});

describe("migration 099 retry columns", () => {
  it("stores the awaiting_retry class and maps last_retry_key", () => {
    const f = insertFiling(db, filing("0000000001-26-000031")).id;
    const { runId } = newRun([f]);
    expect(listRuns(db, eventId)[0].lastRetryKey).toBeNull();
    db.prepare("UPDATE filing_summary_runs SET last_retry_key = 'rk' WHERE id = ?").run(runId);
    db.prepare("UPDATE filing_summary_sections SET status = 'failed', error_class = 'awaiting_retry' WHERE run_id = ?").run(runId);
    expect(listRuns(db, eventId)[0].lastRetryKey).toBe("rk");
    expect(listSections(db, runId)[0].errorClass).toBe("awaiting_retry");
    expect(() =>
      db.prepare("UPDATE filing_summary_sections SET error_class = 'waiting' WHERE run_id = ?").run(runId),
    ).toThrow(/CHECK/);
  });
});
