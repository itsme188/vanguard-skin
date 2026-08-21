/**
 * Task 13 — Replay tests (synthetic committed + real-corpus guarded).
 *
 * Two suites, per task-13-brief.md:
 *
 *  1. ALWAYS-RUN synthetic replay: seeds an armed event + bogeys, compiles
 *     contracts, ingests the committed `synthetic-release.html` fixture (a
 *     fictional "Synthex Corp" / SYNX quarterly release — no real company
 *     data) through the production `ingestDocument` pipeline with a
 *     hand-written, marker-keyed `extractCandidates` seam standing in for
 *     the model call. Walks the whole lifecycle: lines reaching `agreed`
 *     and `blank` correctly, accept + `promoteHeadline` writing
 *     `calendar_events.actual_value` as "EPS X.XX · Rev N", a MODIFIED
 *     follow-up document producing a fresh independent agreement that
 *     diverges from an already-accepted line's locked value (the same
 *     candidates_json divergence app/dashboard/today/PrintWatchPanel.tsx's
 *     `needsReverify` renders as "superseded — re-verify" — verified here
 *     directly against `lib/print-watch/reconcile.ts` rather than importing
 *     that concurrently-edited panel module), unaccept via the accept
 *     route, and re-accept (and re-promote) the corrected value. A separate
 *     restart-after-insert drill proves a document inserted directly via
 *     the store (bypassing `ingestDocument`'s gate — simulating a process
 *     that acquired bytes and crashed before parsing) gets drained by the
 *     next watcher tick, per Codex #6's crash-recovery guarantee.
 *
 *  2. GUARDED real-corpus replay: the CRWD-2026-06-03 bake-off pilot
 *     artifacts (gitignored; existsSync-guarded so this suite skips
 *     cleanly on a checkout without the real corpus) — recorded
 *     parse-repA.json / parse-repB.json candidates fed through the SAME
 *     extractCandidates seam, keyed by the exact repA/repB representation
 *     text, asserting the pilot's agreed metrics (eps_gaap_q, eps_adj_q,
 *     revenue_q) come out green through the real `ingestDocument` +
 *     `reconcile` production path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { runMigrations } from "@/lib/db/migrate";
import {
  getPrintByEventId,
  getSheet,
  listDocuments,
  listUnparsedDocuments,
  insertDocument,
  upsertLines,
} from "@/lib/print-watch/store";
import { ensurePrintWatch, ingestDocument, _setTestSeams } from "@/lib/print-watch/watcher";
import type { WatcherSeams } from "@/lib/print-watch/watcher";
import { compileContracts } from "@/lib/print-watch/contracts";
import { reconcile } from "@/lib/print-watch/reconcile";
import { htmlToTablesRepresentation, htmlToRawText } from "@/lib/print-watch/representations";
import type { LineContract, ParseCandidate, TaggedCandidate } from "@/lib/print-watch/types";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

// ---------------------------------------------------------------------------
// shared harness (mirrors the seam-mocking pattern in
// tests/print-watch/watcher.test.ts and the route-invocation pattern in
// tests/api/print-watch-accept.test.ts)
// ---------------------------------------------------------------------------

let db: Database.Database;
let tmpRoot: string;
let extractImpl: (contracts: LineContract[], text: string) => Promise<ParseCandidate[]> = async () => [];

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Real-timer poll (the watcher loop below runs on REAL, capped-length
 *  sleeps — see installSeams — never fake timers), bounded so a stuck
 *  drain fails fast instead of hanging the suite. */
