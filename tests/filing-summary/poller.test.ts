/**
 * The armed-print filing poll and its 60-second tick (spec §4, R11, R12,
 * "Late arms", Hardening 1 and 10). Fake clock, fake fetch, migrated
 * in-memory DB. Every fixture is SYNTHETIC: a made-up CIK, accessions,
 * company and file names.
 *
 * Event: ACME (Acme Widgets Inc) reports after the close on 2026-10-21, an
 * EDT day, so Eastern = UTC - 4h.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import type { FetchLike } from "@/lib/print-watch/hardened-fetch";
import {
  issuerNameForEvent,
  pollEvent,
  pollPhase,
  EVENT_DATE_CHANGED_REASON,
  ISSUER_CHANGED_REASON,
  __resetPollerCacheForTests,
  AFTER_CUTOFF_REASON,
  MANUAL_ONLY_DETAIL,
  STORED_COPY_MISSING_DETAIL,
  eventsWithLiveFilings,
  type PollSeams,
} from "@/lib/filing-summary/poller";
import { DISCOVERY_GAVE_UP_DETAIL, RUNNER_LOAD_FAILED_DETAIL } from "@/lib/filing-summary/labels";
import { needsPolling, pollStateText } from "@/app/dashboard/today/filing-summary-text";
import {
  runTick,
  startFilingSummaryTick,
  enableFilingSummaryTick,
  loadRunnerOrReport,
  MAX_DISCOVERY_ATTEMPTS,
  __resetFilingSummaryTickForTests,
  type TickSeams,
} from "@/lib/filing-summary/tick";
import { mergeFilingSummaryState } from "@/lib/filing-summary/merge";
import {
  ensureAutoRun as runnerEnsureAutoRun,
  onCompanionAccepted as runnerOnCompanionAccepted,
  onEarningsAccepted as runnerOnEarningsAccepted,
} from "@/lib/filing-summary/runner";
import { applyFilingSummaryAction } from "@/lib/filing-summary/actions";
import { getPanelViews } from "@/lib/filing-summary/view";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import {
  claimNextSection,
  createRun,
  getEventState,
  listDocuments,
  listFilings,
  listRuns,
  listSections,
  beginPush,
  markPush,
  upsertEventState,
} from "@/lib/filing-summary/store";

const CIK = "0000123456";
const CIK_NUM = "123456";
const EVENT_DATE = "2026-10-21";
const SUBMISSIONS = `https://data.sec.gov/submissions/CIK${CIK}.json`;

/** UTC instant of an Eastern (EDT) wall time on 2026-10-21 (or next day). */
function et(hhmm: string, day = EVENT_DATE): number {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.parse(`${day}T00:00:00Z`) + (h + 4) * 3_600_000 + m * 60_000;
}

// ---------------------------------------------------------------- fake EDGAR

interface FakeFiling {
  accession: string;
  form: string;
  /** Raw submissions-JSON acceptanceDateTime. */
  json: string;
  /** Header ACCEPTANCE-DATETIME (YYYYMMDDHHMMSS, Eastern) or null for none. */
  header: string | null;
  items?: string[];
  docs: Array<{ type: string; seq: number; file: string; body?: string; contentType?: string; status?: number }>;
}

class FakeEdgar {
  filings: FakeFiling[] = [];
  calls: string[] = [];
  submissionsFail = false;
  /** Accessions whose header fetch fails. */
  headerFail = new Set<string>();

  base(accession: string): string {
    return `https://www.sec.gov/Archives/edgar/data/${CIK_NUM}/${accession.replace(/-/g, "")}`;
  }

  headerHtml(f: FakeFiling): string {
    const raw = [
      `<SEC-HEADER>${f.accession}.hdr.sgml`,
      ...(f.header ? [`<ACCEPTANCE-DATETIME>${f.header}`] : []),
      `<TYPE>${f.form}`,
      ...(f.items ?? []).map((i) => `<ITEMS>${i}`),
    ].join("\n");
    const docs = f.docs
      .map((d) =>
        [
          "&lt;DOCUMENT&gt;",
          `&lt;TYPE&gt;${d.type}`,
          `&lt;SEQUENCE&gt;${d.seq}`,
          `&lt;FILENAME&gt;${d.file}`,
          "&lt;TEXT&gt;",
          "&lt;/DOCUMENT&gt;",
        ].join("\n"),
      )
      .join("\n");
    return `<html><!-- ${raw} --><body><pre>${docs}</pre></body></html>`;
  }

  fetchFn: FetchLike = async (url) => {
    this.calls.push(url);
    if (url === SUBMISSIONS) {
      if (this.submissionsFail) return new Response("down", { status: 503, headers: { "content-type": "text/plain" } });
      const recent = {
        form: this.filings.map((f) => f.form),
        acceptanceDateTime: this.filings.map((f) => f.json),
        accessionNumber: this.filings.map((f) => f.accession),
      };
      return new Response(JSON.stringify({ filings: { recent } }), {
        headers: { "content-type": "application/json" },
      });
    }
    for (const f of this.filings) {
      if (url === `${this.base(f.accession)}/${f.accession}-index-headers.html`) {
        if (this.headerFail.has(f.accession)) {
          return new Response("err", { status: 500, headers: { "content-type": "text/html" } });
        }
        return new Response(this.headerHtml(f), { headers: { "content-type": "text/html" } });
      }
      for (const d of f.docs) {
        if (url === `${this.base(f.accession)}/${d.file}`) {
          return new Response(d.body ?? `<p>${d.type}</p>`, {
            status: d.status ?? 200,
            headers: { "content-type": d.contentType ?? "text/html" },
          });
        }
      }
    }
    throw new Error(`unmocked fetch: ${url}`);
  };

  submissionsCalls(): number {
    return this.calls.filter((u) => u === SUBMISSIONS).length;
  }
  headerCalls(accession: string): number {
    return this.calls.filter((u) => u.endsWith(`${accession}-index-headers.html`)).length;
  }
}

const EX99_GOOD = "<p>Acme Widgets Inc reports Q3 2026 results. Revenue rose.</p>";
const EX99_WRONG_ISSUER = "<p>Some other company reports Q3 2026 results.</p>";

