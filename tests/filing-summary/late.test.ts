/**
 * The late periodic report (migration 100; spec
 * docs/superpowers/specs/2026-10-29-late-periodic-report-design.md): the
 * 10-Q / 10-K an issuer files after the print night, found by a narrow late
 * watch and read as a follow-up section that never touches the evening
 * summary. Migrated in-memory DB, fake clock, fake EDGAR, fake model call.
 * Every fixture is SYNTHETIC: made-up CIKs, accessions, company and figures.
 *
 * Event: ACME prints after the close on Wednesday 2026-10-28 (EDT, so
 * Eastern = UTC - 4h); the next trading day is Thursday 2026-10-29.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import type { FetchLike } from "@/lib/print-watch/hardened-fetch";
import { __resetPollerCacheForTests, AFTER_CUTOFF_REASON, issuerNameForEvent } from "@/lib/filing-summary/poller";
import { __resetFilingSummaryTickForTests, runTick } from "@/lib/filing-summary/tick";
import {
  ensureLateWatch,
  inLatePollHours,
  lateWindowEndsAt,
  lookAgainLate,
  periodMatchesPrint,
  pollLateFiling,
  runLateTick,
  type LatePollSeams,
} from "@/lib/filing-summary/late";
import { ensureLateRun, runNextSection, startLateRun, startRun, type RunnerSeams } from "@/lib/filing-summary/runner";
import {
  claimNextSection,
  createRun,
  finalizeSection,
  getLateWatch,
  getRunById,
  insertFiling,
  listFilings,
  listLateFilings,
  listLateRuns,
  listRuns,
  listSections,
  upsertDocument,
  upsertEventState,
  type NewFiling,
} from "@/lib/filing-summary/store";
import { getFullView, getPanelViews } from "@/lib/filing-summary/view";
import { renderSharePage } from "@/lib/filing-summary/share-page";
import { sendSummaryPushIfDue } from "@/lib/filing-summary/push";
import { applyFilingSummaryAction, applyFilingSummaryActionAsync } from "@/lib/filing-summary/actions";
import { mergeFilingSummaryState } from "@/lib/filing-summary/merge";
import { AI_UNAVAILABLE_REASON_PREFIX } from "@/lib/earnings/ai-unavailable";
import { ANTHROPIC_FAILURES, errorFromRealSdk } from "../helpers/ai-sdk-real-errors";
import { bogey } from "./evaluate-helpers";
import { buildSectionPrompt } from "@/lib/filing-summary/prompt";

const CIK = "0000123456";
const CIK_NUM = "123456";
const OTHER_CIK = "0000999999";
const EVENT_DATE = "2026-10-28";
const NEXT_DAY = "2026-10-29";
const SUBMISSIONS = (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`;
const CATALOG = ["claude-opus-5-5", "claude-sonnet-5-5"];
const MIN = 60_000;
const FIXTURE_HTML = fs.readFileSync(path.join(__dirname, "../fixtures/filing-summary/synthetic-q3-exhibit.htm"), "utf8");

/** UTC instant of an Eastern (EDT) wall time. */
function et(hhmm: string, day = EVENT_DATE): number {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.parse(`${day}T00:00:00Z`) + (h + 4) * 3_600_000 + m * 60_000;
}
/** `YYYYMMDDHHMMSS` Eastern header stamp. */
function stamp(hhmm: string, day = EVENT_DATE): string {
  return `${day.replace(/-/g, "")}${hhmm.replace(":", "")}00`;
}

// ---------------------------------------------------------------- fake EDGAR

interface FakeFiling {
  cik: string;
  accession: string;
  form: string;
  /** Header ACCEPTANCE-DATETIME (YYYYMMDDHHMMSS, Eastern). */
  header: string;
  /** Submissions JSON acceptanceDateTime (the bogus-Z Eastern reading). */
  json: string;
  period: string | null;
}

class FakeEdgar {
  filings: FakeFiling[] = [];
  calls: string[] = [];
  submissionsFail = false;

  base(f: FakeFiling): string {
    return `https://www.sec.gov/Archives/edgar/data/${Number(f.cik)}/${f.accession.replace(/-/g, "")}`;
  }

  headerHtml(f: FakeFiling): string {
    const raw = [
      `<SEC-HEADER>${f.accession}.hdr.sgml`,
      `<ACCEPTANCE-DATETIME>${f.header}`,
      `<TYPE>${f.form}`,
      ...(f.period ? [`<PERIOD>${f.period}`] : []),
    ].join("\n");
    const docs = [
      ["&lt;DOCUMENT&gt;", `&lt;TYPE&gt;${f.form}`, "&lt;SEQUENCE&gt;1", "&lt;FILENAME&gt;acme-10q.htm", "&lt;/DOCUMENT&gt;"].join("\n"),
      ["&lt;DOCUMENT&gt;", "&lt;TYPE&gt;EX-101.SCH", "&lt;SEQUENCE&gt;2", "&lt;FILENAME&gt;acme.xsd", "&lt;/DOCUMENT&gt;"].join("\n"),
    ].join("\n");
    return `<html><!-- ${raw} --><body><pre>${docs}</pre></body></html>`;
  }