async function waitUntil(check: () => boolean, timeoutMs = 3000, stepMs = 15): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Installs every watcher seam. `sleep` is capped at 5ms real time
 *  regardless of the requested duration — this suite never asserts on
 *  cadence/timing (that's watcher.test.ts's job with fake timers), and a
 *  capped-but-nonzero sleep keeps a window-open loop from busy-spinning
 *  while still yielding control every iteration so it can be stopped
 *  deterministically (disarm the event, then one more `ensurePrintWatch`
 *  flips `rt.live=false` synchronously). DJ/EDGAR/IR are all no-ops: SYNX
 *  carries no conId (wire off), no CIK (stays unresolved), and no IR feed
 *  (the only configured feed is NVDA) — none of the three sources is ever
 *  actually invoked in this suite. */
function installSeams(nowFn: () => number): void {
  const overrides: Partial<WatcherSeams> = {
    storageRoot: () => tmpRoot,
    now: nowFn,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    twsConnection: async () => ({ up: false, ib: null }),
    pollDjNews: async () => ({ completedReleases: [], flashes: [] }),
    resolveCik: async () => null,
    pollEdgar: async () => [],
    pollIrRss: async () => [],
    extractCandidates: (contracts, text) => extractImpl(contracts, text),
  };
  _setTestSeams(overrides);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://test/api/print-watch/accept", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

interface AcceptEnvelope {
  success: boolean;
  error?: string;
  code?: string;
  data?: {
    accepted: string[];
    unaccepted: string[];
    promoted: { basis: "adj" | "gaap"; actualValue: string } | null;
  };
}

async function callAccept(body: unknown): Promise<{ status: number; json: AcceptEnvelope }> {
  const mod = await import("@/app/api/print-watch/accept/route");
  const res = await mod.POST(postReq(body));
  const json = (await res.json()) as AcceptEnvelope;
  return { status: res.status, json };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "print-watch-replay-"));
  extractImpl = async () => [];
});