function earnings8k(accession: string, hhmmss: string, ex99 = EX99_GOOD, day = "20261021"): FakeFiling {
  const dashed = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  return {
    accession,
    form: "8-K",
    header: `${day}${hhmmss}`,
    json: `${dashed}T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}.000Z`,
    items: ["2.02", "9.01"],
    docs: [
      { type: "8-K", seq: 1, file: "acme-8k.htm", body: "<p>Item 2.02 Results of Operations</p>" },
      { type: "EX-99.1", seq: 2, file: "acme-ex991.htm", body: ex99 },
      { type: "GRAPHIC", seq: 3, file: "logo.jpg" },
    ],
  };
}

function companion(accession: string, form: string, hhmmss: string): FakeFiling {
  return {
    accession,
    form,
    json: `2026-10-21T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}.000Z`,
    header: `20261021${hhmmss}`,
    docs: [{ type: form, seq: 1, file: `acme-${form.replace(/\W/g, "").toLowerCase()}.htm` }],
  };
}

// ---------------------------------------------------------------- setup

let db: Database.Database;
let edgar: FakeEdgar;
let root: string;
let eventId: number;
let earningsCalls: number[];
let companionCalls: Array<[number, number]>;
let runCalls: number[];
let clock: number;

function seams(): TickSeams {
  return {
    fetchFn: edgar.fetchFn,
    resolveCik: async () => CIK,
    now: () => clock,
    issuerName: issuerNameForEvent,
    onEarningsAccepted: (_d, id) => earningsCalls.push(id),
    onCompanionAccepted: (_d, id, filingId) => companionCalls.push([id, filingId]),
    storageRoot: () => root,
    runNextSection: async (_d, id) => {
      runCalls.push(id);
    },
  };
}

/** Arms the event with the flag's created_at at the given instant. */
function arm(atMs: number, id = eventId): void {
  const stamp = new Date(atMs).toISOString().replace("T", " ").slice(0, 19);
  db.prepare(`INSERT INTO earnings_worksheet_flags (event_id, created_at) VALUES (?, ?)`).run(id, stamp);
}
function disarm(id = eventId): void {
  db.prepare(`DELETE FROM earnings_worksheet_flags WHERE event_id = ?`).run(id);
}

async function tick(atMs: number) {
  clock = atMs;
  return runTick(db, atMs, seams());
}

beforeEach(() => {
  __resetPollerCacheForTests();
  __resetFilingSummaryTickForTests();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('ACME', 'Acme Widgets Inc', 'Stock')`).run();
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('finnhub','earnings',?, 'ACME earnings', 'fs-poll-acme', 'ACME')`,
      )
      .run(EVENT_DATE).lastInsertRowid,
  );
  edgar = new FakeEdgar();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-poller-"));
  earningsCalls = [];
  companionCalls = [];
  runCalls = [];
  clock = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- tests

describe("pollPhase (Eastern window)", () => {
  it("06:00 to 20:00 Eastern on the event date is the window; 20:00:00 is past it", () => {
    expect(pollPhase(EVENT_DATE, et("05:59"))).toBe("before_window");
    expect(pollPhase(EVENT_DATE, et("06:00"))).toBe("in_window");
    expect(pollPhase(EVENT_DATE, et("19:59"))).toBe("in_window");
    expect(pollPhase(EVENT_DATE, et("20:00"))).toBe("after_cutoff");
    expect(pollPhase(EVENT_DATE, et("01:00", "2026-10-22"))).toBe("after_cutoff");
  });

  it("follows the clock change: on 2026-11-01 (EST from 02:00) the window is 11:00Z to 01:00Z", () => {
    expect(pollPhase("2026-11-01", Date.parse("2026-11-01T10:59:00Z"))).toBe("before_window");
    expect(pollPhase("2026-11-01", Date.parse("2026-11-01T11:00:00Z"))).toBe("in_window");
    expect(pollPhase("2026-11-01", Date.parse("2026-11-02T00:59:59Z"))).toBe("in_window");
    expect(pollPhase("2026-11-01", Date.parse("2026-11-02T01:00:00Z"))).toBe("after_cutoff");
  });
});

