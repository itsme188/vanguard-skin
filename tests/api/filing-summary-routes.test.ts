/**
 * HTTP-boundary tests for /api/filing-summary (Task 12). Pattern per
 * tests/api/earnings-worksheet-route.test.ts: the db singleton is mocked with
 * an in-memory migrated database and the handlers are called directly. The
 * section runner's kick is replaced so no model call is ever made; startRun
 * and retryRun stay real. Synthetic data only; model ids from a catalog
 * fixture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { classifyRoute } from "@/lib/auth/route-policy";
import { insertFiling, listRuns, upsertEventState } from "@/lib/filing-summary/store";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  runNextSection: vi.fn<(...a: unknown[]) => Promise<string>>(async () => "idle"),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/filing-summary/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/filing-summary/runner")>()),
  runNextSection: (...a: unknown[]) => hoisted.runNextSection(...a),
}));

import { GET as listGET, POST } from "@/app/api/filing-summary/route";
import { GET as fullGET } from "@/app/api/filing-summary/[eventId]/route";
import { GET as shareGET } from "@/app/api/filing-summary/[eventId]/share/route";

const CATALOG = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];
let eventId: number;

function seedEvent(symbol = "SYNW", type = "earnings"): number {
  return Number(
    hoisted.db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('manual',?,'2026-10-22',?,?,?)`,
      )
      .run(type, `${symbol} ${type}`, `manual:${symbol}:${type}`, symbol).lastInsertRowid,
  );
}

function seedEarningsFiling(id = eventId, accession = "0000000001-26-000001"): number {
  return insertFiling(hoisted.db, {
    eventId: id, accession, cik: "0000000001", form: "8-K", role: "earnings", items: "2.02",
    acceptedAt: "2026-10-22T20:05:00.000Z", discoveredAt: "2026-10-22T20:06:00.000Z",
    identityVerdict: "accepted", identityReason: null, fetchState: "fetched",
  }).id;
}

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/filing-summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const params = (id: number) => ({ params: Promise.resolve({ eventId: String(id) }) });

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  hoisted.runNextSection.mockClear();
  setModelCatalogSource(() => CATALOG);
  eventId = seedEvent();
});

afterEach(() => {
  setModelCatalogSource(null);
  hoisted.db.close();
});

describe("route policy", () => {
  it("classifies every filing-summary route as human", () => {
    expect(classifyRoute("POST", "/api/filing-summary")).toBe("human");
    expect(classifyRoute("GET", "/api/filing-summary")).toBe("human");
    expect(classifyRoute("GET", "/api/filing-summary/1")).toBe("human");
    expect(classifyRoute("GET", "/api/filing-summary/1/share")).toBe("human");
  });
});

describe("POST set_choice", () => {
  it("stores a picker choice, rejects a non-picker choice, and refuses after the lock", async () => {
    let res = await post({ eventId, action: "set_choice", family: "fable", effort: "high" });
    expect(res.status).toBe(200);
    res = await post({ eventId, action: "set_choice", family: "sonnet", effort: "high" });
    expect(res.status).toBe(400);
    seedEarningsFiling();
    res = await post({ eventId, action: "run", requestKey: "k-run" });
    expect(res.status).toBe(200);
    res = await post({ eventId, action: "set_choice", family: "opus", effort: "medium" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: "locked" });
  });
});

describe("POST paid actions", () => {
  it("run on a print whose earnings filing time is unconfirmed creates a manual run (round 2 ruling)", async () => {
    const id = insertFiling(hoisted.db, {
      eventId, accession: "0000000001-26-000001", cik: "0000000001", form: "8-K", role: "earnings", items: "2.02",
      acceptedAt: null, discoveredAt: "2026-10-22T20:06:00.000Z",
      identityVerdict: "time_unconfirmed", identityReason: "header has no acceptance time", fetchState: "fetched",
      gatePassed: true,
    }).id;
    upsertEventState(hoisted.db, eventId, { pollState: "past_cutoff", pollDetail: "earnings 8-K time unconfirmed — Run summary to spend" });

    const panel = await (await listGET(new Request(`http://localhost/api/filing-summary?eventIds=${eventId}`))).json();
    expect(panel.data[eventId]).toMatchObject({ earningsTimeUnconfirmed: true, earningsForm: "8-K", runSummaryAvailable: true });

    const res = await post({ eventId, action: "run", requestKey: "k-unconfirmed" });
    expect(res.status).toBe(200);
    const runs = listRuns(hoisted.db, eventId);
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("manual_run");
    const sections = hoisted.db
      .prepare("SELECT filing_id FROM filing_summary_sections WHERE run_id = ?")
      .all(runs[0].id) as Array<{ filing_id: number }>;
    expect(sections.map((s) => s.filing_id)).toEqual([id]);
    expect(hoisted.runNextSection).toHaveBeenCalledWith(hoisted.db, eventId);
  });

  it("requires a requestKey", async () => {
    seedEarningsFiling();
    const res = await post({ eventId, action: "run" });
    expect(res.status).toBe(400);
    expect(listRuns(hoisted.db, eventId)).toHaveLength(0);
  });

  it("re-run twice with the same requestKey makes one run, and kicks the runner", async () => {
    seedEarningsFiling();
    expect((await post({ eventId, action: "run", requestKey: "k1" })).status).toBe(200);
    const a = await post({ eventId, action: "rerun", family: "sonnet", effort: "medium", requestKey: "k2" });
    const b = await post({ eventId, action: "rerun", family: "sonnet", effort: "medium", requestKey: "k2" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ja = await a.json();
    const jb = await b.json();
    expect(jb.data.runId).toBe(ja.data.runId);
    expect(jb.data.created).toBe(false);
    expect(listRuns(hoisted.db, eventId).map((r) => r.trigger)).toEqual(["manual_run", "rerun"]);
    expect(hoisted.runNextSection).toHaveBeenCalledWith(hoisted.db, eventId);
  });

  it("re-run needs a picker choice", async () => {
    seedEarningsFiling();
    await post({ eventId, action: "run", requestKey: "k1" });
    const res = await post({ eventId, action: "rerun", requestKey: "k3" });
    expect(res.status).toBe(400);
  });

  it("maps the startRun failures to the controller's statuses", async () => {
    // no filing: Run summary is not offered
    let res = await post({ eventId, action: "run", requestKey: "k1" });
    expect(res.status).toBe(409);
    // no model in the family (and nothing below it)
    seedEarningsFiling();
    setModelCatalogSource(() => []);
    res = await post({ eventId, action: "run", requestKey: "k2" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("No model in that family is available right now.");
    setModelCatalogSource(() => CATALOG);
    // a key used for another print
    const other = seedEvent("OTHR");
    seedEarningsFiling(other, "0000000001-26-000005");
    expect((await post({ eventId: other, action: "run", requestKey: "shared" })).status).toBe(200);
    res = await post({ eventId, action: "run", requestKey: "shared" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("That request was already used for another print.");
  });

  it("refuses run once a run exists", async () => {
    seedEarningsFiling();
    await post({ eventId, action: "run", requestKey: "k1" });
    const res = await post({ eventId, action: "run", requestKey: "k9" });
    expect(res.status).toBe(409);
  });

  it("refuses paid actions on a disarmed print", async () => {
    seedEarningsFiling();
    await post({ eventId, action: "run", requestKey: "k1" });
    const runId = listRuns(hoisted.db, eventId)[0].id;
    hoisted.db.prepare("UPDATE filing_summary_sections SET status='failed', error_class='timeout'").run();
    hoisted.db.prepare("UPDATE filing_summary_runs SET status='failed'").run();
    upsertEventState(hoisted.db, eventId, { pollState: "cancelled" });
    let res = await post({ eventId, action: "retry", runId, requestKey: "r1" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This print was disarmed; re-arm it to retry.");
    res = await post({ eventId, action: "rerun", family: "opus", effort: "high", requestKey: "r2" });
    expect(res.status).toBe(409);
  });

  it("replays a used request key before the disarmed check", async () => {
    seedEarningsFiling();
    const first = await (await post({ eventId, action: "run", requestKey: "k1" })).json();
    upsertEventState(hoisted.db, eventId, { pollState: "cancelled" });
    const again = await post({ eventId, action: "run", requestKey: "k1" });
    expect(again.status).toBe(200);
    expect((await again.json()).data).toEqual({ eventId, runId: first.data.runId, created: false });
    const fresh = await post({ eventId, action: "rerun", family: "opus", effort: "high", requestKey: "k2" });
    expect(fresh.status).toBe(409);
  });

  it("retries a failed run, idempotently on the key, and checks the run belongs to the print", async () => {
    seedEarningsFiling();
    await post({ eventId, action: "run", requestKey: "k1" });
    const runId = listRuns(hoisted.db, eventId)[0].id;
    let res = await post({ eventId, action: "retry", runId, requestKey: "r1" });
    expect(res.status).toBe(409); // nothing failed yet
    hoisted.db.prepare("UPDATE filing_summary_sections SET status='failed', error_class='timeout'").run();
    hoisted.db.prepare("UPDATE filing_summary_runs SET status='failed'").run();
    res = await post({ eventId, action: "retry", runId, requestKey: "r2" });
    expect(res.status).toBe(200);
    res = await post({ eventId, action: "retry", runId, requestKey: "r2" });
    expect(res.status).toBe(200);
    res = await post({ eventId, action: "retry", runId: runId + 50, requestKey: "r3" });
    expect(res.status).toBe(404);
    res = await post({ eventId, action: "retry", requestKey: "r4" });
    expect(res.status).toBe(400);
  });

  it("answers 404 for an unknown event and 400 for a non-earnings event or bad action", async () => {
    expect((await post({ eventId: 9999, action: "run", requestKey: "k" })).status).toBe(404);
    expect((await post({ eventId: "x", action: "run", requestKey: "k" })).status).toBe(400);
    const macro = seedEvent("CPI", "macro");
    expect((await post({ eventId: macro, action: "run", requestKey: "k" })).status).toBe(400);
    expect((await post({ eventId, action: "nope" })).status).toBe(400);
  });
});

describe("GET routes", () => {
  it("returns panel views and the full view", async () => {
    seedEarningsFiling();
    const list = await listGET(new Request(`http://localhost/api/filing-summary?eventIds=${eventId},abc`));
    const lj = await list.json();
    expect(lj.success).toBe(true);
    expect(lj.data[eventId].runSummaryAvailable).toBe(true);
    const full = await fullGET(new Request(`http://localhost/api/filing-summary/${eventId}`), params(eventId));
    const fj = await full.json();
    expect(fj.data.event.symbol).toBe("SYNW");
    expect((await fullGET(new Request("http://localhost/x"), params(9999))).status).toBe(404);
  });

  it("downloads the share page as an attachment", async () => {
    seedEarningsFiling();
    await post({ eventId, action: "run", requestKey: "k1" });
    const runId = listRuns(hoisted.db, eventId)[0].id;
    const res = await shareGET(
      new NextRequest(`http://localhost/api/filing-summary/${eventId}/share?runId=${runId}`),
      params(eventId),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="SYNW-2026-10-22-filing-summary-run1.html"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const missing = await shareGET(
      new NextRequest(`http://localhost/api/filing-summary/${eventId}/share?runId=${runId + 9}`),
      params(eventId),
    );
    expect(missing.status).toBe(404);
  });
});

describe("privacy canary (R15)", () => {
  it("keeps portfolio rows and bogey notes out of every GET payload and the share page", async () => {
    const db = hoisted.db;
    const acct = Number(db.prepare("INSERT INTO accounts (name) VALUES ('CANARY-ACCOUNT')").run().lastInsertRowid);
    const sec = Number(
      db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('SYNW','Synthetic Widgets Inc.','Stock')")
        .run().lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?,?,?,?,?,?)",
    ).run(acct, sec, 4242, 98765.43, "2026-10-21", "canary:holding");
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, uploaded_at, eps_consensus, notes, guidance_notes)
       VALUES (?, 'manual', 'CANARY-LABEL-5512', '2026-10-21 15:00:00', 1.23, 'CANARY-NOTES-7731', 'CANARY-GUIDE-9917')`,
    ).run(eventId);
    seedEarningsFiling();
    expect((await post({ eventId, action: "run", requestKey: "k1" })).status).toBe(200);
    const runId = listRuns(db, eventId)[0].id;
    // The snapshot carried the bogey figure (so the canary is a real test).
    expect(listRuns(db, eventId)[0].bogeySnapshotJson).toContain("1.23");

    const payloads = [
      await (await listGET(new Request(`http://localhost/api/filing-summary?eventIds=${eventId}`))).text(),
      await (await fullGET(new Request(`http://localhost/x`), params(eventId))).text(),
      await (
        await shareGET(
          new NextRequest(`http://localhost/api/filing-summary/${eventId}/share?runId=${runId}`),
          params(eventId),
        )
      ).text(),
    ];
    expect(payloads[1]).toContain("your manual entry");
    for (const p of payloads) {
      for (const canary of ["CANARY-ACCOUNT", "CANARY-NOTES-7731", "CANARY-GUIDE-9917", "CANARY-LABEL-5512", "4242", "98765"]) {
        expect(p).not.toContain(canary);
      }
    }
  });
});