afterEach(() => {
  _setTestSeams(null);
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SYNX fixtures: one committed HTML doc + three small inline follow-ups
// ---------------------------------------------------------------------------

const EVENT_DATE = "2026-08-26";
/** 10:00 ET on the print date — well before the 16:05-17:00 ET window
 *  (AMC resolves to the 16:15 default; see watcher.test.ts). */
const BEFORE_WINDOW_MS = new Date("2026-08-26T14:00:00Z").getTime();
/** 16:30 ET on the print date — inside the window. */
const INSIDE_WINDOW_MS = new Date("2026-08-26T20:30:00Z").getTime();

const SYNTHETIC_HTML_PATH = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "print-watch",
  "synthetic-release.html",
);

const DOC_A_MARKER = "SYNTHEX-DOC-A-Q2FY27";
const DOC_B_MARKER = "SYNTHEX-DOC-B-Q2FY27";
const DOC_C_MARKER = "SYNTHEX-DOC-C-Q2FY27";
const DOC_D_MARKER = "SYNTHEX-DOC-D-Q2FY27";

function candidate(overrides: Partial<ParseCandidate> & { metric_id: string }): ParseCandidate {
  return {
    value: null,
    value_high: null,
    raw_text: null,
    snippet: null,
    location_hint: null,
    not_disclosed: false,
    ...overrides,
  };
}

function clone(candidates: ParseCandidate[]): ParseCandidate[] {
  return candidates.map((c) => ({ ...c }));
}

// docA (the committed synthetic-release.html): every representation reports
// the SAME values for GAAP EPS, revenue, and the one disclosed segment, and
// Professional Services is the one plausible metric the release
// deliberately doesn't disclose (matches the fixture's own text). NOTE:
// eps_adj_q is deliberately left OUT of this mock even though the fixture's
// text shows "$1.18" for it — that number is already carried by the flash
// candidate seeded below, and reconcile.ts's rule 2 always excludes flash
// evidence from agreement. Adding a REAL (non-flash) eps_adj_q candidate
// here would sit in the pool forever (Codex #4: a document's evidence is
// never removed) and permanently block the later "modified doc" step from
// reaching a clean 'agreed' — any later disagreeing value would read as
// 'conflict' against this one, not as a divergence from the flash. Leaving
// it out keeps the flash the ONLY eps_adj_q evidence until docC arrives.
const DOC_A_CANDIDATES: ParseCandidate[] = [
  candidate({
    metric_id: "eps_gaap_q",
    value: 0.86,
    raw_text: "$0.86",
    snippet: "GAAP diluted net income per share attributable to Synthex Corp of $0.86",
    location_hint: "GAAP income statement",
  }),
  candidate({
    metric_id: "revenue_q",
    value: 425_000_000,
    raw_text: "425,000",
    snippet: "Total revenue of $425,000 thousand",
    location_hint: "GAAP income statement",
  }),
  candidate({
    metric_id: "seg_cloud_services_revenue_q",
    value: 300_000_000,
    raw_text: "300,000",
    snippet: "Cloud Services revenue of $300,000 thousand",
    location_hint: "segment disclosure",
  }),
  candidate({ metric_id: "seg_professional_services_revenue_q", not_disclosed: true }),
];

// docB: a second, independent witness confirming Professional Services is
// not broken out — the SECOND distinct document needed for 'blank' (rule 4
// requires >=2 distinct doc_ids; docA's own repA/repB pair alone only
// reaches 'pending').
const DOC_B_CANDIDATES: ParseCandidate[] = [
  candidate({ metric_id: "seg_professional_services_revenue_q", not_disclosed: true }),
];

// docC: the MODIFIED synthetic doc — a correction restating adjusted EPS to
// a new value. Its own repA/repB pair is an independent agreement on its
// own; because eps_adj_q's earlier evidence came ONLY from a flash (which
// reconcile.ts always excludes from agreement — rule 2's preamble), this is
// the one case in the whole reconciler where a fresh 'agreed' outcome can
// legitimately diverge from an already-accepted line's locked value without
// simply reading as 'conflict' against old real-document evidence.
const DOC_C_CANDIDATES: ParseCandidate[] = [
  candidate({
    metric_id: "eps_adj_q",
    value: 1.31,
    raw_text: "$1.31",
    snippet: "Restated non-GAAP diluted net income per share of $1.31",
    location_hint: "restated reconciliation table",
  }),
];

// docD: a short follow-up wire confirmation reaffirming docC's value — its
// job is purely to trigger the NEXT writeLines pass (Codex #15: unaccept
// only releases the lock; reconcile.ts recomputes value/state on the next
// write, not synchronously on unaccept) so the sheet actually shows the
// corrected value before it gets re-accepted.
const DOC_D_CANDIDATES: ParseCandidate[] = [
  candidate({
    metric_id: "eps_adj_q",
    value: 1.31,
    raw_text: "$1.31",
    snippet: "Wire services confirm the restated non-GAAP diluted EPS of $1.31",
    location_hint: "wire confirmation",
  }),
];

function markerExtract(text: string): ParseCandidate[] {
  if (text.includes(DOC_A_MARKER)) return clone(DOC_A_CANDIDATES);
  if (text.includes(DOC_B_MARKER)) return clone(DOC_B_CANDIDATES);
  if (text.includes(DOC_C_MARKER)) return clone(DOC_C_CANDIDATES);
  if (text.includes(DOC_D_MARKER)) return clone(DOC_D_CANDIDATES);
  return [];
}

// Doc B is ingested as an `ir-page`, which since the Codex fix wave (finding
// A) must name THIS event's quarter rather than merely A fiscal quarter — a
// newsroom feed serves last quarter's release forever under the same title
// shape, so the generous fiscal-label fallback is not available to it. What
// satisfies the strict branch on a real newsroom post is its DATELINE, which
// always carries the calendar year; this fixture carries one for the same
// reason.
const DOC_B_TEXT = [
  "Synthex Corp (NASDAQ: SYNX) Second Quarter Fiscal 2027 Supplemental Disclosure",
  "SAN JOSE, Calif., Aug. 26, 2026 — The Company confirms that professional services",
  "revenue is not reported as a separate line item for the second quarter of fiscal 2027.",
  `Filing Reference: ${DOC_B_MARKER}`,
].join("\n");

const DOC_C_HTML = [
  "<html><body>",
  "<h1>Synthex Corp (NASDAQ: SYNX) Issues Correction to Second Quarter Fiscal 2027",
  " Non-GAAP Diluted EPS</h1>",
  "<p>Synthex Corp (NASDAQ: SYNX) today issued a correction to its previously reported",
  " second quarter fiscal 2027 non-GAAP diluted earnings per share.</p>",
  "<table><tr><th>Reconciliation (Restated)</th><th>Q2 FY2027</th></tr>",
  "<tr><td>Non-GAAP diluted net income per share</td><td>$1.31</td></tr></table>",
  `<p>Filing Reference: ${DOC_C_MARKER}</p>`,
  "</body></html>",
].join("");

const DOC_D_TEXT = [
  "Synthex Corp (NASDAQ: SYNX) Second Quarter Fiscal 2027 Wire Confirmation",
  "Wire services confirm the restated non-GAAP diluted EPS of $1.31 for the second",
  "quarter of fiscal 2027.",
  `Filing Reference: ${DOC_D_MARKER}`,
].join("\n");

/** Seeds an armed SYNX earnings event with desk-consensus bogeys (EPS,
 *  revenue, and two candidate segments — Cloud Services is disclosed in the
 *  release, Professional Services deliberately is not). */
function seedSynx(eventDate: string): { eventId: number } {
  const sec = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, ib_con_id) VALUES ('SYNX', 'Synthex Corp', 'Stock', NULL)`,
    )
    .run();
  const ev = db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, title, symbol, security_id, raw_json, source_key)
       VALUES ('finnhub', 'earnings', ?, 'AMC', 'SYNX earnings', 'SYNX', ?, ?, ?)`,
    )
    .run(
      eventDate,
      Number(sec.lastInsertRowid),
      JSON.stringify({ entry: { hour: "amc" } }),
      `finnhub:SYNX:${eventDate}`,
    );
  const eventId = Number(ev.lastInsertRowid);

  db.prepare(`INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)`).run(eventId);
  db.prepare(
    `INSERT INTO earnings_bogeys
       (event_id, source, source_label, eps_consensus, revenue_consensus_usd, segment_breakdown_json)
     VALUES (?, 'manual', 'desk consensus', 1.18, 425000000, ?)`,
  ).run(
    eventId,
    JSON.stringify({
      "Cloud Services": { consensus: 300_000_000 },
      "Professional Services": { consensus: 40_000_000 },
    }),
  );

  return { eventId };
}