  fetchFn: FetchLike = async (url) => {
    this.calls.push(url);
    for (const cik of [CIK, OTHER_CIK]) {
      if (url === SUBMISSIONS(cik)) {
        if (this.submissionsFail) return new Response("down", { status: 503, headers: { "content-type": "text/plain" } });
        const mine = this.filings.filter((f) => f.cik === cik);
        const recent = {
          form: ["8-K", ...mine.map((f) => f.form)],
          acceptanceDateTime: [`${EVENT_DATE}T16:05:00.000Z`, ...mine.map((f) => f.json)],
          accessionNumber: ["0000123456-26-000001", ...mine.map((f) => f.accession)],
        };
        return new Response(JSON.stringify({ filings: { recent } }), { headers: { "content-type": "application/json" } });
      }
    }
    for (const f of this.filings) {
      if (url === `${this.base(f)}/${f.accession}-index-headers.html`) {
        return new Response(this.headerHtml(f), { headers: { "content-type": "text/html" } });
      }
      if (url === `${this.base(f)}/acme-10q.htm`) {
        return new Response(FIXTURE_HTML, { headers: { "content-type": "text/html" } });
      }
    }
    throw new Error(`unmocked fetch: ${url}`);
  };

  headerCalls(): number {
    return this.calls.filter((u) => u.endsWith("-index-headers.html")).length;
  }
}

function tenQ(accession: string, hhmm: string, day = EVENT_DATE, over: Partial<FakeFiling> = {}): FakeFiling {
  return {
    cik: CIK,
    accession,
    form: "10-Q",
    header: stamp(hhmm, day),
    json: `${day}T${hhmm}:00.000Z`,
    period: "20260930",
    ...over,
  };
}

// ---------------------------------------------------------------- setup

let db: Database.Database;
let edgar: FakeEdgar;
let root: string;
let eventId: number;
let earningsId: number;
let started: Array<[number, number]>;
let files: Map<string, string>;

function seedEvent(date = EVENT_DATE, key = "fs-late-acme"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('finnhub','earnings',?, 'ACME earnings', ?, 'ACME')`,
      )
      .run(date, key).lastInsertRowid,
  );
}

function earningsFiling(over: Partial<NewFiling> = {}): NewFiling {
  return {
    eventId,
    accession: "0000123456-26-000001",
    cik: CIK,
    form: "8-K",
    role: "earnings",
    items: "2.02,9.01",
    acceptedAt: new Date(et("16:05")).toISOString(),
    discoveredAt: new Date(et("16:06")).toISOString(),
    identityVerdict: "accepted",
    identityReason: null,
    fetchState: "fetched",
    gatePassed: true,
    ...over,
  };
}

/** The evening state the late watch starts from: past cutoff, earnings 8-K accepted. */
function seedPastCutoff(id = eventId, date = EVENT_DATE): number {
  upsertEventState(db, id, { pollState: "past_cutoff", pollDetail: "polling ended at 9 pm", cik: CIK, catchupDone: true });
  const fid = insertFiling(db, earningsFiling({ eventId: id, acceptedAt: new Date(et("16:05", date)).toISOString() })).id;
  const p = `/virtual/${fid}/ex991.htm`;
  files.set(p, "<p>Acme Widgets Inc reported third quarter results. Revenue rose sharply.</p>");
  upsertDocument(db, {
    filingId: fid, fileName: "ex991.htm", docType: "EX-99.1", sequence: 2, status: "fetched",
    skipReason: null, sha256: null, byteLen: 10, storedPath: p,
  });
  return fid;
}

const EVENING_CHECKED = {
  headline: "Revenue beat the synthetic consensus",
  claims: [
    {
      claimId: "s1.c1", renderedText: "Revenue rose sharply in the quarter.", status: "qualitative", top: true, routine: false,
      footnotes: [], figureChecks: [], comparisonChecks: [], reasons: [], correction: null,
    },
  ],
  counts: { claims: 1, checked: 0, contradicted: 0, warning: 0, unconfirmed: 0, qualitative: 1 },
};

/** A finished evening run (one done earnings section) with the given bogey snapshot. */
function seedEveningRun(bogeySnapshotJson = "[]"): number {
  const { runId } = createRun(db, {
    eventId, trigger: "auto", choice: { family: "opus", effort: "high" }, modelId: "claude-opus-5-5",
    fallbackNote: null, requestKey: `auto:${eventId}:${earningsId}`, bogeySnapshotJson, filingIds: [earningsId],
  });
  const sec = claimNextSection(db, eventId, "evening-tok", et("16:10"));
  if (!sec) throw new Error("no evening section");
  finalizeSection(db, sec.id, "evening-tok", {
    status: "done", modelId: "claude-opus-5-5", effort: "high", inputFingerprint: "fp-evening",
    outputJson: JSON.stringify({ headline: EVENING_CHECKED.headline, bullets: [] }),
    checkedJson: JSON.stringify(EVENING_CHECKED), coverageJson: "[]", incomplete: false,
    countsJson: JSON.stringify(EVENING_CHECKED.counts), usageJson: "{}", versionsJson: "{}",
    errorClass: null, errorText: null,
  });
  return runId;
}

function seams(clock: () => number): LatePollSeams {
  return {
    fetchFn: edgar.fetchFn,
    now: clock,
    storageRoot: () => root,
    onLateFilingAccepted: (_d, id, filingId) => started.push([id, filingId]),
  };
}

async function tickAt(ms: number, today = EVENT_DATE) {
  return runLateTick(db, ms, seams(() => ms), today);
}

beforeEach(() => {
  __resetPollerCacheForTests();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('ACME', 'Acme Widgets Inc', 'Stock')`).run();
  eventId = seedEvent();
  edgar = new FakeEdgar();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-late-"));
  started = [];
  files = new Map();
  earningsId = seedPastCutoff();
  setModelCatalogSource(() => CATALOG);
});