describe("pollEvent lifecycle", () => {
  it("an AMC event polled at 15:00 with no filing is waiting", async () => {
    arm(et("09:00"));
    await tick(et("15:00"));
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("waiting");
    expect(s.cik).toBe(CIK);
    expect(s.catchupDone).toBe(false);
    expect(edgar.submissionsCalls()).toBe(1);
    expect(listFilings(db, eventId)).toEqual([]);
  });

  it("before 06:00 Eastern nothing is fetched", async () => {
    arm(et("02:00"));
    await tick(et("05:30"));
    expect(edgar.calls).toEqual([]);
    expect(getEventState(db, eventId)!.pollState).toBe("waiting");
  });

  it("a 16:05 earnings 8-K is inserted accepted, documents stored, onEarningsAccepted once; header fetched once", async () => {
    arm(et("09:00"));
    await tick(et("15:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    await tick(et("16:07"));

    const filings = listFilings(db, eventId);
    expect(filings).toHaveLength(1);
    expect(filings[0]).toMatchObject({
      role: "earnings",
      identityVerdict: "accepted",
      form: "8-K",
      items: "2.02,9.01",
      acceptedAt: new Date(et("16:05")).toISOString(),
      fetchState: "fetched",
    });
    expect(earningsCalls).toEqual([eventId]);
    expect(getEventState(db, eventId)!.pollState).toBe("found");
    expect(edgar.headerCalls("0000123456-26-000101")).toBe(1);

    const docs = listDocuments(db, filings[0].id);
    expect(docs.map((d) => [d.fileName, d.status])).toEqual([
      ["acme-8k.htm", "fetched"],
      ["acme-ex991.htm", "fetched"],
      ["logo.jpg", "skipped"],
    ]);
    const ex = docs[1];
    expect(ex.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ex.storedPath).toBe(path.join(root, "filing-summary", CIK, "0000123456-26-000101", "acme-ex991.htm"));
    expect(fs.readFileSync(ex.storedPath!, "utf8")).toBe(EX99_GOOD);
  });

  it("a PRE 14C accepted 16:12 after the 8-K is a companion: onCompanionAccepted once", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    edgar.filings.push(companion("0000123456-26-000102", "PRE 14C", "161200"));
    await tick(et("16:13"));
    await tick(et("16:14"));

    const filings = listFilings(db, eventId);
    expect(filings.map((f) => [f.form, f.role, f.identityVerdict])).toEqual([
      ["8-K", "earnings", "accepted"],
      ["PRE 14C", "companion", "accepted"],
    ]);
    expect(companionCalls).toEqual([[eventId, filings[1].id]]);
    expect(earningsCalls).toEqual([eventId]);
  });

  it("a Form 4 is ignored without fetching its header", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    edgar.filings.push(companion("0000123456-26-000109", "4", "170000"));
    await tick(et("17:01"));
    expect(listFilings(db, eventId)).toHaveLength(1);
    expect(edgar.headerCalls("0000123456-26-000109")).toBe(0);
  });

  it("Review Focus 2: no tick 15:50 → 21:30; the catch-up reads the 16:05 8-K, lists the 20:01 10-Q as after 8 pm, then past_cutoff", async () => {
    arm(et("09:00"));
    await tick(et("15:00"));
    await tick(et("15:50"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    edgar.filings.push(companion("0000123456-26-000103", "10-Q", "200100"));
    await tick(et("21:30"));

    const filings = listFilings(db, eventId);
    expect(filings.map((f) => [f.form, f.role, f.identityVerdict, f.identityReason])).toEqual([
      ["8-K", "earnings", "accepted", null],
      ["10-Q", "companion", "rejected", AFTER_CUTOFF_REASON],
    ]);
    expect(earningsCalls).toEqual([eventId]);
    expect(companionCalls).toEqual([]);
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("past_cutoff");
    expect(s.catchupDone).toBe(true);

    const before = edgar.calls.length;
    await tick(et("21:31"));
    expect(edgar.calls.length).toBe(before);
  });

  it("the catch-up with no filing says no earnings 8-K by 8 pm", async () => {
    arm(et("09:00"));
    await tick(et("15:00"));
    await tick(et("20:00"));
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("past_cutoff");
    expect(s.pollDetail).toBe("no earnings 8-K filed by 8 pm");
  });

  it("ruling 1: a filing whose HEADER day is the day before is ignored even when the JSON passes the prefilter", async () => {
    arm(et("09:00"));
    edgar.filings.push({
      ...earnings8k("0000123456-26-000099", "210000"),
      json: "2026-10-21T01:00:00Z",
      header: "20261020210000",
    });
    await tick(et("16:00"));
    expect(edgar.headerCalls("0000123456-26-000099")).toBe(1);
    expect(listFilings(db, eventId)).toEqual([]);
    expect(earningsCalls).toEqual([]);
  });

  it("a submissions failure is sec_unreachable, also at catch-up time (never past_cutoff, never 'no filing')", async () => {
    arm(et("09:00"));
    edgar.submissionsFail = true;
    await tick(et("16:00"));
    expect(getEventState(db, eventId)!.pollState).toBe("sec_unreachable");
    await tick(et("21:00"));
    let s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("sec_unreachable");
    expect(s.catchupDone).toBe(false);
    expect(s.pollDetail).not.toMatch(/no earnings/);

    // SEC is back: the retried catch-up finds the 8-K accepted before 20:00.
    edgar.submissionsFail = false;
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("21:01"));
    s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("past_cutoff");
    expect(s.catchupDone).toBe(true);
    expect(earningsCalls).toEqual([eventId]);
  });

  it("a header fetch failure is not cached and holds back the catch-up", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    edgar.headerFail.add("0000123456-26-000101");
    await tick(et("20:30"));
    let s = getEventState(db, eventId)!;
    expect(s.catchupDone).toBe(false);
    expect(s.pollState).toBe("sec_unreachable");
    edgar.headerFail.clear();
    await tick(et("20:31"));
    s = getEventState(db, eventId)!;
    expect(s.catchupDone).toBe(true);
    expect(listFilings(db, eventId)).toHaveLength(1);
    expect(edgar.headerCalls("0000123456-26-000101")).toBe(2);
  });

  it("Review Focus 1: a header without an acceptance time is time_unconfirmed and never run", async () => {
    arm(et("09:00"));
    edgar.filings.push({ ...earnings8k("0000123456-26-000101", "160500"), header: null });
    await tick(et("16:06"));
    const filings = listFilings(db, eventId);
    expect(filings).toHaveLength(1);
    expect(filings[0].identityVerdict).toBe("time_unconfirmed");
    expect(filings[0].acceptedAt).toBeNull();
    expect(earningsCalls).toEqual([]);
    expect(getEventState(db, eventId)!.pollState).toBe("waiting");
  });

  it("C1: armed at 20:30 → manual_only; ONE discovery pass stores the day's filings and never repeats", async () => {
    arm(et("20:30"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    edgar.filings.push(companion("0000123456-26-000102", "PRE 14C", "161200"));
    await tick(et("20:31"));
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("manual_only");
    expect(s.pollDetail).toBe(MANUAL_ONLY_DETAIL);
    expect(s.catchupDone).toBe(true);
    const filings = listFilings(db, eventId);
    expect(filings.map((f) => [f.role, f.identityVerdict])).toEqual([
      ["earnings", "accepted"],
      ["companion", "accepted"],
    ]);
    expect(listDocuments(db, filings[0].id).find((d) => d.docType === "EX-99.1")?.status).toBe("fetched");
    // Completion is recorded: the next ticks make no SEC request at all.
    const calls = edgar.calls.length;
    await tick(et("20:32"));
    await tick(et("10:00", "2026-10-22"));
    expect(edgar.calls.length).toBe(calls);
  });

  it("C1: with the real runner callbacks the discovery creates no run, Run summary is offered, and the run action starts it", async () => {
    setModelCatalogSource(() => ["claude-opus-5-5"]);
    try {
      arm(et("20:30"));
      edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
      clock = et("20:31");
      await runTick(db, clock, {
        ...seams(),
        onEarningsAccepted: (d, id) => runnerOnEarningsAccepted(d, id),
        onCompanionAccepted: (d, id, filingId) => runnerOnCompanionAccepted(d, id, filingId),
        ensureAutoRun: (d, id) => runnerEnsureAutoRun(d, id, clock),
      });
      expect(getEventState(db, eventId)!.pollState).toBe("manual_only");
      expect(listRuns(db, eventId)).toEqual([]);
      const panel = getPanelViews(db, [eventId], ["claude-opus-5-5"], new Date(clock))[eventId];
      expect(panel.runSummaryAvailable).toBe(true);
      expect(panel.pollState).toBe("manual_only");

      const kicked: number[] = [];
      const res = applyFilingSummaryAction(
        db,
        { eventId, action: "run", requestKey: "rk-late-arm" },
        { kick: (_d, id) => kicked.push(id), catalogIds: () => ["claude-opus-5-5"] },
      );
      expect(res.ok).toBe(true);
      const runs = listRuns(db, eventId);
      expect(runs).toHaveLength(1);
      expect(runs[0].trigger).toBe("manual_run");
      expect(kicked).toEqual([eventId]);
    } finally {
      setModelCatalogSource(null);
    }
  });

  it("C1: a discovery pass that could not finish (SEC down) stays manual_only and is tried again", async () => {
    arm(et("20:30"));
    edgar.submissionsFail = true;
    await tick(et("20:31"));
    let s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("manual_only");
    expect(s.catchupDone).toBe(false);
    edgar.submissionsFail = false;
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("10:00", "2026-10-24")); // outside today/yesterday: still visited
    s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("manual_only");
    expect(s.catchupDone).toBe(true);
    expect(listFilings(db, eventId)).toHaveLength(1);
  });

  it("C1: a discovery that finds no earnings filing says so and stays manual_only", async () => {
    arm(et("20:30"));
    await tick(et("20:31"));
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("manual_only");
    expect(s.pollDetail).toBe("armed after 8 pm — no earnings 8-K filed by 8 pm");
    expect(s.catchupDone).toBe(true);
  });

  it("C1: a past print armed days later goes through the same discovery path", async () => {
    arm(et("11:00", "2026-10-26"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    const t = await tick(et("11:01", "2026-10-26"));
    expect(t.polled).toEqual([eventId]);
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("manual_only");
    expect(s.catchupDone).toBe(true);
    expect(listFilings(db, eventId).map((f) => f.identityVerdict)).toEqual(["accepted"]);
    expect(earningsCalls).toEqual([eventId]); // the runner refuses manual_only: no run
  });

  it("follow-up 1: armed Monday for a Wednesday print, app first ticks Friday → discovered as manual, no run, Run summary offered", async () => {
    setModelCatalogSource(() => ["claude-opus-5-5"]);
    try {
      arm(et("10:00", "2026-10-19")); // Monday, before the print
      edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
      clock = et("11:00", "2026-10-23"); // Friday: the print (Wednesday) is before yesterday
      const t = await runTick(db, clock, {
        ...seams(),
        onEarningsAccepted: (d, id) => runnerOnEarningsAccepted(d, id),
        onCompanionAccepted: (d, id, filingId) => runnerOnCompanionAccepted(d, id, filingId),
        ensureAutoRun: (d, id) => runnerEnsureAutoRun(d, id, clock),
      });
      expect(t.polled).toEqual([eventId]);
      const s = getEventState(db, eventId)!;
      expect(s.pollState).toBe("manual_only");
      expect(s.catchupDone).toBe(true);
      expect(s.pollDetail).toBe("not polled on the print day — Run summary to spend");
      expect(listFilings(db, eventId).map((f) => f.identityVerdict)).toEqual(["accepted"]);
      expect(listRuns(db, eventId)).toEqual([]); // no paid run without a click
      const panel = getPanelViews(db, [eventId], ["claude-opus-5-5"], new Date(clock))[eventId];
      expect(panel.runSummaryAvailable).toBe(true);
      expect(panel.pastWithoutSummary).toBe(false);
      // A later tick neither looks again nor starts anything.
      const calls = edgar.calls.length;
      await runTick(db, et("11:01", "2026-10-23"), { ...seams(), onEarningsAccepted: (d, id) => runnerOnEarningsAccepted(d, id) });
      expect(edgar.calls.length).toBe(calls);
      expect(listRuns(db, eventId)).toEqual([]);
    } finally {
      setModelCatalogSource(null);
    }
  });

  it("armed at 15:00 but first seen at 21:30 (app asleep) still gets its catch-up", async () => {
    arm(et("15:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("21:30"));
    expect(getEventState(db, eventId)!.pollState).toBe("past_cutoff");
    expect(earningsCalls).toEqual([eventId]);
  });

  it("armed late on the day before's print (event dated yesterday, armed today) → manual_only, discovered once", async () => {
    arm(et("10:00", "2026-10-22"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("10:01", "2026-10-22"));
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("manual_only");
    expect(s.catchupDone).toBe(true);
    expect(listFilings(db, eventId)).toHaveLength(1);
    expect(earningsCalls).toEqual([eventId]);
  });

  it("gate failure (issuer not named) → filing and event ambiguous, nothing run", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500", EX99_WRONG_ISSUER));
    await tick(et("16:06"));
    const [f] = listFilings(db, eventId);
    expect(f.identityVerdict).toBe("ambiguous");
    expect(f.identityReason).toMatch(/issuer not named/);
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("ambiguous");
    expect(s.pollDetail).toMatch(/issuer not named/);
    expect(earningsCalls).toEqual([]);
  });

  it("a non-text document is recorded failed with a short reason; the filing is failed but still accepted", async () => {
    arm(et("09:00"));
    const f = earnings8k("0000123456-26-000101", "160500");
    f.docs.push({ type: "EX-99.2", seq: 4, file: "acme-ex992.htm", contentType: "application/pdf", body: "secret" });
    f.docs.push({ type: "EX-10.1", seq: 5, file: "acme-ex101.htm", status: 404 });
    edgar.filings.push(f);
    await tick(et("16:06"));
    const [row] = listFilings(db, eventId);
    expect(row.identityVerdict).toBe("accepted");
    expect(row.fetchState).toBe("failed");
    const docs = listDocuments(db, row.id);
    expect(docs.find((d) => d.fileName === "acme-ex992.htm")).toMatchObject({
      status: "failed",
      skipReason: "not a text document",
    });
    expect(docs.find((d) => d.fileName === "acme-ex101.htm")).toMatchObject({
      status: "failed",
      skipReason: "HTTP 404",
    });
  });

  it("ruling 3: a foreign filer's 6-K/A after its earnings 6-K is a companion", async () => {
    arm(et("09:00"));
    edgar.filings.push({ ...companion("0000123456-26-000050", "20-F", "090000"), json: "2026-03-01T09:00:00.000Z" });
    edgar.filings.push({
      accession: "0000123456-26-000101",
      form: "6-K",
      json: "2026-10-21T07:00:00.000Z",
      header: "20261021070000",
      docs: [
        { type: "6-K", seq: 1, file: "acme-6k.htm" },
        { type: "EX-99.1", seq: 2, file: "acme-6k-ex991.htm", body: EX99_GOOD },
      ],
    });
    edgar.filings.push(companion("0000123456-26-000102", "6-K/A", "093000"));
    await tick(et("09:31"));
    const filings = listFilings(db, eventId);
    expect(filings.map((f) => [f.form, f.role, f.identityVerdict])).toEqual([
      ["6-K", "earnings", "accepted"],
      ["6-K/A", "companion", "accepted"],
    ]);
    expect(companionCalls).toEqual([[eventId, filings[1].id]]);
  });

  it("pollEvent on an unknown event does nothing", async () => {
    const out = await pollEvent(db, 99_999, et("16:00"), seams() as PollSeams);
    expect(out.action).toBe("skipped");
    expect(edgar.calls).toEqual([]);
  });
});

describe("runTick: disarm, re-arm, runner, sweep", () => {
  function seedRun(): number {
    const [f] = listFilings(db, eventId);
    return createRun(db, {
      eventId,
      trigger: "auto",
      choice: { family: "opus", effort: "high" },
      modelId: null,
      fallbackNote: null,
      requestKey: null,
      bogeySnapshotJson: "{}",
      filingIds: [f.id],
    }).runId;
  }

  it("disarm → cancelled and pending sections failed/cancelled; re-arm before 20:00 → waiting, run kept, no new run", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    const runId = seedRun();

    disarm();
    const t = await tick(et("16:30"));
    expect(t.cancelled).toEqual([eventId]);
    expect(getEventState(db, eventId)!.pollState).toBe("cancelled");
    const [sec] = listSections(db, runId);
    expect(sec).toMatchObject({ status: "failed", errorClass: "cancelled" });
    expect(listRuns(db, eventId)[0].status).toBe("failed");
    expect(runCalls).toEqual([]); // the run was seeded after 16:06; the cancel starts nothing

    arm(et("17:00"));
    const before = edgar.calls.length;
    const t2 = await tick(et("17:01"));
    expect(t2.rearmed).toEqual([eventId]);
    expect(getEventState(db, eventId)!.pollState).toBe("found");
    expect(edgar.calls.length).toBeGreaterThan(before); // polling resumed
    expect(listRuns(db, eventId)).toHaveLength(1);
    expect(earningsCalls).toEqual([eventId]); // not called again for the same filing
  });

  it("re-armed after 20:00 the cancelled event becomes manual_only", async () => {
    arm(et("09:00"));
    await tick(et("15:00"));
    disarm();
    await tick(et("16:00"));
    arm(et("20:15"));
    await tick(et("20:16"));
    expect(getEventState(db, eventId)!.pollState).toBe("manual_only");
  });

  it("runs one section per event with work, and none for a cancelled event", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    const runId = seedRun();
    runCalls = [];
    await tick(et("16:07"));
    expect(runCalls).toEqual([eventId]);

    // A section still running when the owner disarms finishes on its own;
    // the tick starts nothing more for the cancelled event.
    claimNextSection(db, eventId, "tok", et("16:08"));
    disarm();
    runCalls = [];
    await tick(et("16:09"));
    await tick(et("16:30"));
    expect(runCalls).toEqual([]);
    expect(listSections(db, runId)[0].status).toBe("running");
  });

  it("never overlaps itself", async () => {
    arm(et("09:00"));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: FetchLike = async (url, init) => {
      await gate;
      return edgar.fetchFn(url, init);
    };
    clock = et("15:00");
    const first = runTick(db, clock, { ...seams(), fetchFn: slow });
    const second = await runTick(db, clock, seams());
    expect(second.skipped).toBe(true);
    release();
    expect((await first).skipped).toBe(false);
  });

  it("sweeps pushes left sending to delivery_unknown once per process", async () => {
    beginPush(db, "k1", eventId, "t", "m");
    markPush(db, "k1", "sending");
    await tick(et("15:00"));
    const state = () =>
      (db.prepare(`SELECT state FROM filing_summary_pushes WHERE push_key = 'k1'`).get() as { state: string }).state;
    expect(state()).toBe("delivery_unknown");
    markPush(db, "k1", "sending");
    await tick(et("15:01"));
    expect(state()).toBe("sending");
  });
});

describe("fix round 1", () => {
  function seedEventOn(date: string, key: string, symbol = "ACME"): number {
    return Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
           VALUES ('finnhub','earnings',?, 'earnings', ?, ?)`,
        )
        .run(date, key, symbol).lastInsertRowid,
    );
  }
  function runFor(id: number, filingIds: number[]): number {
    return createRun(db, {
      eventId: id,
      trigger: "auto",
      choice: { family: "opus", effort: "high" },
      modelId: null,
      fallbackNote: null,
      requestKey: null,
      bogeySnapshotJson: "{}",
      filingIds,
    }).runId;
  }

  it("Hardening 2: a merge onto a new date rejects the old-date filing, fails its pending section, and the new date is polled again", async () => {
    const donor = seedEventOn("2026-10-20", "fs-poll-donor");
    arm(et("09:00", "2026-10-20"), donor);
    edgar.filings.push(earnings8k("0000123456-26-000090", "160500", EX99_GOOD, "20261020"));
    await tick(et("16:06", "2026-10-20"));
    const [old] = listFilings(db, donor);
    expect(old.identityVerdict).toBe("accepted");
    const runId = runFor(donor, [old.id]);

    // Date correction: the donor folds into the 2026-10-21 event.
    db.transaction(() => {
      mergeFilingSummaryState({ db, donorEventId: donor, targetEventId: eventId });
      db.prepare(`UPDATE earnings_worksheet_flags SET event_id = ? WHERE event_id = ?`).run(eventId, donor);
      db.prepare(`DELETE FROM calendar_events WHERE id = ?`).run(donor);
    })();

    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    const t = await tick(et("16:06"));
    expect(t.revalidated).toEqual([eventId]);

    const filings = listFilings(db, eventId);
    expect(filings.map((f) => [f.accession, f.identityVerdict, f.identityReason])).toEqual([
      ["0000123456-26-000090", "rejected", EVENT_DATE_CHANGED_REASON],
      ["0000123456-26-000101", "accepted", null],
    ]);
    expect(listSections(db, runId)[0]).toMatchObject({ status: "failed", errorClass: "cancelled" });
    expect(listRuns(db, eventId)[0].status).toBe("failed");
    expect(getEventState(db, eventId)!.pollState).toBe("found");
    expect(earningsCalls).toEqual([donor, eventId]);
  });

  it("Hardening 2: a symbol change rejects the earnings filing and its companion as 'issuer changed' and resets the event", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    edgar.filings.push(companion("0000123456-26-000102", "PRE 14C", "161200"));
    await tick(et("16:13"));
    expect(getEventState(db, eventId)!.pollState).toBe("found");

    db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('ZETA', 'Zeta Corp', 'Stock')`).run();
    db.prepare(`UPDATE calendar_events SET symbol = 'ZETA' WHERE id = ?`).run(eventId);
    let cikAsked = 0;
    clock = et("16:20");
    await runTick(db, clock, {
      ...seams(),
      resolveCik: async () => {
        cikAsked += 1;
        return CIK;
      },
    });
    const filings = listFilings(db, eventId);
    expect(filings.map((f) => [f.form, f.identityVerdict, f.identityReason])).toEqual([
      ["8-K", "rejected", ISSUER_CHANGED_REASON],
      ["PRE 14C", "rejected", ISSUER_CHANGED_REASON],
    ]);
    expect(cikAsked).toBe(1); // the CIK was cleared and resolved again
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("waiting");
    expect(s.catchupDone).toBe(false);
  });

  it("an unchanged event is not re-gated every tick (no document reads after the first check)", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    const [f] = listFilings(db, eventId);
    const ex = listDocuments(db, f.id).find((d) => d.fileName === "acme-ex991.htm")!;
    await tick(et("16:07"));
    fs.rmSync(ex.storedPath!); // a re-gate now would reject for missing text
    await tick(et("16:08"));
    expect(listFilings(db, eventId)[0].identityVerdict).toBe("accepted");
  });

  it("only one live earnings row: a time-unconfirmed 8-K seen first becomes a companion once a timed one is accepted", async () => {
    arm(et("09:00"));
    edgar.filings.push({ ...earnings8k("0000123456-26-000100", "160000"), header: null });
    await tick(et("16:01"));
    expect(listFilings(db, eventId)[0]).toMatchObject({ role: "earnings", identityVerdict: "time_unconfirmed" });
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    const filings = listFilings(db, eventId);
    expect(filings.map((f) => [f.accession, f.role, f.identityVerdict])).toEqual([
      ["0000123456-26-000100", "companion", "time_unconfirmed"],
      ["0000123456-26-000101", "earnings", "accepted"],
    ]);
    expect(filings.filter((f) => f.role === "earnings" && f.identityVerdict !== "rejected")).toHaveLength(1);
    expect(earningsCalls).toEqual([eventId]);
  });

  it("midnight: yesterday's event ticked at 00:30 Eastern still runs its catch-up", async () => {
    arm(et("09:00"));
    await tick(et("15:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("00:30", "2026-10-22"));
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("past_cutoff");
    expect(s.catchupDone).toBe(true);
    expect(earningsCalls).toEqual([eventId]);
  });

  it("re-arm reads the flag's created_at: armed again at 19:50, first ticked at 20:05 → catch-up, not manual_only", async () => {
    arm(et("09:00"));
    await tick(et("15:00"));
    disarm();
    await tick(et("16:00"));
    arm(et("19:50"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("20:05"));
    expect(getEventState(db, eventId)!.pollState).toBe("past_cutoff");
    expect(earningsCalls).toEqual([eventId]);
  });

  it("ruling 8: an old print disarmed later keeps its state and its pending sections", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    const [f] = listFilings(db, eventId);
    const runId = runFor(eventId, [f.id]);
    disarm();
    const t = await tick(et("10:00", "2026-10-23"));
    expect(t.cancelled).toEqual([]);
    expect(getEventState(db, eventId)!.pollState).toBe("found");
    expect(listSections(db, runId)[0].status).toBe("pending");
  });

  it("the tick timer lives on globalThis: a re-evaluated module does not start a second one", async () => {
    enableFilingSummaryTick();
    const noop = async () => {};
    expect(startFilingSummaryTick(db, noop)).toBe(true);
    expect(startFilingSummaryTick(db, noop)).toBe(false);
    vi.resetModules();
    const fresh = await import("@/lib/filing-summary/tick");
    expect(fresh.startFilingSummaryTick(db, noop)).toBe(false);
    __resetFilingSummaryTickForTests();
  });
});

describe("fix round 3: the document gate covers an untimed earnings filing (Hardening 1)", () => {
  const untimed = (accession: string, ex99 = EX99_GOOD): FakeFiling => ({
    ...earnings8k(accession, "160000", ex99),
    header: null,
  });

  it("gate pass: stays time_unconfirmed with gate_passed, nothing runs automatically", async () => {
    arm(et("09:00"));
    edgar.filings.push(untimed("0000123456-26-000100"));
    await tick(et("16:01"));
    const [f] = listFilings(db, eventId);
    expect(f).toMatchObject({ role: "earnings", identityVerdict: "time_unconfirmed", gatePassed: true });
    expect(f.acceptedAt).toBeNull();
    expect(earningsCalls).toEqual([]);
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("waiting");
    expect(s.pollDetail).toBe("earnings 8-K time unconfirmed");
  });

  it("gate fail: ambiguous with the gate's reason, never runnable, and the event says why", async () => {
    arm(et("09:00"));
    edgar.filings.push(untimed("0000123456-26-000100", EX99_WRONG_ISSUER));
    await tick(et("16:01"));
    const [f] = listFilings(db, eventId);
    expect(f).toMatchObject({ role: "earnings", identityVerdict: "ambiguous", gatePassed: false });
    expect(f.identityReason).toMatch(/issuer not named/);
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("ambiguous");
    expect(s.pollDetail).toMatch(/issuer not named/);
    expect(earningsCalls).toEqual([]);
  });

  it("gate text not yet readable: the untimed filing is deferred, not stored", async () => {
    arm(et("09:00"));
    const f = untimed("0000123456-26-000100");
    f.docs = f.docs.map((d) => (d.type === "GRAPHIC" ? d : { ...d, status: 500 }));
    edgar.filings.push(f);
    await tick(et("16:01"));
    expect(listFilings(db, eventId)).toEqual([]);
  });

  it("a timed earnings filing demotes an earlier untimed row whose gate failed: one earnings reference", async () => {
    arm(et("09:00"));
    edgar.filings.push(untimed("0000123456-26-000100", EX99_WRONG_ISSUER));
    await tick(et("16:01"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    const filings = listFilings(db, eventId);
    expect(filings.map((f) => [f.accession, f.role, f.identityVerdict, f.gatePassed])).toEqual([
      ["0000123456-26-000100", "companion", "ambiguous", false],
      ["0000123456-26-000101", "earnings", "accepted", true],
    ]);
    expect(getEventState(db, eventId)!.pollState).toBe("found");
    expect(earningsCalls).toEqual([eventId]);
  });

  it("revalidation re-gates a gate-passed untimed earnings filing: an issuer change rejects it and resets the event", async () => {
    arm(et("09:00"));
    edgar.filings.push(untimed("0000123456-26-000100"));
    await tick(et("16:01"));
    expect(listFilings(db, eventId)[0]).toMatchObject({ identityVerdict: "time_unconfirmed", gatePassed: true });

    db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('ZETA', 'Zeta Corp', 'Stock')`).run();
    db.prepare(`UPDATE calendar_events SET symbol = 'ZETA' WHERE id = ?`).run(eventId);
    await tick(et("16:10"));
    const [f] = listFilings(db, eventId);
    expect(f.identityVerdict).toBe("rejected");
    expect(f.identityReason).toBe(ISSUER_CHANGED_REASON);
    const s = getEventState(db, eventId)!;
    // Reset to waiting (the same tick's poll then looks again from scratch).
    expect(s.pollState).toBe("waiting");
    expect(s.catchupDone).toBe(false);
  });
});

describe("final review fixes", () => {
  function seedEvent(date: string, key: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
           VALUES ('finnhub','earnings',?, 'earnings', ?, 'ACME')`,
        )
        .run(date, key).lastInsertRowid,
    );
  }
  function pendingRun(id: number): number {
    const [f] = listFilings(db, id);
    return createRun(db, {
      eventId: id,
      trigger: "auto",
      choice: { family: "opus", effort: "high" },
      modelId: null,
      fallbackNote: null,
      requestKey: null,
      bogeySnapshotJson: "{}",
      filingIds: [f.id],
    }).runId;
  }

  it("I2: while one runNextSection is pending, a second tick still polls other events", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    pendingRun(eventId);
    const other = seedEvent(EVENT_DATE, "fs-poll-other");
    arm(et("09:00"), other);

    let release!: () => void;
    let started!: () => void;
    const inCall = new Promise<void>((r) => (started = r));
    const hold = new Promise<void>((r) => (release = r));
    const calls: number[] = [];
    const slowRun: TickSeams["runNextSection"] = async (_d, id) => {
      calls.push(id);
      started();
      await hold;
    };
    clock = et("16:07");
    const first = runTick(db, clock, { ...seams(), runNextSection: slowRun });
    await inCall; // the first tick is inside the (long) model call

    clock = et("16:08");
    const second = await runTick(db, clock, { ...seams(), runNextSection: slowRun });
    expect(second.skipped).toBe(false);
    expect(second.polled).toEqual(expect.arrayContaining([eventId, other]));
    expect(second.inFlight).toEqual([eventId]); // not started twice
    expect(calls).toEqual([eventId]);

    release();
    const f = await first;
    expect(f.ran).toEqual([eventId]);
    // The run latch is free again: the next tick starts the event's next section.
    const third = await runTick(db, et("16:09"), { ...seams(), runNextSection: slowRun });
    expect(third.ran).toEqual([eventId]);
  });

  it("minor: an armed event left cancelled is re-armed whatever its date", async () => {
    // Re-armed (a new flag) days after the print; the state left from the disarm is cancelled.
    arm(et("09:59", "2026-10-25"));
    upsertEventState(db, eventId, { pollState: "cancelled", pollDetail: "disarmed — nothing new starts" });
    const t = await tick(et("10:00", "2026-10-25"));
    expect(t.rearmed).toEqual([eventId]);
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("manual_only");
    // Re-armed late with no stored filing: the one discovery pass ran.
    expect(s.catchupDone).toBe(true);
    expect(edgar.submissionsCalls()).toBe(1);
  });

  it("I3: a deleted stored file does not reject or reset anything; the detail says the copy is missing", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    const runId = pendingRun(eventId);
    await tick(et("21:00")); // catch-up done: past_cutoff
    expect(getEventState(db, eventId)!.pollState).toBe("past_cutoff");

    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root);
    __resetPollerCacheForTests(); // a restart: revalidation looks again
    const t = await tick(et("10:00", "2026-10-22"));
    expect(t.revalidated).toEqual([]);
    const [f] = listFilings(db, eventId);
    expect(f.identityVerdict).toBe("accepted");
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("past_cutoff");
    expect(s.cik).toBe(CIK);
    expect(s.pollDetail).toBe(STORED_COPY_MISSING_DETAIL);
    expect(listSections(db, runId)[0].status).toBe("pending");
  });

  it("I3: revalidation looks only at events dated within the last 14 days", async () => {
    const old = seedEvent("2026-10-01", "fs-poll-old");
    arm(et("09:00", "2026-10-01"), old);
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    // Move the stored filing under the old event: its acceptance day no longer matches.
    db.prepare(`UPDATE filing_summary_filings SET event_id = ? WHERE event_id = ?`).run(old, eventId);
    db.prepare(`INSERT OR IGNORE INTO filing_summary_events (event_id) VALUES (?)`).run(old);
    expect(eventsWithLiveFilings(db, "2026-10-21")).toEqual([]);
    expect(eventsWithLiveFilings(db, "2026-10-14")).toEqual([old]);
    const t = await tick(et("16:07"));
    expect(t.revalidated).toEqual([]);
    expect(listFilings(db, old)[0].identityVerdict).toBe("accepted");
  });

  it("I5: a runner that cannot be loaded is loud and visible on the panel; a later load clears it", async () => {
    arm(et("09:00"));
    await tick(et("15:00"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = await loadRunnerOrReport(db, et("15:01"), async () => {
        throw new Error("Cannot find module './runner'");
      });
      expect(failed).toBeNull();
      expect(errors).toHaveBeenCalled();
      const panel = getPanelViews(db, [eventId], [], new Date(et("15:01")))[eventId];
      expect(panel.pollDetail).toBe(RUNNER_LOAD_FAILED_DETAIL);
    } finally {
      errors.mockRestore();
    }
    const fake = { onEarningsAccepted() {}, onCompanionAccepted() {}, ensureAutoRun() {}, runNextSection: async () => "idle" };
    const ok = await loadRunnerOrReport(db, et("15:02"), async () => fake);
    expect(ok).toBe(fake);
    expect(getPanelViews(db, [eventId], [], new Date(et("15:02")))[eventId].pollDetail).toBeNull();
  });

  it("follow-up 2: the runner fault never overwrites a stored detail; the fault shows, then the stored detail comes back", async () => {
    arm(et("09:00"));
    const kept: Array<[string, string]> = [
      ["ambiguous", "the filing names Q2 2026, not this quarter"],
      ["no_cik", "no SEC filer found for ACME"],
      ["manual_only", "armed after 8 pm — no earnings 6-K filed by 8 pm"],
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [state, detail] of kept) {
        upsertEventState(db, eventId, { pollState: state as "ambiguous", pollDetail: detail, catchupDone: true });
        await loadRunnerOrReport(db, et("15:01"), async () => {
          throw new Error("load failed");
        });
        expect(getEventState(db, eventId)!.pollDetail).toBe(detail); // stored value untouched
        expect(getPanelViews(db, [eventId], [], new Date(et("15:01")))[eventId].pollDetail).toBe(RUNNER_LOAD_FAILED_DETAIL);
        const fake = { onEarningsAccepted() {}, onCompanionAccepted() {}, ensureAutoRun() {}, runNextSection: async () => "idle" };
        await loadRunnerOrReport(db, et("15:02"), async () => fake);
        expect(getPanelViews(db, [eventId], [], new Date(et("15:02")))[eventId].pollDetail).toBe(detail);
      }
    } finally {
      errors.mockRestore();
    }
  });

  it("follow-up 3: late-arm candidates rotate (oldest look first), so a failing batch cannot starve a sixth event", async () => {
    edgar.submissionsFail = true;
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = seedEvent("2026-10-15", `fs-poll-rot-${i}`);
      arm(et("21:00", "2026-10-15"), id);
      ids.push(id);
    }
    const t1 = await tick(et("10:00", "2026-10-23"));
    expect(t1.polled).toEqual(ids.slice(0, 5));
    const t2 = await tick(et("10:01", "2026-10-23"));
    expect(t2.polled[0]).toBe(ids[5]); // never looked at: first
    expect(t2.polled).toHaveLength(5);
  });

  it("follow-up 3: after 10 failed discovery passes the event stops and says Run summary is unavailable", async () => {
    edgar.submissionsFail = true;
    arm(et("21:00"));
    for (let i = 0; i < MAX_DISCOVERY_ATTEMPTS; i++) await tick(et(`10:0${i}`, "2026-10-23"));
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("manual_only");
    expect(s.catchupDone).toBe(true);
    expect(s.pollDetail).toBe(DISCOVERY_GAVE_UP_DETAIL);
    expect(edgar.submissionsCalls()).toBe(MAX_DISCOVERY_ATTEMPTS);
    await tick(et("10:30", "2026-10-23"));
    expect(edgar.submissionsCalls()).toBe(MAX_DISCOVERY_ATTEMPTS);
    const panel = getPanelViews(db, [eventId], [], new Date(et("10:30", "2026-10-23")))[eventId];
    expect(pollStateText(panel)).toBe(DISCOVERY_GAVE_UP_DETAIL);
  });

  it("follow-up 4: a print left waiting when its date leaves the window resolves to past_cutoff, no fetch, no run", async () => {
    arm(et("09:00"));
    await tick(et("15:00")); // waiting, looked at once; then the app is off
    const calls = edgar.calls.length;
    await tick(et("10:00", "2026-10-23"));
    expect(edgar.calls.length).toBe(calls);
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("past_cutoff");
    expect(s.catchupDone).toBe(true);
    const panel = getPanelViews(db, [eventId], [], new Date(et("10:00", "2026-10-23")))[eventId];
    expect(pollStateText(panel)).toBe("Polling stopped before 8 pm (the app was not running) — nothing more will run on its own");
    expect(needsPolling(panel)).toBe(false);
  });

  it("follow-up 4: a found print past the window resolves to past_cutoff with the normal line and starts no run", async () => {
    arm(et("09:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("16:06"));
    expect(getEventState(db, eventId)!.pollState).toBe("found");
    const calls = edgar.calls.length;
    const asked: number[] = [];
    await runTick(db, et("10:00", "2026-10-23"), { ...seams(), ensureAutoRun: (_d, id) => asked.push(id) });
    expect(edgar.calls.length).toBe(calls);
    expect(asked).toEqual([]);
    expect(earningsCalls).toEqual([eventId]); // only the original acceptance
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("past_cutoff");
    const panel = getPanelViews(db, [eventId], [], new Date(et("10:00", "2026-10-23")))[eventId];
    expect(pollStateText(panel)).toBe("Polling ended at 8 pm — Run summary to start");
    expect(needsPolling(panel)).toBe(false);
  });

  it("minor: the tick asks the runner to retry an automatic start for each armed event in the window", async () => {
    arm(et("09:00"));
    const asked: number[] = [];
    clock = et("15:00");
    await runTick(db, clock, { ...seams(), ensureAutoRun: (_d, id) => asked.push(id) });
    expect(asked).toEqual([eventId]);
  });
});