// ---------------------------------------------------------------------------
// suite 1: ALWAYS-RUN synthetic replay
// ---------------------------------------------------------------------------

describe("synthetic replay — full production pipeline (Task 13)", () => {
  it(
    "reaches agreed/blank correctly, accepts + promotes, then a modified doc diverges from an " +
      "accepted flash value, and the line is unaccepted and re-accepted at the corrected value",
    async () => {
      const { eventId } = seedSynx(EVENT_DATE);
      extractImpl = async (_contracts, text) => markerExtract(text);
      installSeams(() => BEFORE_WINDOW_MS);

      // --- seed: compile + open the print ---
      ensurePrintWatch(db);
      const print = getPrintByEventId(db, eventId)!;
      expect(print.state).toBe("scheduled"); // well before the window; no loop needed for this test
      const printId = print.id;

      const initialSheet = getSheet(db, printId);
      expect(initialSheet.map((l) => l.metric_id).sort()).toEqual([
        "eps_adj_q",
        "eps_gaap_q",
        "revenue_q",
        "seg_cloud_services_revenue_q",
        "seg_professional_services_revenue_q",
      ]);
      expect(initialSheet.find((l) => l.metric_id === "eps_adj_q")!.expected?.value).toBe(1.18);

      // --- a DJ flash arrives early with a provisional adjusted-EPS number,
      //     and the desk accepts it before any real document lands ---
      const { contracts, expected } = compileContracts(db, eventId, "SYNX");
      const flashCandidate: TaggedCandidate = {
        metric_id: "eps_adj_q",
        value: 1.18,
        value_high: null,
        raw_text: "*SYNTHEX 2Q ADJ EPS $1.18",
        snippet: "*SYNTHEX 2Q ADJ EPS $1.18",
        location_hint: null,
        not_disclosed: false,
        doc_id: 0,
        representation: "flash",
        weak_pair: false,
      };
      // Flash candidates carry the FLASH_DOC_ID sentinel (0) so
      // byLowestDocId still works inside reconcile.ts, but source_doc_id is
      // a real FK to print_watch_documents(id) — watcher.ts's (unexported)
      // writeLines() nulls it out before every store write; replicate that
      // here since this line is hand-seeded rather than produced by the
      // production pipeline.
      const flashLines = reconcile(contracts, expected, [flashCandidate], []).map((line) =>
        line.source_doc_id === 0 ? { ...line, source_doc_id: null } : line,
      );
      upsertLines(db, printId, flashLines);
      expect(getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).toBe("flash");

      const acceptFlash = await callAccept({ eventId, accept: ["eps_adj_q"] });
      expect(acceptFlash.status).toBe(200);
      const afterFlashAccept = getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!;
      expect(afterFlashAccept.state).toBe("accepted");
      expect(afterFlashAccept.value).toBe(1.18);

      // --- ingest the committed synthetic release (doc A) through the real gate + pipeline ---
      const docABuf = await fsp.readFile(SYNTHETIC_HTML_PATH);
      const ingestA = await ingestDocument(db, printId, "edgar-ex99", "edgar:synthex-a", null, docABuf);
      expect(ingestA.isNew).toBe(true);

      let sheet = getSheet(db, printId);
      expect(sheet.find((l) => l.metric_id === "eps_gaap_q")!.state).toBe("agreed");
      expect(sheet.find((l) => l.metric_id === "eps_gaap_q")!.value).toBe(0.86);
      expect(sheet.find((l) => l.metric_id === "revenue_q")!.state).toBe("agreed");
      expect(sheet.find((l) => l.metric_id === "revenue_q")!.value).toBe(425_000_000);
      expect(sheet.find((l) => l.metric_id === "seg_cloud_services_revenue_q")!.state).toBe("agreed");
      expect(sheet.find((l) => l.metric_id === "seg_cloud_services_revenue_q")!.value).toBe(300_000_000);
      // Only ONE document's worth of not-disclosed evidence so far — rule 4
      // needs a second distinct doc_id before this can read 'blank'.
      expect(sheet.find((l) => l.metric_id === "seg_professional_services_revenue_q")!.state).toBe(
        "pending",
      );
      // eps_adj_q stays locked to the flash-accepted value — docA repeats
      // 1.18, so there is nothing to diverge on yet.
      expect(sheet.find((l) => l.metric_id === "eps_adj_q")!.state).toBe("accepted");
      expect(sheet.find((l) => l.metric_id === "eps_adj_q")!.value).toBe(1.18);

      // --- ingest doc B: the second independent witness that Professional
      //     Services isn't disclosed -> pushes the line to 'blank' ---
      const ingestB = await ingestDocument(
        db,
        printId,
        "ir-page",
        "ir:synthex-b",
        null,
        Buffer.from(DOC_B_TEXT, "utf8"),
      );
      expect(ingestB.isNew).toBe(true);

      sheet = getSheet(db, printId);
      expect(sheet.find((l) => l.metric_id === "seg_professional_services_revenue_q")!.state).toBe(
        "blank",
      );

      // --- accept revenue_q and promote the headline; eps_adj_q rides its
      //     pre-existing accepted state into the complete pair ---
      const promote = await callAccept({ eventId, accept: ["revenue_q"], promoteHeadline: true });
      expect(promote.status).toBe(200);
      expect(promote.json.data!.promoted).toEqual({
        basis: "adj",
        actualValue: "EPS 1.18 · Rev 425000000",
      });

      const afterPromote = db
        .prepare(`SELECT actual_value, manual_actuals_at FROM calendar_events WHERE id = ?`)
        .get(eventId) as { actual_value: string | null; manual_actuals_at: string | null };
      expect(afterPromote.actual_value).toBe("EPS 1.18 · Rev 425000000");
      expect(afterPromote.manual_actuals_at).not.toBeNull();
      expect(getSheet(db, printId).find((l) => l.metric_id === "revenue_q")!.state).toBe("accepted");

      // --- ingest doc C: a MODIFIED synthetic doc restating adjusted EPS ---
      const ingestC = await ingestDocument(
        db,
        printId,
        "edgar-ex99",
        "edgar:synthex-c",
        null,
        Buffer.from(DOC_C_HTML, "utf8"),
      );
      expect(ingestC.isNew).toBe(true);

      const lockedLine = getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!;
      // Still locked to the ORIGINAL accepted value: accept freezes
      // state/value; only candidates_json refreshes (store.ts's upsertLines
      // CASE guard, reconcile.ts's rule 6).
      expect(lockedLine.state).toBe("accepted");
      expect(lockedLine.value).toBe(1.18);

      // needsReverify-equivalent check: recompute this line's OWN candidate
      // pool with no accepted lock (exactly what
      // app/dashboard/today/PrintWatchPanel.tsx's needsReverify does to
      // render the "superseded — re-verify" chip) and confirm it now
      // independently agrees on a DIFFERENT value. Verified directly against
      // lib/print-watch/reconcile.ts — not by importing the panel module,
      // which a different task is concurrently editing.
      const freshCandidates = JSON.parse(lockedLine.candidates_json) as TaggedCandidate[];
      const [freshOutcome] = reconcile([lockedLine.contract], {}, freshCandidates, []);
      expect(freshOutcome.state).toBe("agreed");
      expect(freshOutcome.value).toBe(1.31);
      expect(freshOutcome.value).not.toBe(lockedLine.value);

      // --- unaccept via the accept route ---
      const unaccept = await callAccept({ eventId, unaccept: ["eps_adj_q"] });
      expect(unaccept.status).toBe(200);
      expect(unaccept.json.data!.unaccepted).toEqual(["eps_adj_q"]);
      expect(getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!.state).not.toBe(
        "accepted",
      );

      // --- ingest doc D: a follow-up wire confirmation. Unaccept only
      //     releases the lock (Codex #15) — this document's writeLines pass
      //     is what actually recomputes the line now that it's unlocked. ---
      const ingestD = await ingestDocument(
        db,
        printId,
        "dj-release",
        "dj:synthex-d",
        null,
        Buffer.from(DOC_D_TEXT, "utf8"),
      );
      expect(ingestD.isNew).toBe(true);

      const recomputed = getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!;
      expect(recomputed.state).toBe("agreed");
      expect(recomputed.value).toBe(1.31);

      // --- re-accept the new value, and re-promote the corrected headline ---
      const reaccept = await callAccept({
        eventId,
        accept: ["eps_adj_q"],
        promoteHeadline: true,
      });
      expect(reaccept.status).toBe(200);
      expect(reaccept.json.data!.promoted).toEqual({
        basis: "adj",
        actualValue: "EPS 1.31 · Rev 425000000",
      });
      const finalLine = getSheet(db, printId).find((l) => l.metric_id === "eps_adj_q")!;
      expect(finalLine.state).toBe("accepted");
      expect(finalLine.value).toBe(1.31);

      const finalEvent = db
        .prepare(`SELECT actual_value FROM calendar_events WHERE id = ?`)
        .get(eventId) as { actual_value: string | null };
      expect(finalEvent.actual_value).toBe("EPS 1.31 · Rev 425000000");
    },
  );
});

