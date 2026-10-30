/**
 * QA finding 2026-10-30: a failed filing summary gave no reason, and the
 * "Filings found" list said a filing the failed run DID read was "not read yet".
 *
 * - The failed-section words carry the last failure's reason when the class
 *   is attempt_cap and the stored text is a known class token; any other
 *   stored text is never printed.
 * - "read" in the filing list comes from the run's coverage, not only from a
 *   done section.
 * Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { createRun, insertFiling, type NewFiling } from "@/lib/filing-summary/store";
import { getFullView, getPanelViews, type PanelView, type RunSummary } from "@/lib/filing-summary/view";
import { errorWords, sectionErrorSentence } from "@/lib/filing-summary/labels";
import { renderSharePage } from "@/lib/filing-summary/share-page";
import { pollStateText, sectionNotes } from "@/app/dashboard/today/filing-summary-text";
import { filingLine, filingsReadInRun } from "@/app/dashboard/print/[eventId]/filings/page-text";

describe("attempt_cap carries the last failure's reason", () => {
  it("names the reason for a known token", () => {
    expect(sectionErrorSentence("attempt_cap", "model_error")).toBe(
      "Not summarised: both attempts failed — the model call failed.",
    );
    expect(sectionErrorSentence("attempt_cap", "timeout")).toBe(
      "Not summarised: both attempts failed — the model call timed out.",
    );
    expect(sectionErrorSentence("attempt_cap", "takeover")).toBe(
      "Not summarised: both attempts failed — the attempt was interrupted.",
    );
    expect(errorWords("attempt_cap", "model_error")).toBe("both attempts failed — the model call failed");
    expect(errorWords("attempt_cap", "truncated")).toBe("both attempts failed — the answer was cut off at the length limit");
  });

  it("never prints arbitrary stored text, nor a token that is not a failure reason", () => {
    expect(sectionErrorSentence("attempt_cap", "HTTP 500 from upstream 12345")).toBe("Not summarised: both attempts failed.");
    expect(sectionErrorSentence("attempt_cap", null)).toBe("Not summarised: both attempts failed.");
    expect(sectionErrorSentence("attempt_cap", "attempt_cap")).toBe("Not summarised: both attempts failed.");
    expect(sectionErrorSentence("attempt_cap", "awaiting_retry")).toBe("Not summarised: both attempts failed.");
    expect(sectionErrorSentence("attempt_cap", "toString")).toBe("Not summarised: both attempts failed.");
    expect(errorWords("attempt_cap", "secret words")).toBe("both attempts failed");
  });

  it("only attempt_cap reads the stored text", () => {
    expect(sectionErrorSentence("timeout", "model_error")).toBe("Not summarised: the model call timed out.");
    expect(errorWords("refusal", "timeout")).toBe("the model declined to answer");
    expect(sectionErrorSentence("attempt_cap")).toBe("Not summarised: both attempts failed.");
  });
});

// ---------------------------------------------------------------- DB-backed views

const CATALOG = ["claude-opus-5-5", "claude-sonnet-5-5"];
let db: Database.Database;
let eventId: number;

function filing(accession: string, over: Partial<NewFiling> = {}): NewFiling {
  return {
    eventId,
    accession,
    cik: "0000000001",
    form: "6-K",
    role: "earnings",
    items: null,
    acceptedAt: "2026-10-22T20:05:00.000Z",
    discoveredAt: "2026-10-22T20:06:00.000Z",
    identityVerdict: "accepted",
    identityReason: null,
    fetchState: "fetched",
    ...over,
  };
}

const READ_COVERAGE = JSON.stringify([
  { fileName: "aaa-6k.htm", docType: "6-K", status: "read", reason: null },
  { fileName: "aaa-ex991.htm", docType: "EX-99.1", status: "read", reason: null },
]);

let readFiling: number;
let unreadFiling: number;
let outsideFiling: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('finnhub','earnings','2026-10-22','AAA earnings','k:AAA','AAA')`,
      )
      .run().lastInsertRowid,
  );
  readFiling = insertFiling(db, filing("0000000001-26-000001")).id;
  unreadFiling = insertFiling(db, filing("0000000001-26-000002", { role: "companion" })).id;
  outsideFiling = insertFiling(db, filing("0000000001-26-000003", { role: "companion" })).id;
  const runId = createRun(db, {
    eventId,
    trigger: "auto",
    choice: { family: "opus", effort: "high" },
    modelId: "claude-opus-5-5",
    fallbackNote: null,
    requestKey: null,
    bogeySnapshotJson: "[]",
    filingIds: [readFiling, unreadFiling],
  }).runId;
  db.prepare(
    `UPDATE filing_summary_sections SET status='failed', error_class='attempt_cap', error_text='model_error',
       coverage_json=?, attempts=2, finished_at=datetime('now')
     WHERE run_id=? AND seq=1`,
  ).run(READ_COVERAGE, runId);
  db.prepare(
    `UPDATE filing_summary_sections SET status='failed', error_class='cancelled', error_text='run failed before this section'
     WHERE run_id=? AND seq=2`,
  ).run(runId);
  db.prepare("UPDATE filing_summary_runs SET status='failed', finished_at=datetime('now') WHERE id=?").run(runId);
});

describe("the panel names what failed twice", () => {
  it("carries the stored token to the panel's section states and says it", () => {
    const v = getPanelViews(db, [eventId], CATALOG)[eventId] as PanelView;
    const shown = v.shown as RunSummary;
    expect(shown.status).toBe("failed");
    expect(shown.sectionStates[0].errorText).toBe("model_error");
    expect(pollStateText(v)).toBe("Summary failed — both attempts failed — the model call failed");
    expect(sectionNotes(shown)[0]).toContain("failed — both attempts failed — the model call failed");
  });
});

describe("the full page and the share page", () => {
  it("says the reason on the share page and never the raw text", () => {
    const full = getFullView(db, eventId, CATALOG)!;
    const html = renderSharePage(full, full.runs[full.runs.length - 1].runId);
    expect(html).toContain("Not summarised: both attempts failed — the model call failed.");
    expect(html).not.toContain("run failed before this section");
  });

  it("a filing the failed run read shows read; one it never fetched stays not read yet", () => {
    const full = getFullView(db, eventId, CATALOG)!;
    const run = full.runs[full.runs.length - 1];
    const read = filingsReadInRun(run);
    expect(read.has(readFiling)).toBe(true);
    expect(read.has(unreadFiling)).toBe(false);
    expect(read.has(outsideFiling)).toBe(false);
    const byId = new Map(full.filings.map((f) => [f.filingId, f]));
    expect(filingLine(byId.get(readFiling)!, read.has(readFiling))).toMatch(/· read$/);
    expect(filingLine(byId.get(unreadFiling)!, read.has(unreadFiling))).not.toMatch(/· read$/);
    expect(filingsReadInRun(null).size).toBe(0);
  });
});