afterEach(() => {
  setModelCatalogSource(null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- migration

describe("migration 100", () => {
  it("existing filing rows read arrival 'evening'; the CHECKs refuse other values", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fs-mig-"));
    try {
      const real = path.join(__dirname, "../../lib/db/migrations");
      for (const f of fs.readdirSync(real)) {
        if (f.endsWith(".sql") && !f.startsWith("100_")) fs.copyFileSync(path.join(real, f), path.join(tmp, f));
      }
      const old = new Database(":memory:");
      old.pragma("foreign_keys = ON");
      runMigrations(old, { migrationsDir: tmp });
      const ev = Number(
        old
          .prepare(`INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
                    VALUES ('finnhub','earnings','2026-10-28','X','k-old','ACME')`)
          .run().lastInsertRowid,
      );
      old.prepare(
        `INSERT INTO filing_summary_filings (event_id, accession, cik, form, role, discovered_at, discovery_seq, identity_verdict)
         VALUES (?, 'a-1', '1', '8-K', 'earnings', '2026-10-28T20:00:00Z', 1, 'accepted')`,
      ).run(ev);
      runMigrations(old);
      expect(old.prepare("SELECT arrival FROM filing_summary_filings").get()).toEqual({ arrival: "evening" });
      expect(() => old.prepare("UPDATE filing_summary_filings SET arrival = 'morning'").run()).toThrow();
      old.prepare("INSERT INTO filing_summary_events (event_id) VALUES (?)").run(ev);
      expect(() =>
        old.prepare("INSERT INTO filing_summary_late_watch (event_id, state, window_ends_at) VALUES (?, 'sleeping', 'x')").run(ev),
      ).toThrow();
      old.prepare("INSERT INTO filing_summary_late_watch (event_id, window_ends_at) VALUES (?, 'x')").run(ev);
      expect(old.prepare("SELECT state FROM filing_summary_late_watch").get()).toEqual({ state: "watching" });
      // The watch cascades with its event row.
      old.prepare("DELETE FROM filing_summary_events WHERE event_id = ?").run(ev);
      expect(old.prepare("SELECT COUNT(*) AS n FROM filing_summary_late_watch").get()).toEqual({ n: 0 });
      old.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- window

describe("the late window", () => {
  it("ends 16:00 Eastern on the next trading day: a Friday print waits for Monday, a holiday is skipped", () => {
    expect(lateWindowEndsAt(EVENT_DATE)).toBe("2026-10-29T20:00:00.000Z"); // Thu 16:00 EDT
    // Friday 2026-10-30 → Monday 2026-11-02 (EST after 2026-11-01): 16:00 EST = 21:00Z.
    expect(lateWindowEndsAt("2026-10-30")).toBe("2026-11-02T21:00:00.000Z");
    // Wednesday before Thanksgiving (2026-11-26 closed) → Friday 2026-11-27.
    expect(lateWindowEndsAt("2026-11-25")).toBe("2026-11-27T21:00:00.000Z");
  });

  it("polls the event evening after 21:00 and the next trading day from 06:00 to 16:00, nothing between", () => {
    expect(inLatePollHours(EVENT_DATE, et("20:59"))).toBe(false);
    expect(inLatePollHours(EVENT_DATE, et("21:00"))).toBe(true);
    expect(inLatePollHours(EVENT_DATE, et("23:50"))).toBe(true);
    expect(inLatePollHours(EVENT_DATE, et("05:59", NEXT_DAY))).toBe(false);
    expect(inLatePollHours(EVENT_DATE, et("06:00", NEXT_DAY))).toBe(true);
    expect(inLatePollHours(EVENT_DATE, et("15:59", NEXT_DAY))).toBe(true);
    expect(inLatePollHours(EVENT_DATE, et("16:00", NEXT_DAY))).toBe(false);
    // Friday print: Saturday and Sunday are never polled; Monday from 06:00 EST (11:00Z).
    expect(inLatePollHours("2026-10-30", Date.parse("2026-10-31T14:00:00Z"))).toBe(false);
    expect(inLatePollHours("2026-10-30", Date.parse("2026-11-01T15:00:00Z"))).toBe(false);
    expect(inLatePollHours("2026-10-30", Date.parse("2026-11-02T11:00:00Z"))).toBe(true);
  });

  it("a period end matches the print only when before it and at most 80 days earlier", () => {
    expect(periodMatchesPrint("2026-09-30", EVENT_DATE)).toBe(true);
    expect(periodMatchesPrint("2026-06-30", EVENT_DATE)).toBe(false);
    expect(periodMatchesPrint("2026-12-31", EVENT_DATE)).toBe(false);
    expect(periodMatchesPrint(null, EVENT_DATE)).toBe(false);
  });
});

// ---------------------------------------------------------------- the automatic watch

describe("the automatic late watch", () => {
  it("a 10-Q accepted at 21:05 on the event date is picked up by the next due tick", async () => {
    edgar.filings.push(tenQ("0000123456-26-000050", "21:05"));
    const first = await tickAt(et("21:10"));
    expect(first.opened).toEqual([eventId]);
    expect(first.polled).toEqual([eventId]);
    const late = listLateFilings(db, eventId);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ form: "10-Q", role: "companion", arrival: "late", identityVerdict: "accepted" });
    expect(late[0].acceptedAt).toBe(new Date(et("21:05")).toISOString());
    expect(started).toEqual([[eventId, late[0].id]]);
    expect(getLateWatch(db, eventId)?.state).toBe("found");
    // Never an evening filing.
    expect(listFilings(db, eventId).map((f) => f.accession)).toEqual(["0000123456-26-000001"]);
  });

  it("one accepted at 07:30 on the next trading day is picked up; the watch skips the night", async () => {
    await tickAt(et("21:10")); // opens, polls, nothing yet
    expect(getLateWatch(db, eventId)?.state).toBe("watching");
    edgar.filings.push(tenQ("0000123456-26-000051", "07:30", NEXT_DAY));
    const night = await tickAt(et("02:00", NEXT_DAY), NEXT_DAY);
    expect(night.polled).toEqual([]); // between 21:00 and 06:00 the next day: no poll
    const morning = await tickAt(et("07:40", NEXT_DAY), NEXT_DAY);
    expect(morning.polled).toEqual([eventId]);
    expect(listLateFilings(db, eventId).map((f) => f.accession)).toEqual(["0000123456-26-000051"]);
  });

  it("runs inside the 60-second filing-summary tick when the late callback is wired (production), never without it", async () => {
    __resetFilingSummaryTickForTests();
    db.prepare(`INSERT INTO earnings_worksheet_flags (event_id, created_at) VALUES (?, '2026-10-28 13:00:00')`).run(eventId);
    edgar.filings.push(tenQ("0000123456-26-000059", "21:05"));
    const base = {
      fetchFn: edgar.fetchFn,
      resolveCik: async () => CIK,
      now: () => et("21:10"),
      issuerName: issuerNameForEvent,
      onEarningsAccepted: () => {},
      onCompanionAccepted: () => {},
      storageRoot: () => root,
      runNextSection: async () => "idle",
    };
    const without = await runTick(db, et("21:10"), base);
    expect(without.latePolled).toEqual([]);
    expect(getLateWatch(db, eventId)).toBeNull();
    const withLate = await runTick(db, et("21:11"), {
      ...base,
      onLateFilingAccepted: (_d, id, filingId) => started.push([id, filingId]),
    });
    expect(withLate.latePolled).toEqual([eventId]);
    expect(started).toHaveLength(1);
    expect(listLateFilings(db, eventId).map((f) => f.accession)).toEqual(["0000123456-26-000059"]);
  });

  it("polls at most every 10 minutes", async () => {
    await tickAt(et("21:10"));
    expect((await tickAt(et("21:15"))).polled).toEqual([]);
    expect((await tickAt(et("21:20"))).polled).toEqual([eventId]);
  });

  it("one accepted at 16:01 on the next trading day is not picked up automatically; Look again finds it", async () => {
    edgar.filings.push(tenQ("0000123456-26-000052", "16:01", NEXT_DAY));
    await tickAt(et("15:55", NEXT_DAY), NEXT_DAY); // listed already: past the window's end, refused
    expect(listLateFilings(db, eventId)).toEqual([]);
    const after = await tickAt(et("16:05", NEXT_DAY), NEXT_DAY);
    expect(after.ended).toEqual([eventId]);
    expect(getLateWatch(db, eventId)?.state).toBe("ended");
    expect((await tickAt(et("16:20", NEXT_DAY), NEXT_DAY)).polled).toEqual([]);

    const res = await lookAgainLate(db, eventId, et("17:00", NEXT_DAY), seams(() => et("17:00", NEXT_DAY)));
    expect(res).toMatchObject({ ok: true, data: { found: true, form: "10-Q" } });
    expect(listLateFilings(db, eventId).map((f) => f.accession)).toEqual(["0000123456-26-000052"]);
  });

  it("Look again works after the window for a print that never had a watch row (it opens one, ended)", async () => {
    edgar.filings.push(tenQ("0000123456-26-000053", "09:00", "2026-11-03"));
    const now = Date.parse("2026-11-04T15:00:00Z");
    const res = await lookAgainLate(db, eventId, now, seams(() => now));
    expect(res).toMatchObject({ ok: true, data: { found: true, form: "10-Q" } });
    expect(getLateWatch(db, eventId)?.state).toBe("found");
    // The automatic watch would never have taken it: past its window.
  });

  it("never opens a watch when the window is over, for a disarmed print, or without an accepted earnings filing", async () => {
    expect(ensureLateWatch(db, eventId, et("16:00", NEXT_DAY))).toBe(false);
    upsertEventState(db, eventId, { pollState: "cancelled" });
    expect(ensureLateWatch(db, eventId, et("21:10"))).toBe(false);
    upsertEventState(db, eventId, { pollState: "past_cutoff" });
    db.prepare("UPDATE filing_summary_filings SET identity_verdict = 'ambiguous' WHERE id = ?").run(earningsId);
    expect(ensureLateWatch(db, eventId, et("21:10"))).toBe(false);
  });

  it("a disarm cancels the watch", async () => {
    await tickAt(et("21:10"));
    upsertEventState(db, eventId, { pollState: "cancelled" });
    await tickAt(et("21:30"));
    expect(getLateWatch(db, eventId)?.state).toBe("cancelled");
    const res = await lookAgainLate(db, eventId, et("21:40"), seams(() => et("21:40")));
    expect(res).toEqual({ ok: false, reason: "disarmed" });
  });
});

describe("what counts", () => {
  it("another period, an amendment, another CIK's report and a report from before the cutoff are ignored", async () => {
    edgar.filings.push(
      tenQ("0000123456-26-000060", "21:30", EVENT_DATE, { period: "20260630" }), // a prior quarter
      tenQ("0000123456-26-000061", "21:35", EVENT_DATE, { form: "10-Q/A" }), // an amendment
      tenQ("0000123456-26-000062", "22:00", EVENT_DATE, { form: "10-K/A" }),
      tenQ("0000999999-26-000063", "21:40", EVENT_DATE, { cik: OTHER_CIK }), // another filer
    );
    const res = await pollLateFiling(db, eventId, et("22:10"), seams(() => et("22:10")));
    expect(res).toEqual({ status: "none" });
    expect(listLateFilings(db, eventId)).toEqual([]);
    expect(edgar.calls.some((u) => u.includes(OTHER_CIK))).toBe(false);
    // The amendments never cost a header request; the prior-quarter one did.
    expect(edgar.headerCalls()).toBe(1);
  });

  it("an event whose stored CIK is not the earnings filing's has no watch", async () => {
    upsertEventState(db, eventId, { cik: OTHER_CIK });
    expect(await pollLateFiling(db, eventId, et("22:10"), seams(() => et("22:10")))).toEqual({
      status: "not_eligible",
      reason: "no_watch_basis",
    });
  });

  it("decides on the header time, not the JSON: a JSON stamp after the 8-K but a header before it is ignored", async () => {
    // (c) accepted before the earnings filing (16:05): never the late report.
    edgar.filings.push(tenQ("0000123456-26-000064", "15:30", EVENT_DATE, { json: `${EVENT_DATE}T16:30:00.000Z` }));
    expect(await pollLateFiling(db, eventId, et("22:10"), seams(() => et("22:10")))).toEqual({ status: "none" });
    expect(listLateFilings(db, eventId)).toEqual([]);
  });

  it("SEC listing lag: a 10-Q accepted 20:29 that the evening catch-up never saw is picked up by the automatic watch", async () => {
    // (a) The submissions list did not show it at the 21:00 catch-up; it is listed by the first late poll.
    edgar.filings.push(tenQ("0000123456-26-000068", "20:29"));
    const t = await tickAt(et("21:10"));
    expect(t.polled).toEqual([eventId]);
    const late = listLateFilings(db, eventId);
    expect(late.map((f) => [f.accession, f.arrival, f.identityVerdict])).toEqual([["0000123456-26-000068", "late", "accepted"]]);
    expect(late[0].acceptedAt).toBe(new Date(et("20:29")).toISOString());
    expect(started).toEqual([[eventId, late[0].id]]);
    expect(listFilings(db, eventId).map((f) => f.accession)).toEqual(["0000123456-26-000001"]);
  });

  it("SEC listing lag: the same 20:29 10-Q is found by Look again the next day, after the window", async () => {
    edgar.filings.push(tenQ("0000123456-26-000069", "20:29"));
    const now = et("18:00", NEXT_DAY);
    const res = await lookAgainLate(db, eventId, now, seams(() => now));
    expect(res).toMatchObject({ ok: true, data: { found: true, form: "10-Q" } });
    expect(listLateFilings(db, eventId).map((f) => f.accession)).toEqual(["0000123456-26-000069"]);
  });

  it("a 10-K at fiscal year end counts like a 10-Q", async () => {
    edgar.filings.push(tenQ("0000123456-26-000065", "08:00", NEXT_DAY, { form: "10-K", period: "20260930" }));
    const res = await pollLateFiling(db, eventId, et("08:10", NEXT_DAY), seams(() => et("08:10", NEXT_DAY)));
    expect(res).toMatchObject({ status: "found", form: "10-K" });
  });

  it("a 10-Q the evening read as a companion is never stored twice", async () => {
    insertFiling(db, earningsFiling({
      accession: "0000123456-26-000066", form: "10-Q", role: "companion", items: null,
      acceptedAt: new Date(et("18:00")).toISOString(),
    }));
    edgar.filings.push(tenQ("0000123456-26-000066", "18:00"));
    expect(await pollLateFiling(db, eventId, et("22:10"), seams(() => et("22:10")))).toEqual({ status: "none" });
    const now = et("18:00", NEXT_DAY);
    expect(await lookAgainLate(db, eventId, now, seams(() => now))).toMatchObject({ ok: true, data: { found: false } });
    expect(listLateFilings(db, eventId)).toEqual([]);
    expect(started).toEqual([]);
  });

  it("a 10-Q the evening catch-up stored as 'accepted after 9 pm' moves to late, with its id", async () => {
    const { id } = insertFiling(db, earningsFiling({
      accession: "0000123456-26-000067", form: "10-Q", role: "companion", items: null,
      acceptedAt: new Date(et("21:05")).toISOString(), identityVerdict: "rejected", identityReason: AFTER_CUTOFF_REASON,
    }));
    edgar.filings.push(tenQ("0000123456-26-000067", "21:05"));
    const res = await pollLateFiling(db, eventId, et("21:30"), seams(() => et("21:30")));
    expect(res).toMatchObject({ status: "found", filingId: id });
    expect(listLateFilings(db, eventId)[0]).toMatchObject({ id, arrival: "late", identityVerdict: "accepted" });
    expect(listFilings(db, eventId).some((f) => f.id === id)).toBe(false);
  });

  it("SEC down is reported, never 'no report'", async () => {
    edgar.submissionsFail = true;
    expect(await pollLateFiling(db, eventId, et("22:10"), seams(() => et("22:10")))).toEqual({ status: "sec_unreachable" });
  });
});

// ---------------------------------------------------------------- the follow-up run

type GenArgs = Parameters<RunnerSeams["generate"]>;
const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

function runnerSeams(generate: (...a: GenArgs) => Promise<unknown>) {
  const gen = vi.fn(generate);
  const onSectionDone = vi.fn(async () => {});
  let n = 0;
  const s: Partial<RunnerSeams> = {
    generate: gen as unknown as RunnerSeams["generate"],
    readDocument: (p: string) => files.get(p) ?? (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null),
    now: () => et("08:00", NEXT_DAY),
    token: () => `late-tok-${++n}`,
    onSectionDone,
  };
  return { s, gen, onSectionDone };
}

/** Stores the late 10-Q (fixture exhibit as its document) and starts its run. */
async function seedLateFilingAndRun(): Promise<{ filingId: number; runId: number }> {
  edgar.filings.push(tenQ("0000123456-26-000070", "07:30", NEXT_DAY));
  const res = await pollLateFiling(db, eventId, et("07:40", NEXT_DAY), seams(() => et("07:40", NEXT_DAY)));
  if (res.status !== "found") throw new Error(`not found: ${res.status}`);
  const r = startLateRun(db, eventId, res.filingId, { catalogIds: CATALOG });
  if (!r.ok) throw new Error(r.reason);
  return { filingId: res.filingId, runId: r.runId };
}

const Q10 = "acme-10q.htm";
function lateOutput(claims: unknown[]) {
  return { headline: "The report details the segment split the call mentioned", bullets: claims.map((c, i) => ({ top: i === 0, routine: false, claims: [c] })) };
}

/** Every evening row of the event, as stored: the byte-identity witness. */
function eveningRows(): string {
  const runs = db.prepare("SELECT * FROM filing_summary_runs WHERE event_id = ? AND request_key NOT LIKE 'late:%' ORDER BY id").all(eventId);
  const sections = db
    .prepare(
      `SELECT s.* FROM filing_summary_sections s JOIN filing_summary_runs r ON r.id = s.run_id
        WHERE r.event_id = ? AND r.request_key NOT LIKE 'late:%' ORDER BY s.id`,
    )
    .all(eventId);
  const filings = db.prepare("SELECT * FROM filing_summary_filings WHERE event_id = ? AND arrival = 'evening' ORDER BY id").all(eventId);
  return JSON.stringify({ runs, sections, filings });
}

describe("the late follow-up run", () => {
  it("reads the report against the evening summary, writes its own run, and leaves every evening row byte-identical", async () => {
    const eveningRunId = seedEveningRun(JSON.stringify([bogey("b1.rev", 64.57e9)]));
    const before = eveningRows();
    const { runId } = await seedLateFilingAndRun();

    // Its own run, at the print's pinned choice, with the evening bogey snapshot.
    const run = getRunById(db, runId)!;
    expect(run).toMatchObject({ trigger: "auto", family: "opus", effort: "high", requestKey: `late:${eventId}:${listLateFilings(db, eventId)[0].id}` });
    expect(run.bogeySnapshotJson).toBe(getRunById(db, eveningRunId)!.bogeySnapshotJson);
    expect(listRuns(db, eventId).map((r) => r.id)).toEqual([eveningRunId]);
    expect(listLateRuns(db, eventId).map((r) => r.id)).toEqual([runId]);

    const { s, gen, onSectionDone } = runnerSeams(async () => ({
      object: lateOutput([
        {
          id: "c1", text: "The report says revenue rose in the quarter.",
          citations: [{ id: "q1", document: Q10, quote: "Revenue", isTableRow: false }],
          figures: [], comparisons: [], corrects: null,
        },
      ]),
      usage,
      finishReason: "stop",
    }));
    expect(await runNextSection(db, eventId, s)).toBe("ran");
    const call = gen.mock.calls[0][2] as { system: string; prompt: string };
    expect(call.system).toContain("LATE PERIODIC REPORT");
    expect(call.prompt).toContain("The evening summary of this print");
    expect(call.prompt).toContain("[s1.c1] Revenue rose sharply in the quarter.");
    expect(call.prompt).toContain("What does this report add to or change from the evening summary?");
    // In-app only: the push hook never runs for a late section.
    expect(onSectionDone).not.toHaveBeenCalled();
    const sec = listSections(db, runId)[0];
    expect(sec.status).toBe("done");
    expect(JSON.parse(sec.versionsJson!)).toMatchObject({ latePrompt: 1 });

    expect(eveningRows()).toBe(before);
    // Re-asking never starts a second run or touches the evening run.
    expect(startLateRun(db, eventId, sec.filingId, { catalogIds: CATALOG })).toMatchObject({ ok: true, created: false });
    ensureLateRun(db, eventId);
    expect(listLateRuns(db, eventId)).toHaveLength(1);
    expect(eveningRows()).toBe(before);
  });

  it("obeys R1 (a stray digit is 'figure not bound') and R9 (no Contradicted from an unestablished operand)", async () => {
    seedEveningRun(JSON.stringify([bogey("b5.x.eps", 7, { unit: "usd_per_share", basis: "non_gaap", label: "Adjusted EPS" })]));
    const { runId } = await seedLateFilingAndRun();
    const fig = (over: Record<string, unknown>) => ({
      id: "f1", valueText: "", value: 0, unit: "usd", scale: "millions", metric: "", basis: "reported", basisNote: null,
      period: { kind: "quarter", role: "actual", endDate: "2026-09-30", fiscalYear: null, fiscalQuarter: null, anchor: null, label: "Q3 2026" },
      sourceKind: "quote", citationId: "q1", label: null, bogeyKey: null, operation: null, inputs: [], ...over,
    });
    const { s } = runnerSeams(async () => ({
      object: lateOutput([
        {
          id: "c1", text: "Revenue of {f1} rose 26%.",
          citations: [{ id: "q1", document: Q10, quote: "Revenue | 51,242", isTableRow: true }],
          figures: [fig({ valueText: "$51,242 million", value: 51242, metric: "revenue", label: "Revenue" })],
          comparisons: [], corrects: null,
        },
        {
          id: "c2", text: "Diluted EPS of {f2} was below the {f3} adjusted consensus.",
          citations: [{ id: "q2", document: Q10, quote: "Diluted | 7.25", isTableRow: true }],
          figures: [
            fig({ id: "f2", citationId: "q2", valueText: "$7.25", value: 7.25, unit: "usd_per_share", scale: "units", metric: "diluted EPS", label: "Diluted", basis: "non_gaap" }),
            fig({
              id: "f3", sourceKind: "bogey", citationId: null, bogeyKey: "b5.x.eps", valueText: "$7.00", value: 7, unit: "usd_per_share", scale: "units",
              period: { kind: "quarter", role: "actual", endDate: null, fiscalYear: null, fiscalQuarter: null, anchor: "reported_quarter", label: "this print's quarter" },
            }),
          ],
          comparisons: [{ left: "f2", leftHigh: null, right: "f3", rightHigh: null, relation: "below" }],
          corrects: null,
        },
      ]),
      usage,
      finishReason: "stop",
    }));
    expect(await runNextSection(db, eventId, s)).toBe("ran");
    const done = listSections(db, runId)[0];
    expect({ status: done.status, errorClass: done.errorClass }).toEqual({ status: "done", errorClass: null });
    const checked = JSON.parse(done.checkedJson!) as { claims: Array<{ status: string; reasons: Array<{ code: string }> }> };
    expect(checked.claims[0].status).toBe("figure_not_bound");
    expect(checked.claims[0].reasons.map((r) => r.code)).toContain("unbound_digit");
    // "below" is wrong on the numbers, but the EPS figure's basis is not established: never Contradicted.
    expect(checked.claims[1].status).toBe("unconfirmed");
    expect(checked.claims[1].reasons.map((r) => r.code)).toContain("basis_unconfirmed");
  });

  it("an AI account failure on the late run spends no attempt", async () => {
    seedEveningRun();
    const { runId } = await seedLateFilingAndRun();
    const err = (await errorFromRealSdk(ANTHROPIC_FAILURES.billing400, { maxRetries: 0 })).error;
    const { s } = runnerSeams(async () => {
      throw err;
    });
    for (let i = 0; i < 4; i++) expect(await runNextSection(db, eventId, s)).toBe("ran");
    const sec = listSections(db, runId)[0];
    expect(sec).toMatchObject({ status: "pending", attempts: 0, errorClass: "model_error" });
    expect(sec.errorText?.startsWith(AI_UNAVAILABLE_REASON_PREFIX)).toBe(true);
  });

  it("no callable model: nothing starts; ensureLateRun starts it once a model is back", async () => {
    seedEveningRun();
    edgar.filings.push(tenQ("0000123456-26-000071", "07:30", NEXT_DAY));
    const res = await pollLateFiling(db, eventId, et("07:40", NEXT_DAY), seams(() => et("07:40", NEXT_DAY)));
    expect(res.status).toBe("found");
    setModelCatalogSource(() => []);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    ensureLateRun(db, eventId);
    expect(listLateRuns(db, eventId)).toHaveLength(0);
    setModelCatalogSource(() => CATALOG);
    ensureLateRun(db, eventId);
    expect(listLateRuns(db, eventId)).toHaveLength(1);
  });
});

describe("the prompt", () => {
  const input = {
    symbol: "ACME", companyName: "Acme Widgets Inc", eventDate: EVENT_DATE,
    filing: { form: "10-Q", acceptedAtEt: "2026-10-29 07:30", role: "companion" as const },
    documents: [{ fileName: "acme-10q.htm", docType: "10-Q", text: "Revenue rose." }],
    bogeys: [],
    priorSections: [{ form: "8-K", headline: "Revenue beat", claimTexts: ["[s1.c1] Revenue rose."] }],
  };

  it("an evening section's prompt is unchanged: no late block, same text with or without an undefined arrival", () => {
    const evening = buildSectionPrompt(input);
    expect(evening.system).not.toContain("LATE PERIODIC REPORT");
    expect(evening.user).toContain("What does this companion filing add to the print?");
    expect(buildSectionPrompt({ ...input, arrival: undefined })).toEqual(evening);
  });

  it("a late section's prompt asks what the report adds, with the evening summary as context", () => {
    const late = buildSectionPrompt({ ...input, arrival: "late" });
    expect(late.system).toContain("LATE PERIODIC REPORT");
    expect(late.system).toContain("Do not write a second summary of the quarter.");
    expect(late.user).toContain("The evening summary of this print");
    expect(late.user).toContain("What does this report add to or change from the evening summary?");
    expect(late.fingerprint).not.toBe(buildSectionPrompt(input).fingerprint);
  });
});

// ---------------------------------------------------------------- evening readers never see it

describe("evening readers never see a late filing", () => {
  async function finishLate(): Promise<number> {
    seedEveningRun();
    const { runId } = await seedLateFilingAndRun();
    const { s } = runnerSeams(async () => ({
      object: lateOutput([
        { id: "c1", text: "The report adds a legal proceedings item.", citations: [{ id: "q1", document: Q10, quote: "Revenue", isTableRow: false }], figures: [], comparisons: [], corrects: null },
      ]),
      usage,
      finishReason: "stop",
    }));
    await runNextSection(db, eventId, s);
    return runId;
  }

  it("the full view keeps evening runs and filings separate; the late block carries the report", async () => {
    const lateRunId = await finishLate();
    const view = getFullView(db, eventId, CATALOG, new Date(et("09:00", NEXT_DAY)))!;
    expect(view.runs.map((r) => r.runId)).not.toContain(lateRunId);
    expect(view.filings.map((f) => f.form)).toEqual(["8-K"]);
    expect(view.late?.filing?.form).toBe("10-Q");
    expect(view.late?.run?.runId).toBe(lateRunId);
    expect(view.late?.run?.sections[0].headline).toBe("The report details the segment split the call mentioned");
    expect(view.late?.lookAgainAvailable).toBe(false);
    // The panel's chip.
    expect(getPanelViews(db, [eventId], CATALOG, new Date(et("09:00", NEXT_DAY)))[eventId].lateAdded).toBe("10-Q");
  });

  it("the share page of the evening run does not carry the late section, and a late run id is not shareable", async () => {
    const lateRunId = await finishLate();
    const view = getFullView(db, eventId, CATALOG, new Date(et("09:00", NEXT_DAY)))!;
    const html = renderSharePage(view, view.runs[0].runId);
    expect(html).not.toContain("segment split");
    expect(html).not.toContain("10-Q");
    expect(() => renderSharePage(view, lateRunId)).toThrow();
  });

  it("the push sender never sends for a late section", async () => {
    const lateRunId = await finishLate();
    const send = vi.fn(async () => ({ sent: true }));
    await sendSummaryPushIfDue(db, listSections(db, lateRunId)[0].id, send);
    expect(send).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM filing_summary_pushes").get()).toEqual({ n: 0 });
  });

  it("the evening runner: a re-run reads evening filings only; a companion append never lands on the late run", async () => {
    await finishLate();
    const rerun = startRun(db, eventId, "rerun", { choice: { family: "sonnet", effort: "medium" }, requestKey: "rk-late-1", catalogIds: CATALOG });
    if (!rerun.ok) throw new Error(rerun.reason);
    const forms = listSections(db, rerun.runId).map((s) => s.filingId);
    expect(forms).toEqual([earningsId]);
    expect(listRuns(db, eventId).map((r) => r.id)).toContain(rerun.runId);
  });

  it("Look again through the action route: found, then already found; refused before the cutoff", async () => {
    edgar.filings.push(tenQ("0000123456-26-000072", "09:00", NEXT_DAY));
    const kick = vi.fn();
    const look = {
      pollSeams: async () => ({ seams: seams(() => et("10:00", NEXT_DAY)), done: () => {} }),
      now: () => et("10:00", NEXT_DAY),
    };
    const actionSeams = { kick, catalogIds: () => CATALOG };
    const a = await applyFilingSummaryActionAsync(db, { eventId, action: "look_again_late" }, actionSeams, look);
    expect(a).toMatchObject({ ok: true, data: { found: true, form: "10-Q" } });
    expect(kick).toHaveBeenCalledTimes(1);
    const b = await applyFilingSummaryActionAsync(db, { eventId, action: "look_again_late" }, actionSeams, look);
    expect(b).toMatchObject({ ok: true, data: { found: true } });
    // The sync entry point refuses it (it is async).
    expect(applyFilingSummaryAction(db, { eventId, action: "look_again_late" }, actionSeams)).toMatchObject({ ok: false, status: 400 });
    upsertEventState(db, eventId, { pollState: "found" });
    const c = await applyFilingSummaryActionAsync(db, { eventId, action: "look_again_late" }, actionSeams, look);
    expect(c).toMatchObject({ ok: false, status: 409 });
  });

  it("Retry accepts the late run's id", async () => {
    seedEveningRun();
    const { runId } = await seedLateFilingAndRun();
    db.prepare("UPDATE filing_summary_sections SET status = 'failed', error_class = 'model_error' WHERE run_id = ?").run(runId);
    db.prepare("UPDATE filing_summary_runs SET status = 'failed' WHERE id = ?").run(runId);
    const res = applyFilingSummaryAction(db, { eventId, action: "retry", runId, requestKey: "rk-retry-late" }, { kick: () => {}, catalogIds: () => CATALOG });
    expect(res).toMatchObject({ ok: true });
    expect(listSections(db, runId)[0].status).toBe("pending");
  });

  it("an event merge drops the donor's watch and moves the late filing with its arrival", async () => {
    await tickAt(et("21:10"));
    edgar.filings.push(tenQ("0000123456-26-000073", "07:30", NEXT_DAY));
    await pollLateFiling(db, eventId, et("07:40", NEXT_DAY), seams(() => et("07:40", NEXT_DAY)));
    const target = seedEvent(EVENT_DATE, "fs-late-acme-2");
    db.transaction(() => mergeFilingSummaryState({ db, donorEventId: eventId, targetEventId: target }))();
    expect(getLateWatch(db, eventId)).toBeNull();
    expect(listLateFilings(db, target).map((f) => f.accession)).toEqual(["0000123456-26-000073"]);
  });
});

// ---------------------------------------------------------------- UI source pins (no DOM harness)

describe("UI wiring (source pins)", () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, "../..", p), "utf8");

  it("the filings page posts Look again through the action route and reads the result honestly", () => {
    const src = read("app/dashboard/print/[eventId]/filings/FilingSummaryView.tsx");
    const fn = src.indexOf("async function lookAgain()");
    expect(fn).toBeGreaterThan(-1);
    const body = src.slice(fn, src.indexOf("\n  }\n", fn));
    expect(body).toContain('action: "look_again_late"');
    expect(body).toContain("readMutationResult");
    expect(body).toContain("networkFailureMessage");
    expect(src).toContain("<LateBlock");
    expect(src).toContain("lateHeading(");
  });

  it("the Hub panel shows the late marker from labels.ts", () => {
    const src = read("app/dashboard/today/FilingSummaryPanel.tsx");
    expect(src).toContain("view.lateAdded && (");
    expect(src).toContain("lateAddedChipText(view.lateAdded)");
  });
});

describe("header period of report", () => {
  it("reads <PERIOD> (raw or escaped) and the conformed line; absent is null", async () => {
    const { parseFilingHeader } = await import("@/lib/filing-summary/edgar");
    expect(parseFilingHeader("<!-- <PERIOD>20260930 -->").periodOfReport).toBe("2026-09-30");
    expect(parseFilingHeader("<pre>&lt;PERIOD&gt;20261231</pre>").periodOfReport).toBe("2026-12-31");
    expect(parseFilingHeader("CONFORMED PERIOD OF REPORT:\t20260630").periodOfReport).toBe("2026-06-30");
    expect(parseFilingHeader("<html></html>").periodOfReport).toBeNull();
  });
});