// ---------------------------------------------------------------------------
// suite 1b: restart-after-insert drill
// ---------------------------------------------------------------------------

describe("restart-after-insert drill (Task 13)", () => {
  it("drains a document inserted directly via the store (bypassing the gate) on the next watcher tick", async () => {
    const { eventId } = seedSynx(EVENT_DATE);
    extractImpl = async (_contracts, text) => markerExtract(text);
    installSeams(() => INSIDE_WINDOW_MS);

    // A print already inside its window — the loop starts immediately.
    ensurePrintWatch(db);
    const print = getPrintByEventId(db, eventId)!;
    expect(print.state).toBe("window_open");
    const printId = print.id;

    expect(listUnparsedDocuments(db, printId)).toHaveLength(0);

    // Simulate a PRIOR process that acquired bytes to disk and inserted the
    // document row (i.e. it already passed the gate), then crashed before
    // the pipeline ever parsed it — bypass ingestDocument entirely and go
    // straight through the store, per Codex #6's crash-recovery contract.
    const bytes = await fsp.readFile(SYNTHETIC_HTML_PATH);
    const sha = sha256(bytes);
    const dir = path.join(tmpRoot, String(printId));
    await fsp.mkdir(dir, { recursive: true });
    const bytesPath = path.join(dir, `${sha}.html`);
    await fsp.writeFile(bytesPath, bytes);
    const { id: docId } = insertDocument(
      db,
      printId,
      "edgar-ex99",
      "edgar:restart-drill",
      null,
      sha,
      bytesPath,
    );

    expect(listUnparsedDocuments(db, printId).map((d) => d.id)).toEqual([docId]);
    expect(listDocuments(db, printId)[0].parsed_at).toBeNull();

    // A watcher tick — the polling loop already running because the print
    // is in-window — must drain it with no further ingestDocument call.
    await waitUntil(() => listUnparsedDocuments(db, printId).length === 0);

    expect(listDocuments(db, printId).find((d) => d.id === docId)!.parsed_at).not.toBeNull();

    const sheet = getSheet(db, printId);
    expect(sheet.find((l) => l.metric_id === "revenue_q")!.state).toBe("agreed");
    expect(sheet.find((l) => l.metric_id === "revenue_q")!.value).toBe(425_000_000);
    expect(sheet.find((l) => l.metric_id === "eps_gaap_q")!.state).toBe("agreed");
    expect(sheet.find((l) => l.metric_id === "eps_gaap_q")!.value).toBe(0.86);

    // Stop the loop cleanly before the test ends (afterEach also resets
    // watcher state, but disarming first avoids a stray in-flight poll).
    db.prepare(`DELETE FROM earnings_worksheet_flags WHERE event_id = ?`).run(eventId);
    ensurePrintWatch(db);
  });
});

