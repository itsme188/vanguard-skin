/**
 * Filing summary view model (Task 12): what the panel and the full page show.
 * Synthetic data only; model ids come from a catalog fixture.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  appendSection,
  createRun,
  insertFiling,
  listSections,
  setChoice,
  upsertEventState,
  type NewFiling,
} from "@/lib/filing-summary/store";
import {
  etTime,
  getFullView,
  getPanelViews,
  publicBogeys,
  runViewStatus,
  sectionViewStatus,
} from "@/lib/filing-summary/view";
import type { CheckedClaim, CheckedSection } from "@/lib/filing-summary/types";
import { countStatuses } from "@/lib/filing-summary/evaluate";

const CATALOG = ["claude-opus-5-5", "claude-sonnet-5-5"];
let db: Database.Database;
let eventId: number;

function seedEvent(): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('finnhub','earnings','2026-10-22','SYNW earnings','k:SYNW','SYNW')`,
      )
      .run().lastInsertRowid,
  );
}

function filing(accession: string, over: Partial<NewFiling> = {}): NewFiling {
  return {
    eventId,
    accession,
    cik: "0000000001",
    form: "8-K",
    role: "earnings",
    items: "2.02",
    acceptedAt: "2026-10-22T20:05:00.000Z",
    discoveredAt: "2026-10-22T20:06:00.000Z",
    identityVerdict: "accepted",
    identityReason: null,
    fetchState: "fetched",
    ...over,
  };
}

function claim(id: string, over: Partial<CheckedClaim> = {}): CheckedClaim {
  return {
    claimId: id,
    renderedText: `Claim ${id}`,
    status: "checked",
    top: true,
    routine: false,
    footnotes: [],
    figureChecks: [],
    comparisonChecks: [],
    reasons: [],
    correction: null,
    ...over,
  };
}

function run(filingIds: number[], trigger: "auto" | "rerun" = "auto"): number {
  return createRun(db, {
    eventId,
    trigger,
    choice: { family: "opus", effort: "high" },
    modelId: "claude-opus-5-5",
    fallbackNote: null,
    requestKey: null,
    bogeySnapshotJson: "[]",
    filingIds,
  }).runId;
}

/** Marks a section done with the given claims (run status recomputed by hand). */
function completeSection(runId: number, seq: number, claims: CheckedClaim[], incomplete = false): void {
  const checked: CheckedSection = { headline: "Synthetic headline", claims, counts: countStatuses(claims) };
  db.prepare(
    `UPDATE filing_summary_sections SET status='done', checked_json=?, counts_json=?, incomplete=?,
       coverage_json='[]', model_id='claude-opus-5-5', effort='high', finished_at=datetime('now')
     WHERE run_id=? AND seq=?`,
  ).run(JSON.stringify(checked), JSON.stringify(checked.counts), incomplete ? 1 : 0, runId, seq);
  const open = db
    .prepare("SELECT COUNT(*) AS n FROM filing_summary_sections WHERE run_id=? AND status<>'done'")
    .get(runId) as { n: number };
  if (open.n === 0) db.prepare("UPDATE filing_summary_runs SET status='done' WHERE id=?").run(runId);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = seedEvent();
});

