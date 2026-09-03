/**
 * Slice B Task 13 — the print-watch event-merge handler.
 *
 * `mergePrintWatchState` runs INSIDE slice A's `mergeEarningsEventState`,
 * inside the calendar transaction, BEFORE the donor `calendar_events` row is
 * deleted. Everything asserted here is therefore SQL-only and synchronous.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import {
  upsertPrint,
  upsertLines,
  getSheet,
  getPrintByEventId,
  listDocuments,
  listDocumentRoads,
  listIrSeenLinks,
  recordIrSeenLinks,
  markLineAccepted,
  getDocument,
} from "@/lib/print-watch/store";
import { recordDelivery } from "@/lib/print-watch/delivery";
import { gateFingerprint } from "@/lib/print-watch/gate";
import { mergePrintWatchState } from "@/lib/print-watch/merge-handler";
import type { PrintWatchLine, TaggedCandidate, LineContract } from "@/lib/print-watch/types";

let db: Database.Database;
let tmp: string;

function event(db: Database.Database, date: string, key: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol) VALUES ('finnhub','earnings',?, 'ACME', ?, 'ACME')`,
      )
      .run(date, key).lastInsertRowid,
  );
}
function contract(metric: string): LineContract {
  return {
    metric_id: metric,
    label: metric,
    definition: "t",
    basis: "gaap",
    period: "Q",
    currency: "USD",
    unit: "usd",
    kind: "point",
    segment: null,
  };
}
function cand(metric: string, value: number, docId: number): TaggedCandidate {
  return {
    metric_id: metric,
    value,
    value_high: null,
    raw_text: String(value),
    snippet: `${metric} ${value}`,
    location_hint: null,
    not_disclosed: false,
    doc_id: docId,
    representation: "repB",
    weak_pair: false,
  };
}
function line(
  metric: string,
  state: PrintWatchLine["state"],
  value: number | null,
  docId: number | null,
  cands: TaggedCandidate[],
): PrintWatchLine {
  return {
    metric_id: metric,
    contract: contract(metric),
    expected: null,
    state,
    value,
    value_high: null,
    snippet: value === null ? null : `${metric} ${value}`,
    source_doc_id: docId,
    candidates_json: JSON.stringify(cands),
  };
}
function deliver(
  printId: number,
  kind: "edgar-ex99" | "user-drop" | "ir-page",
  text: string,
  eventDate: string,
) {
  const bytes = Buffer.from(text);
  const p = path.join(tmp, `${printId}-${kind}.txt`);
  fs.writeFileSync(p, bytes);
  return recordDelivery(db, printId, kind, `${kind}:x`, null, bytes, {
    bytesPath: p,
    text,
    gateCtx: { symbol: "ACME", issuerName: null, eventDate },
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("mergePrintWatchState", () => {
  it("re-homes the donor print when the target has none, and unions IR-seen rows", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const printId = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    recordIrSeenLinks(db, donor, ["https://ir.x/a"], true);
    const out = db.transaction(() =>
      mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }),
    )();
    expect(getPrintByEventId(db, target)?.id).toBe(printId);
    expect(getPrintByEventId(db, donor)).toBeNull();
    expect(listIrSeenLinks(db, target)).toEqual([{ link: "https://ir.x/a", baseline: true }]);
    expect(out.find((r) => r.table === "print_watch_prints")).toMatchObject({ moved: 1 });
  });

  it("merges two prints: same-hash documents collapse with roads unioned, distinct ones move, lines merge losslessly, donor print deleted LAST", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2026-08-27", "16:05");
    const same = "ACME reports Q3 2026 results. Revenue $1,000 million.";
    const tDoc = deliver(tp, "edgar-ex99", same, "2026-08-27");
    const dDoc = deliver(dp, "user-drop", same, "2026-08-26");
    const dOnly = deliver(dp, "ir-page", "ACME reports Q3 2026 results. EPS $1.00.", "2026-08-26");
    upsertLines(db, tp, [
      line("revenue_q", "single_source", 1000, tDoc.id, [cand("revenue_q", 1000, tDoc.id)]),
    ]);
    upsertLines(db, dp, [
      line("revenue_q", "single_source", 1000, dDoc.id, [cand("revenue_q", 1000, dDoc.id)]),
      line("eps_gaap_q", "single_source", 1, dOnly.id, [cand("eps_gaap_q", 1, dOnly.id)]),
    ]);
    const out = db.transaction(() =>
      mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }),
    )();

    expect(getPrintByEventId(db, donor)).toBeNull();
    const docs = listDocuments(db, tp);
    expect(docs.map((d) => d.id).sort()).toEqual([tDoc.id, dOnly.id].sort());
    expect(
      listDocumentRoads(db, tp)
        .filter((r) => r.document_id === tDoc.id)
        .map((r) => r.kind)
        .sort(),
    ).toEqual(["edgar-ex99", "user-drop"]);
    const sheet = getSheet(db, tp);
    const rev = sheet.find((l) => l.metric_id === "revenue_q")!;
    expect(rev.state).toBe("single_source"); // the donor's candidate came from the SAME bytes → archived, not doubled
    expect((JSON.parse(rev.candidates_json) as TaggedCandidate[]).map((c) => c.doc_id)).toEqual([
      tDoc.id,
    ]);
    const eps = sheet.find((l) => l.metric_id === "eps_gaap_q")!;
    expect(eps).toMatchObject({ state: "single_source", value: 1, source_doc_id: dOnly.id });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM print_watch_candidate_archive").get() as { n: number })
        .n,
    ).toBe(1);
    expect(out.map((r) => r.table)).toEqual(
      expect.arrayContaining(["print_watch_documents", "print_watch_lines", "print_watch_prints"]),
    );
  });

  it("two differing acceptances become a conflict with BOTH preserved in audit_json; a single-side acceptance carries over", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2026-08-27", "16:05");
    const tDoc = deliver(
      tp,
      "edgar-ex99",
      "ACME reports Q3 2026 results. Revenue $1,000 million.",
      "2026-08-27",
    );
    const dDoc = deliver(
      dp,
      "user-drop",
      "ACME reports Q3 2026 results. Revenue $1,100 million.",
      "2026-08-26",
    );
    upsertLines(db, tp, [
      line("revenue_q", "single_source", 1000, tDoc.id, [cand("revenue_q", 1000, tDoc.id)]),
      line("eps_gaap_q", "pending", null, null, []),
    ]);
    upsertLines(db, dp, [
      line("revenue_q", "single_source", 1100, dDoc.id, [cand("revenue_q", 1100, dDoc.id)]),
      line("eps_gaap_q", "single_source", 2, dDoc.id, [cand("eps_gaap_q", 2, dDoc.id)]),
    ]);
    markLineAccepted(db, tp, "revenue_q");
    markLineAccepted(db, dp, "revenue_q");
    markLineAccepted(db, dp, "eps_gaap_q");
    db.transaction(() =>
      mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }),
    )();
    const sheet = getSheet(db, tp);
    const rev = sheet.find((l) => l.metric_id === "revenue_q")!;
    expect(rev.state).toBe("conflict");
    const audit = JSON.parse(rev.audit_json ?? "{}") as {
      acceptances: Array<{ event_id: number; value: number }>;
    };
    expect(audit.acceptances.map((a) => a.value).sort()).toEqual([1000, 1100]);
    const eps = sheet.find((l) => l.metric_id === "eps_gaap_q")!;
    expect(eps).toMatchObject({ state: "accepted", value: 2 });
  });

  it("is a no-op with an empty result when neither event has a print", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    expect(
      db.transaction(() =>
        mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }),
      )(),
    ).toEqual([]);
  });

  it("re-home carries the target's symbol, date, and release time (Codex #3)", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, release_time) VALUES ('finnhub','earnings','2026-08-27','ACME','t','ACME','16:30')`,
        )
        .run().lastInsertRowid,
    );
    upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    db.transaction(() =>
      mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }),
    )();
    expect(getPrintByEventId(db, target)).toMatchObject({
      symbol: "ACME",
      event_date: "2026-08-27",
      release_time_et: "16:30",
    });
  });

  it("a moved line whose candidates were archived is re-reconciled, and existing audit trails union (Codex #3)", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2026-08-27", "16:05");
    const same = "ACME reports Q3 2026 results. Revenue $1,000 million.";
    const tDoc = deliver(tp, "edgar-ex99", same, "2026-08-27");
    const dDoc = deliver(dp, "user-drop", same, "2026-08-26");
    // Only the donor has an eps line, and its only evidence comes from the duplicate document.
    upsertLines(db, dp, [
      line("eps_gaap_q", "single_source", 1, dDoc.id, [cand("eps_gaap_q", 1, dDoc.id)]),
    ]);
    upsertLines(db, tp, [
      {
        ...line("revenue_q", "single_source", 1000, tDoc.id, [cand("revenue_q", 1000, tDoc.id)]),
        audit_json: JSON.stringify({ acceptances: [{ event_id: 1, value: 999 }] }),
      },
    ]);
    upsertLines(db, dp, [
      {
        ...line("revenue_q", "single_source", 1000, dDoc.id, [cand("revenue_q", 1000, dDoc.id)]),
        audit_json: JSON.stringify({ acceptances: [{ event_id: 2, value: 998 }] }),
      },
    ]);
    expect(() =>
      db.transaction(() =>
        mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }),
      )(),
    ).not.toThrow(); // foreign keys ON: twins deleted AFTER remap (Codex #1)
    const sheet = getSheet(db, tp);
    const eps = sheet.find((l) => l.metric_id === "eps_gaap_q")!;
    expect(eps).toMatchObject({ state: "single_source", value: 1, source_doc_id: tDoc.id }); // remapped, not orphaned
    expect((JSON.parse(eps.candidates_json) as TaggedCandidate[]).map((c) => c.doc_id)).toEqual([
      tDoc.id,
    ]);
    const rev = sheet.find((l) => l.metric_id === "revenue_q")!;
    expect(
      (JSON.parse(rev.audit_json!) as { acceptances: Array<{ value: number }> }).acceptances
        .map((a) => a.value)
        .sort(),
    ).toEqual([998, 999]);
  });
  it("M7: an unreadable donor candidates_json moves VERBATIM, its raw text is archived, and the line is never re-reconciled", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2026-08-27", "16:05");
    upsertLines(db, dp, [line("eps_gaap_q", "single_source", 7, null, [])]);
    db.prepare(
      `UPDATE print_watch_lines SET candidates_json = '{not json' WHERE print_id = ? AND metric_id = 'eps_gaap_q'`,
    ).run(dp);
    db.transaction(() =>
      mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }),
    )();
    const eps = getSheet(db, tp).find((l) => l.metric_id === "eps_gaap_q")!;
    expect(eps.candidates_json).toBe("{not json"); // never rewritten as []
    expect(eps).toMatchObject({ state: "single_source", value: 7 }); // never recomputed off an empty pool
    expect(
      db
        .prepare(`SELECT candidate_json, reason FROM print_watch_candidate_archive WHERE print_id = ?`)
        .all(tp),
    ).toEqual([{ candidate_json: "{not json", reason: "unparseable-json" }]);
  });

  it("M7: an unreadable TARGET candidates_json is left alone — the donor's evidence is archived, not merged into it", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2026-08-27", "16:05");
    const tDoc = deliver(
      tp,
      "edgar-ex99",
      "ACME reports Q3 2026 results. Revenue $1,000 million.",
      "2026-08-27",
    );
    const dDoc = deliver(dp, "ir-page", "ACME reports Q3 2026 results. EPS $1.00.", "2026-08-26");
    upsertLines(db, tp, [
      line("revenue_q", "single_source", 1000, tDoc.id, [cand("revenue_q", 1000, tDoc.id)]),
    ]);
    db.prepare(
      `UPDATE print_watch_lines SET candidates_json = 'garbage' WHERE print_id = ? AND metric_id = 'revenue_q'`,
    ).run(tp);
    upsertLines(db, dp, [
      line("revenue_q", "single_source", 1100, dDoc.id, [cand("revenue_q", 1100, dDoc.id)]),
    ]);
    db.transaction(() =>
      mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }),
    )();
    const rev = getSheet(db, tp).find((l) => l.metric_id === "revenue_q")!;
    expect(rev.candidates_json).toBe("garbage");
    expect(rev).toMatchObject({ state: "single_source", value: 1000 }); // reading left alone
    expect(
      db
        .prepare(`SELECT reason FROM print_watch_candidate_archive WHERE print_id = ?`)
        .all(tp),
    ).toEqual([{ reason: "target-candidates-unreadable" }]);
  });

  it("re-home re-judges every document against the TARGET identity; bytes gone is a durable rejection, never a throw (M7)", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const kept = deliver(
      dp,
      "edgar-ex99",
      "ACME reports Q3 2026 results. Revenue $1,000 million.",
      "2026-08-26",
    );
    const lost = deliver(dp, "ir-page", "ACME reports Q3 2026 results. EPS $1.00.", "2026-08-26");
    expect(getDocument(db, kept.id)?.gate_verdict).toBe("accepted");
    fs.rmSync(path.join(tmp, `${dp}-ir-page.txt`));

    expect(() =>
      db.transaction(() =>
        mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }),
      )(),
    ).not.toThrow();

    // the surviving document is re-fingerprinted for the target event's date
    expect(getDocument(db, kept.id)).toMatchObject({
      gate_verdict: "accepted",
      gate_fingerprint: gateFingerprint({
        symbol: "ACME",
        issuerName: null,
        eventDate: "2026-08-27",
      }),
    });
    expect(getDocument(db, lost.id)).toMatchObject({
      gate_verdict: "rejected",
      gate_reason: "bytes missing on disk",
      gate_fingerprint: null,
    });
  });
});