// ---------------------------------------------------------------------------
// suite 2: GUARDED real-corpus replay (CRWD-2026-06-03 bake-off pilot)
// ---------------------------------------------------------------------------

const CRWD_DIR = path.join(process.cwd(), "tests", "fixtures", "real", "bakeoff", "CRWD-2026-06-03");
const CRWD_HTML_PATH = path.join(CRWD_DIR, "edgar-ex99-1.htm");
const CRWD_REP_A_PATH = path.join(CRWD_DIR, "parse-repA.json");
const CRWD_REP_B_PATH = path.join(CRWD_DIR, "parse-repB.json");
const hasCrwdCorpus =
  fs.existsSync(CRWD_HTML_PATH) && fs.existsSync(CRWD_REP_A_PATH) && fs.existsSync(CRWD_REP_B_PATH);

interface RecordedCandidate {
  metric_id: string;
  value: number | null;
  value_high: number | null;
  raw_text: string | null;
  snippet: string | null;
  location_hint: string | null;
  not_disclosed: boolean;
}

interface RecordedParseFile {
  candidates: RecordedCandidate[];
}

function toParseCandidate(c: RecordedCandidate): ParseCandidate {
  return {
    metric_id: c.metric_id,
    value: c.value,
    value_high: c.value_high,
    raw_text: c.raw_text,
    snippet: c.snippet,
    location_hint: c.location_hint,
    not_disclosed: c.not_disclosed,
  };
}