describe("panel view", () => {
  it("keeps showing the done run while a re-run is running", () => {
    const { id: f1 } = insertFiling(db, filing("0000000001-26-000001"));
    const r1 = run([f1]);
    completeSection(r1, 1, [claim("s1.c1"), claim("s1.c2", { status: "contradicted" })]);
    const r2 = run([f1], "rerun");
    const v = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(v.shown?.runId).toBe(r1);
    expect(v.shown?.status).toBe("done");
    expect(v.inProgress?.runId).toBe(r2);
    expect(v.shown?.counts).toEqual(countStatuses([claim("a"), claim("b", { status: "contradicted" })]));
    expect(v.shown?.top).toHaveLength(2);
    expect(v.shown?.modelLabel).toBe("Opus 5.5");
    expect(v.locked).toBe(true);
    expect(v.nowLabel).toBe("Opus · now 5.5");
    expect(v.runSummaryAvailable).toBe(false);
  });

  it("sets excludesAfterEt on an older run when a newer run has more filings", () => {
    const { id: f1 } = insertFiling(db, filing("0000000001-26-000001"));
    const r1 = run([f1]);
    completeSection(r1, 1, [claim("s1.c1")]);
    const { id: f2 } = insertFiling(
      db,
      filing("0000000001-26-000002", { form: "PRE 14C", role: "companion", discoveredAt: "2026-10-22T20:12:00.000Z" }),
    );
    const r2 = run([f1, f2], "rerun");
    completeSection(r2, 1, [claim("s1.c1")]);
    completeSection(r2, 2, [claim("s2.c1")]);
    const full = getFullView(db, eventId, CATALOG)!;
    expect(full.runs.find((r) => r.runId === r1)?.excludesAfterEt).toBe("4:06 pm");
    expect(full.runs.find((r) => r.runId === r2)?.excludesAfterEt).toBeNull();
    // newest done run is shown
    expect(getPanelViews(db, [eventId], CATALOG)[eventId].shown?.runId).toBe(r2);
  });

  it("offers Run summary only with an accepted earnings filing and no run", () => {
    expect(getPanelViews(db, [eventId], CATALOG)[eventId].runSummaryAvailable).toBe(false);
    insertFiling(db, filing("0000000001-26-000001"));
    upsertEventState(db, eventId, { pollState: "manual_only", pollDetail: "armed after 8 pm" });
    const v = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(v.runSummaryAvailable).toBe(true);
    expect(v.pollState).toBe("manual_only");
    expect(v.shown).toBeNull();
  });

  it("a time-unconfirmed earnings filing is found, not 'no filing', and Run summary is offered (round 2 ruling)", () => {
    const before = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(before.earningsTimeUnconfirmed).toBe(false);
    expect(before.earningsForm).toBeNull();

    insertFiling(
      db,
      filing("0000000001-26-000001", {
        form: "6-K",
        acceptedAt: null,
        identityVerdict: "time_unconfirmed",
        identityReason: "header has no acceptance time",
      }),
    );
    upsertEventState(db, eventId, { pollState: "past_cutoff", pollDetail: "earnings 6-K time unconfirmed — Run summary to spend" });
    const v = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(v.earningsTimeUnconfirmed).toBe(true);
    expect(v.earningsForm).toBe("6-K");
    expect(v.runSummaryAvailable).toBe(true);

    // Disarmed: nothing is offered.
    upsertEventState(db, eventId, { pollState: "cancelled" });
    expect(getPanelViews(db, [eventId], CATALOG)[eventId].runSummaryAvailable).toBe(false);
  });

  it("an accepted earnings filing wins over a time-unconfirmed one, and a run ends the offer", () => {
    insertFiling(db, filing("0000000001-26-000001", { acceptedAt: null, identityVerdict: "time_unconfirmed", role: "companion" }));
    const { id: f2 } = insertFiling(db, filing("0000000001-26-000002"));
    const v = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(v.earningsTimeUnconfirmed).toBe(false);
    expect(v.earningsForm).toBe("8-K");
    expect(v.runSummaryAvailable).toBe(true);
    run([f2]);
    expect(getPanelViews(db, [eventId], CATALOG)[eventId].runSummaryAvailable).toBe(false);
  });

  it("a rejected earnings filing is neither accepted nor time-unconfirmed", () => {
    insertFiling(db, filing("0000000001-26-000001", { identityVerdict: "rejected", identityReason: "accepted after 8 pm" }));
    const v = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(v.earningsTimeUnconfirmed).toBe(false);
    expect(v.runSummaryAvailable).toBe(false);
  });

  it("leaves out unknown event ids and reports the stored choice", () => {
    setChoice(db, eventId, { family: "fable", effort: "medium" });
    const views = getPanelViews(db, [eventId, 999], CATALOG);
    expect(Object.keys(views)).toEqual([String(eventId)]);
    expect(views[eventId].choiceLabel).toBe("Fable · medium");
    expect(views[eventId].isDefault).toBe(false);
    expect(views[eventId].nowLabel).toBe("Fable · not available");
  });
});

