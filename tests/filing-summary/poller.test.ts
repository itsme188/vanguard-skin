/**
 * The armed-print filing poll and its 60-second tick (spec §4, R11, R12,
 * "Late arms", Hardening 1 and 10). Fake clock, fake fetch, migrated
 * in-memory DB. Every fixture is SYNTHETIC: a made-up CIK, accessions,
 * company and file names.
 *
 * Event: ACME (Acme Widgets Inc) reports after the close on 2026-10-21, an
 * EDT day, so Eastern = UTC - 4h.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import type { FetchLike } from "@/lib/print-watch/hardened-fetch";
import {
  pollEvent,
  pollPhase,
  __resetPollerCacheForTests,
  AFTER_CUTOFF_REASON,
  MANUAL_ONLY_DETAIL,
  type PollSeams,
} from "@/lib/filing-summary/poller";
import { runTick, __resetFilingSummaryTickForTests, type TickSeams } from "@/lib/filing-summary/tick";
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

function earnings8k(accession: string, hhmmss: string, ex99 = EX99_GOOD): FakeFiling {
  return {
    accession,
    form: "8-K",
    json: `2026-10-21T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}.000Z`,
    header: `20261021${hhmmss}`,
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
    issuerName: (d, symbol) =>
      (d.prepare(`SELECT name FROM securities WHERE symbol = ?`).get(symbol) as { name: string } | undefined)
        ?.name ?? null,
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

  it("armed at 20:30 → manual_only, and no fetch is made", async () => {
    arm(et("20:30"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("20:31"));
    await tick(et("20:32"));
    const s = getEventState(db, eventId)!;
    expect(s.pollState).toBe("manual_only");
    expect(s.pollDetail).toBe(MANUAL_ONLY_DETAIL);
    expect(edgar.calls).toEqual([]);
    expect(listFilings(db, eventId)).toEqual([]);
  });

  it("armed at 15:00 but first seen at 21:30 (app asleep) still gets its catch-up", async () => {
    arm(et("15:00"));
    edgar.filings.push(earnings8k("0000123456-26-000101", "160500"));
    await tick(et("21:30"));
    expect(getEventState(db, eventId)!.pollState).toBe("past_cutoff");
    expect(earningsCalls).toEqual([eventId]);
  });

  it("armed late on the day before's print (event dated yesterday, armed today) → manual_only", async () => {
    arm(et("10:00", "2026-10-22"));
    await tick(et("10:01", "2026-10-22"));
    expect(getEventState(db, eventId)!.pollState).toBe("manual_only");
    expect(edgar.calls).toEqual([]);
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