describe.skipIf(!hasCrwdCorpus)(
  "CRWD-2026-06-03 real-corpus replay (guarded — gitignored bake-off corpus)",
  () => {
    it("greens the pilot's agreed metrics (eps_gaap_q, eps_adj_q, revenue_q) through the production pipeline", async () => {
      const html = await fsp.readFile(CRWD_HTML_PATH, "utf8");
      const repAText = htmlToTablesRepresentation(html);
      const repBText = htmlToRawText(html);

      const repAJson = JSON.parse(fs.readFileSync(CRWD_REP_A_PATH, "utf8")) as RecordedParseFile;
      const repBJson = JSON.parse(fs.readFileSync(CRWD_REP_B_PATH, "utf8")) as RecordedParseFile;
      const repACandidates = repAJson.candidates.map(toParseCandidate);
      const repBCandidates = repBJson.candidates.map(toParseCandidate);

      extractImpl = async (_contracts, text) => {
        if (text === repAText) return repACandidates;
        if (text === repBText) return repBCandidates;
        return [];
      };
      installSeams(() => new Date("2026-06-03T14:00:00Z").getTime()); // 10:00 ET — before the window

      const sec = db
        .prepare(
          `INSERT INTO securities (symbol, name, security_type, ib_con_id)
           VALUES ('CRWD', 'CrowdStrike Holdings, Inc.', 'Stock', NULL)`,
        )
        .run();
      const ev = db
        .prepare(
          `INSERT INTO calendar_events
             (source, event_type, event_date, event_time, title, symbol, security_id, raw_json, source_key)
           VALUES ('finnhub', 'earnings', '2026-06-03', 'AMC', 'CRWD earnings', 'CRWD', ?, ?, 'finnhub:CRWD:2026-06-03')`,
        )
        .run(Number(sec.lastInsertRowid), JSON.stringify({ entry: { hour: "amc" } }));
      const eventId = Number(ev.lastInsertRowid);
      db.prepare(`INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)`).run(eventId);

      ensurePrintWatch(db);
      const printId = getPrintByEventId(db, eventId)!.id;

      const result = await ingestDocument(
        db,
        printId,
        "edgar-ex99",
        "edgar:crwd-ex99-1",
        "https://www.sec.gov/Archives/edgar/data/1535527/000153552726000022/crwd-20260603xex991.htm",
        Buffer.from(html, "utf8"),
      );
      expect(result.isNew).toBe(true);

      const sheet = getSheet(db, printId);
      const gaap = sheet.find((l) => l.metric_id === "eps_gaap_q")!;
      const adj = sheet.find((l) => l.metric_id === "eps_adj_q")!;
      const revenue = sheet.find((l) => l.metric_id === "revenue_q")!;

      // Values per gold-frozen.json (claude+codex exact agreement, criticals
      // adjudicated documents-win — see labeling-claude-report.md).
      expect(gaap.state).toBe("agreed");
      expect(gaap.value).toBe(0.11);
      expect(adj.state).toBe("agreed");
      expect(adj.value).toBe(1.1);
      expect(revenue.state).toBe("agreed");
      expect(revenue.value).toBe(1_385_629_000);
    });
  },
);

if (!hasCrwdCorpus) {
  it("skips gracefully when the real bake-off corpus is not present in this checkout", () => {
    expect(hasCrwdCorpus).toBe(false);
  });
}