describe("which run is shown (fix round 1)", () => {
  it("keeps showing a run after a companion is appended to it, with no in-progress run", () => {
    const { id: f1 } = insertFiling(db, filing("0000000001-26-000001"));
    const r1 = run([f1]);
    completeSection(r1, 1, [claim("s1.c1")]);
    const { id: f2 } = insertFiling(db, filing("0000000001-26-000002", { form: "PRE 14C", role: "companion" }));
    appendSection(db, r1, f2);
    const v = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(v.shown?.runId).toBe(r1);
    expect(v.shown?.status).toBe("running");
    expect(v.shown?.sectionStates.map((s) => s.status)).toEqual(["done", "pending"]);
    expect(v.inProgress).toBeNull();
  });

  it("keeps showing the newer run when its earnings section is done and a companion failed", () => {
    const { id: f1 } = insertFiling(db, filing("0000000001-26-000001"));
    const r1 = run([f1]);
    completeSection(r1, 1, [claim("s1.c1")]);
    const { id: f2 } = insertFiling(db, filing("0000000001-26-000002", { form: "PRE 14C", role: "companion" }));
    const r2 = run([f1, f2], "rerun");
    completeSection(r2, 1, [claim("s1.c1")]);
    db.prepare(
      "UPDATE filing_summary_sections SET status='failed', error_class='timeout' WHERE run_id=? AND seq=2",
    ).run(r2);
    db.prepare("UPDATE filing_summary_runs SET status='failed' WHERE id=?").run(r2);
    const v = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(v.shown?.runId).toBe(r2);
    expect(v.shown?.status).toBe("failed");
    expect(v.inProgress).toBeNull();
    expect(getFullView(db, eventId, CATALOG)!.shownRunId).toBe(r2);
  });

  it("falls back to the newest run when no earnings section is done", () => {
    const { id: f1 } = insertFiling(db, filing("0000000001-26-000001"));
    run([f1]);
    const r2 = run([f1], "rerun");
    const v = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(v.shown?.runId).toBe(r2);
    expect(v.inProgress).toBeNull();
  });

  it("labels the quarter per run, and the event from the shown run", () => {
    const { id: f1 } = insertFiling(db, filing("0000000001-26-000001"));
    const out = (q: number) =>
      JSON.stringify({
        headline: "h",
        bullets: [{ top: true, routine: false, claims: [{ figures: [
          { sourceKind: "quote", period: { kind: "quarter", role: "actual", fiscalQuarter: q } },
        ] }] }],
      });
    const r1 = run([f1]);
    completeSection(r1, 1, [claim("s1.c1")]);
    db.prepare("UPDATE filing_summary_sections SET output_json=? WHERE run_id=?").run(out(3), r1);
    const r2 = run([f1], "rerun");
    completeSection(r2, 1, [claim("s1.c1")]);
    db.prepare("UPDATE filing_summary_sections SET output_json=? WHERE run_id=?").run(out(4), r2);
    const full = getFullView(db, eventId, CATALOG)!;
    expect(full.runs.map((r) => r.quarterLabel)).toEqual(["Q3", "Q4"]);
    expect(full.event.quarterLabel).toBe("Q4");
  });
});

describe("waiting for Retry (controller ruling 4)", () => {
  it("maps a failed awaiting_retry section to waiting_retry, never failed", () => {
    expect(sectionViewStatus({ status: "failed", errorClass: "awaiting_retry" })).toBe("waiting_retry");
    expect(sectionViewStatus({ status: "failed", errorClass: "refusal" })).toBe("failed");
    expect(runViewStatus({ status: "failed" }, [{ status: "done" }, { status: "waiting_retry" }])).toBe("waiting_retry");
    expect(runViewStatus({ status: "failed" }, [{ status: "failed" }, { status: "waiting_retry" }])).toBe("failed");
  });

  it("shows a stored waiting companion as waiting_retry in both views", () => {
    const { id: f1 } = insertFiling(db, filing("0000000001-26-000001"));
    const { id: f2 } = insertFiling(db, filing("0000000001-26-000002", { form: "PRE 14C", role: "companion" }));
    const r1 = run([f1, f2]);
    completeSection(r1, 1, [claim("s1.c1")]);
    db.prepare(
      `UPDATE filing_summary_sections SET status='failed', error_class='awaiting_retry',
         error_text='added after the run failed — runs on Retry' WHERE run_id=? AND seq=2`,
    ).run(r1);
    db.prepare("UPDATE filing_summary_runs SET status='failed' WHERE id=?").run(r1);
    const panel = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(panel.shown?.status).toBe("waiting_retry");
    expect(panel.shown?.sectionStates.map((s) => s.status)).toEqual(["done", "waiting_retry"]);
    const full = getFullView(db, eventId, CATALOG)!;
    expect(full.runs[0].sections[1].status).toBe("waiting_retry");
    expect(JSON.stringify(full)).not.toContain('"status":"failed"');
  });
});

