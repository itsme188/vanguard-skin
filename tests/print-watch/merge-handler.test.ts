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
function cand(
  metric: string,
  value: number,
  docId: number,
  representation: TaggedCandidate["representation"] = "repB",
): TaggedCandidate {
  return {
    metric_id: metric,
    value,
    value_high: null,
    raw_text: String(value),
    snippet: `${metric} ${value}`,
    location_hint: null,
    not_disclosed: false,
    doc_id: docId,
    representation,
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

  // Controller ruling R-B7b. The donor's line carried v1's MEASURED PAIR of
  // ONE document (repA tables + repB raw text) and the surviving twin has no
  // candidate of its own on that metric. Keyed on doc_id alone one reading
  // would be archived and a legitimate `agreed` would drop to `single_source`
  // on every date-correction merge; keyed on (document, representation) both
  // survive, remapped onto the twin.
  it("R-B7b: a merged twin's repA/repB pair both survive when the surviving document has no candidate on that line", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2026-08-27", "16:05");
    const same = "ACME reports Q3 2026 results. Revenue $1,000 million.";
    const tDoc = deliver(tp, "edgar-ex99", same, "2026-08-27");
    const dDoc = deliver(dp, "user-drop", same, "2026-08-26");
    // The target print has no revenue line at all; the donor's is the pair.
    upsertLines(db, dp, [
      line("revenue_q", "agreed", 1000, dDoc.id, [
        cand("revenue_q", 1000, dDoc.id, "repA"),
        cand("revenue_q", 1000, dDoc.id, "repB"),
      ]),
    ]);
    db.transaction(() => mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }))();

    const rev = getSheet(db, tp).find((l) => l.metric_id === "revenue_q")!;
    expect(rev.state).toBe("agreed");
    expect(
      (JSON.parse(rev.candidates_json) as TaggedCandidate[]).map((c) => [c.doc_id, c.representation]),
    ).toEqual([
      [tDoc.id, "repA"],
      [tDoc.id, "repB"],
    ]);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM print_watch_candidate_archive").get() as { n: number }).n,
    ).toBe(0);
  });

  // The other half of R-B7b: the SAME reading of the same bytes down two roads
  // is one measurement counted twice — archived with its provenance, and the
  // line falls back to what one source can honestly support.
  it("R-B7b: the twin's repA is archived when the surviving document already carries a repA on that line", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2026-08-27", "16:05");
    const same = "ACME reports Q3 2026 results. Revenue $1,000 million.";
    const tDoc = deliver(tp, "edgar-ex99", same, "2026-08-27");
    const dDoc = deliver(dp, "user-drop", same, "2026-08-26");
    upsertLines(db, tp, [
      line("revenue_q", "single_source", 1000, tDoc.id, [cand("revenue_q", 1000, tDoc.id, "repA")]),
    ]);
    upsertLines(db, dp, [
      line("revenue_q", "single_source", 1000, dDoc.id, [cand("revenue_q", 1000, dDoc.id, "repA")]),
    ]);
    db.transaction(() => mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }))();

    const rev = getSheet(db, tp).find((l) => l.metric_id === "revenue_q")!;
    expect(rev.state).toBe("single_source");
    expect(
      (JSON.parse(rev.candidates_json) as TaggedCandidate[]).map((c) => [c.doc_id, c.representation]),
    ).toEqual([[tDoc.id, "repA"]]);
    const archived = db
      .prepare("SELECT print_id, metric_id, reason, candidate_json FROM print_watch_candidate_archive")
      .all() as Array<{ print_id: number; metric_id: string; reason: string; candidate_json: string }>;
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ print_id: tp, metric_id: "revenue_q", reason: `duplicate-of:${tDoc.id}` });
    expect(JSON.parse(archived[0].candidate_json) as TaggedCandidate).toMatchObject({
      doc_id: dDoc.id,
      representation: "repA",
    });
  });

  // Whole-branch review, Important 2. The gate's ROAD verdict for an `ir-page`
  // document is decided against the event DATE: a newsroom post that named
  // tonight's quarter for the donor names last quarter's for the target. The
  // content verdict is generous enough to survive that move (symbol + any
  // fiscal-year/quarter pairing), so retracting only on a content flip left
  // the evidence green on the sheet under a road nothing trusts any more.
  it("retracts an ir-page document's evidence when the road verdict — not the content verdict — flips against the target date", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2027-02-10", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2027-02-10", "16:05");
    // Names Q3 2026 (the donor's quarter, so the ir-page road accepts it) and
    // carries a generic fiscal-year + quarter pairing, which is all the CONTENT
    // gate needs for the target's Q1 2027 / Q4 2026 window.
    const text =
      "ACME reports Q3 2026 results for fiscal year 2026. Revenue $1,000 million.";
    const dDoc = deliver(dp, "ir-page", text, "2026-08-26");
    expect(dDoc.eligible).toBe(true);
    deliver(tp, "edgar-ex99", "ACME reports Q1 2027 results. Revenue $2,000 million.", "2027-02-10");
    upsertLines(db, dp, [
      line("revenue_q", "single_source", 1000, dDoc.id, [cand("revenue_q", 1000, dDoc.id)]),
    ]);
    db.transaction(() => mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }))();

    // The document survives, its content still accepted — only the road fell.
    const moved = getDocument(db, dDoc.id)!;
    expect(moved.print_id).toBe(tp);
    expect(moved.gate_verdict).toBe("accepted");
    expect(
      listDocumentRoads(db, tp)
        .filter((r) => r.document_id === dDoc.id)
        .map((r) => r.road_verdict),
    ).toEqual(["rejected"]);

    const rev = getSheet(db, tp).find((l) => l.metric_id === "revenue_q")!;
    expect(rev).toMatchObject({ state: "pending", value: null, source_doc_id: null });
    expect(JSON.parse(rev.candidates_json)).toEqual([]);
    const archived = db
      .prepare("SELECT print_id, metric_id, reason FROM print_watch_candidate_archive")
      .all() as Array<{ print_id: number; metric_id: string; reason: string }>;
    expect(archived).toEqual([{ print_id: tp, metric_id: "revenue_q", reason: "road-rejected" }]);
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
  it("a minted conflict SURVIVES the document re-verdict: a donor doc that flips to rejected must not recompute two acceptances into one number", () => {
    // The donor event sits in a different quarter, so its release text names a
    // period the TARGET event's gate refuses — the classic accepted→rejected
    // flip a date correction produces.
    const donor = event(db, "2026-02-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-02-26", "16:05");
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
      "ACME reports Q1 2026 results. Revenue $1,100 million.",
      "2026-02-26",
    );
    expect(getDocument(db, dDoc.id)?.gate_verdict).toBe("accepted"); // accepted for the DONOR's date
    upsertLines(db, tp, [
      line("revenue_q", "single_source", 1000, tDoc.id, [cand("revenue_q", 1000, tDoc.id)]),
    ]);
    upsertLines(db, dp, [
      line("revenue_q", "single_source", 1100, dDoc.id, [cand("revenue_q", 1100, dDoc.id)]),
    ]);
    markLineAccepted(db, tp, "revenue_q");
    markLineAccepted(db, dp, "revenue_q");

    db.transaction(() =>
      mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }),
    )();

    // the moved document really did lose its acceptance for the target event
    expect(getDocument(db, dDoc.id)?.gate_verdict).toBe("rejected");
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM print_watch_candidate_archive WHERE reason = 'gate-rejected'`)
        .get(),
    ).toEqual({ n: 1 });

    const rev = getSheet(db, tp).find((l) => l.metric_id === "revenue_q")!;
    expect(rev.state).toBe("conflict"); // NOT recomputed to single_source off the surviving pool
    expect(rev.value).toBeNull(); // never "one verified number" where two humans disagreed
    const audit = JSON.parse(rev.audit_json ?? "{}") as {
      acceptances: Array<{ value: number }>;
    };
    expect(audit.acceptances.map((a) => a.value).sort()).toEqual([1000, 1100]);
  });

  it("archived candidates follow the surviving print — the donor's rows are never stranded behind a deleted print id", () => {
    const donor = event(db, "2026-08-26", "d");
    const target = event(db, "2026-08-27", "t");
    const dp = upsertPrint(db, donor, "ACME", "2026-08-26", "16:05");
    const tp = upsertPrint(db, target, "ACME", "2026-08-27", "16:05");
    // An archive row that predates this merge (print_watch_candidate_archive
    // carries no FK, so nothing would stop it being orphaned).
    db.prepare(
      `INSERT INTO print_watch_candidate_archive (print_id, metric_id, candidate_json, reason) VALUES (?, 'eps_gaap_q', '{"value":3}', 'bytes-missing')`,
    ).run(dp);

    const out = db.transaction(() =>
      mergePrintWatchState({ db, donorEventId: donor, targetEventId: target }),
    )();

    expect(getPrintByEventId(db, donor)).toBeNull();
    expect(
      db
        .prepare(`SELECT print_id, reason FROM print_watch_candidate_archive`)
        .all(),
    ).toEqual([{ print_id: tp, reason: "bytes-missing" }]);
    expect(out.find((r) => r.table === "print_watch_candidate_archive")).toMatchObject({ moved: 1 });
  });
});