describe("full view", () => {
  it("rebuilds footnote links from the stored filing identity and marks resolved corrections", () => {
    const { id: f1 } = insertFiling(db, filing("0000000001-26-000001"));
    const { id: f2 } = insertFiling(
      db,
      filing("0000000001-26-000003", { form: "8-K/A", role: "companion", acceptedAt: "2026-10-22T21:40:00.000Z" }),
    );
    const r1 = run([f1, f2]);
    completeSection(r1, 1, [
      claim("s1.c1", {
        footnotes: [
          {
            citationId: "q1", document: "ex991.htm", status: "found", page: 2, para: 4,
            sentence: "Revenue rose sharply in the quarter.", url: "https://evil.example/x",
          },
        ],
      }),
    ]);
    completeSection(r1, 2, [
      claim("s2.c1", { correction: { claimId: "s1.c1", resolved: true, footnote: null } }),
    ]);
    const full = getFullView(db, eventId, CATALOG)!;
    const c = full.runs[0].sections[0].claims[0];
    expect(c.footnotes[0].url).toBe(
      "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/ex991.htm#:~:text=Revenue%20rose%20sharply%20in%20the%20quarter.",
    );
    expect(c.correctedBy).toEqual({ form: "8-K/A", acceptedAtEt: "5:40 pm" });
    expect(full.runs[0].sections[1].acceptedAtEt).toBe("5:40 pm");
    expect(full.filings.map((f) => f.acceptedAtEt)).toEqual(["4:05 pm", "5:40 pm"]);
    expect(full.choice.options.map((o) => o.label)).toEqual([
      "Sonnet · medium", "Opus · medium", "Opus · high", "Fable · medium", "Fable · high",
    ]);
    expect(full.event.symbol).toBe("SYNW");
    expect(listSections(db, r1)).toHaveLength(2);
  });

  it("lists rejected filings with their reason", () => {
    insertFiling(
      db,
      filing("0000000001-26-000009", { identityVerdict: "rejected", identityReason: "accepted after 8 pm" }),
    );
    const full = getFullView(db, eventId, CATALOG)!;
    expect(full.filings[0]).toMatchObject({ identityVerdict: "rejected", identityReason: "accepted after 8 pm" });
    expect(full.filings[0].indexUrl).toBe("https://www.sec.gov/Archives/edgar/data/1/000000000126000009/");
  });

  it("returns null for an unknown event", () => {
    expect(getFullView(db, 999, CATALOG)).toBeNull();
  });
});

describe("helpers", () => {
  it("formats Eastern times as 4:05 pm, across DST and SQLite stamps", () => {
    expect(etTime("2026-10-22T20:05:00.000Z")).toBe("4:05 pm");
    expect(etTime("2026-12-01 17:00:00")).toBe("12:00 pm");
    expect(etTime("2026-12-01T05:30:00Z")).toBe("12:30 am");
    expect(etTime(null)).toBeNull();
    expect(etTime("not a time")).toBeNull();
  });

  it("keeps only the public bogey fields", () => {
    const out = publicBogeys(
      JSON.stringify([
        { key: "b1.eps_consensus", label: "EPS consensus", value: 1.5, unit: "usd_per_share", scale: "units",
          period: {}, basis: "unknown", provenance: "Finnhub consensus", asOf: "2026-10-21", rowKind: "vendor",
          notes: "secret" },
        { key: "bad" },
      ]),
    );
    expect(out).toEqual([
      { key: "b1.eps_consensus", label: "EPS consensus", value: 1.5, unit: "usd_per_share",
        provenance: "Finnhub consensus", asOf: "2026-10-21" },
    ]);
  });
});
