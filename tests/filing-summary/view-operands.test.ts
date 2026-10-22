/**
 * Task 14 fix round 1: the view's additions — comparison operand descriptors
 * (2a, also on the panel's Top claims, 2d), the model's quote on unlocated
 * footnotes (2b), and the panel's readingDocs / choiceOptions (2c).
 * Synthetic data only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { createRun, insertFiling, upsertDocument, upsertEventState, type NewFiling } from "@/lib/filing-summary/store";
import { getFullView, getPanelViews } from "@/lib/filing-summary/view";
import { countStatuses } from "@/lib/filing-summary/evaluate";
import { SUMMARY_CHOICES, choiceLabel } from "@/lib/filing-summary/choice";
import { choiceValue } from "@/lib/filing-summary/labels";
import type {
  BogeySnapshotFigure,
  CheckedClaim,
  CheckedSection,
  ModelFigure,
  ModelSectionOutput,
} from "@/lib/filing-summary/types";

const CATALOG = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];
let db: Database.Database;
let eventId: number;

function filing(accession: string, over: Partial<NewFiling> = {}): NewFiling {
  return {
    eventId, accession, cik: "0000000001", form: "8-K", role: "earnings", items: "2.02",
    acceptedAt: "2026-10-22T20:05:00.000Z", discoveredAt: "2026-10-22T20:06:00.000Z",
    identityVerdict: "accepted", identityReason: null, fetchState: "fetched", ...over,
  };
}

const PERIOD = { kind: "quarter", role: "actual", endDate: null, fiscalYear: 2026, fiscalQuarter: 3, anchor: null, label: "Q3 2026" } as const;

function fig(id: string, over: Partial<ModelFigure>): ModelFigure {
  return {
    id, valueText: "", value: 0, unit: "usd", scale: "billions", metric: "revenue", period: { ...PERIOD },
    basis: "reported", basisNote: null, sourceKind: "quote", citationId: "q1", label: "Revenue", bogeyKey: null,
    operation: null, inputs: [], ...over,
  };
}

// A snapshot row with a non-public field: it must never reach the view.
const SNAPSHOT = [
  {
    key: "b7.revenue", label: "Revenue consensus", value: 64_570_000_000, unit: "usd", scale: "units",
    period: { ...PERIOD, anchor: "reported_quarter" }, basis: "reported", provenance: "Finnhub consensus",
    asOf: "2026-10-20", rowKind: "vendor", notes: "CANARY-NOTES-4411",
  } as BogeySnapshotFigure & { notes: string },
];

const OUTPUT: ModelSectionOutput = {
  headline: "Synthetic Q3",
  bullets: [
    {
      top: true,
      routine: false,
      claims: [
        {
          id: "c1",
          text: "Revenue of {f1} was below the {f2} consensus.",
          citations: [
            { id: "q1", document: "ex99.htm", quote: "Revenue was $64.60 billion", isTableRow: false },
            { id: "q2", document: "ex99.htm", quote: "a quote the model made up", isTableRow: false },
          ],
          figures: [
            fig("f1", { valueText: "$64.601B", value: 64.601 }),
            fig("f2", { valueText: "$64.57B", value: 64.57, sourceKind: "bogey", citationId: null, label: null, bogeyKey: "b7.revenue" }),
            fig("f3", { valueText: "$1.10", value: 1.1, unit: "usd_per_share", scale: "units" }),
            fig("f4", { valueText: "$1.20", value: 1.2, unit: "usd_per_share", scale: "units" }),
          ],
          comparisons: [
            { left: "f1", leftHigh: null, right: "f2", rightHigh: null, relation: "below" },
            { left: "f3", leftHigh: "f4", right: "f9", rightHigh: null, relation: "raised" },
          ],
          corrects: null,
        },
      ],
    },
  ],
};

const CHECKED_CLAIM: CheckedClaim = {
  claimId: "c1",
  renderedText: "Revenue of $64.601B was below the $64.57B consensus.",
  status: "contradicted",
  top: true,
  routine: false,
  footnotes: [
    { citationId: "q1", document: "ex99.htm", status: "found", page: 1, para: 2, sentence: "Revenue was $64.60 billion.", url: null },
    { citationId: "q2", document: "ex99.htm", status: "not_found", page: null, para: null, sentence: null, url: null },
  ],
  figureChecks: [],
  comparisonChecks: [
    { relation: "below", verdict: "contradicted", difference: 0.031, differencePct: 0.05, shownText: "+0.05%", reasons: [] },
    { relation: "raised", verdict: "unconfirmed", difference: null, differencePct: null, shownText: null, reasons: [] },
  ],
  reasons: [],
  correction: null,
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('finnhub','earnings','2026-10-22','SYNW earnings','k:SYNW','SYNW')`,
      )
      .run().lastInsertRowid,
  );
});

function seedDoneRun(claimId = "c1"): { runId: number; filingId: number } {
  const { id: filingId } = insertFiling(db, filing("0000000001-26-000001"));
  const runId = createRun(db, {
    eventId, trigger: "auto", choice: { family: "opus", effort: "high" }, modelId: "claude-opus-5-5",
    fallbackNote: null, requestKey: null, bogeySnapshotJson: JSON.stringify(SNAPSHOT), filingIds: [filingId],
  }).runId;
  const claim: CheckedClaim = { ...CHECKED_CLAIM, claimId };
  const checked: CheckedSection = { headline: "Synthetic Q3", claims: [claim], counts: countStatuses([claim]) };
  db.prepare(
    `UPDATE filing_summary_sections SET status='done', checked_json=?, counts_json=?, output_json=?, coverage_json='[]',
       model_id='claude-opus-5-5', effort='high', finished_at=datetime('now') WHERE run_id=?`,
  ).run(JSON.stringify(checked), JSON.stringify(checked.counts), JSON.stringify(OUTPUT), runId);
  db.prepare("UPDATE filing_summary_runs SET status='done' WHERE id=?").run(runId);
  return { runId, filingId };
}

describe("comparison operand descriptors (2a, 2d)", () => {
  it("describes each operand from the section's figures and the run's bogey snapshot", () => {
    seedDoneRun();
    const full = getFullView(db, eventId, CATALOG)!;
    const [cc1, cc2] = full.runs[0].sections[0].claims[0].comparisonChecks;
    expect(cc1.left).toEqual({ figureId: "f1", displayText: "$64.601B", source: "filing" });
    expect(cc1.right).toEqual({
      figureId: "f2", displayText: "$64.57B", source: "bogey",
      bogey: { label: "Revenue consensus", value: 64_570_000_000, unit: "usd", provenance: "Finnhub consensus", asOf: "2026-10-20" },
    });
    expect(cc1.leftHigh).toBeUndefined();
    expect(cc1.shownText).toBe("+0.05%");
    // A range operand and an operand the model never supplied.
    expect(cc2.left?.displayText).toBe("$1.10");
    expect(cc2.leftHigh?.displayText).toBe("$1.20");
    expect(cc2.right).toBeNull();
  });

  it("the panel's Top claims carry the same descriptors", () => {
    seedDoneRun();
    const panel = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(panel.shown?.top[0].comparisonChecks[0].right?.bogey?.provenance).toBe("Finnhub consensus");
  });

  it("only public bogey fields leave the view (R15)", () => {
    seedDoneRun();
    const json = JSON.stringify([getFullView(db, eventId, CATALOG), getPanelViews(db, [eventId], CATALOG)]);
    expect(json).not.toContain("CANARY-NOTES-4411");
  });
});

describe("model quote on an unlocated footnote (2b)", () => {
  it("carries the citation's quote only when the footnote is not found", () => {
    seedDoneRun();
    const [found, missing] = getFullView(db, eventId, CATALOG)!.runs[0].sections[0].claims[0].footnotes;
    expect(found.modelQuote).toBeNull();
    expect(missing.modelQuote).toBe("a quote the model made up");
  });
});

describe("panel readingDocs and choiceOptions (2c)", () => {
  it("names the running section's form and its fetched exhibits", () => {
    const { id: filingId } = insertFiling(db, filing("0000000001-26-000002"));
    for (const [i, [name, type, status]] of ([
      ["form8k.htm", "8-K", "fetched"],
      ["ex99-1.htm", "EX-99.1", "fetched"],
      ["ex99-2.htm", "EX-99.2", "fetched"],
      ["ex10-1.htm", "EX-10.1", "fetched"],
      ["ex101.xml", "EX-101.INS", "skipped"],
    ] as const).entries()) {
      upsertDocument(db, {
        filingId, fileName: name, docType: type, sequence: i + 1, status,
        skipReason: status === "skipped" ? "skipped kind" : null, sha256: null, byteLen: null, storedPath: null,
      });
    }
    createRun(db, {
      eventId, trigger: "auto", choice: { family: "opus", effort: "high" }, modelId: "claude-opus-5-5",
      fallbackNote: null, requestKey: null, bogeySnapshotJson: "[]", filingIds: [filingId],
    });
    const panel = getPanelViews(db, [eventId], CATALOG)[eventId];
    // EX-101.INS is skipped, so it does not count; the run's first section is pending.
    expect(panel.readingDocs).toEqual({ form: "8-K", exhibits: 4 - 1 });
  });

  it("is null when nothing runs, and lists all five choices with their now-labels", () => {
    seedDoneRun();
    const panel = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(panel.readingDocs).toBeNull();
    expect(panel.choiceOptions.map((o) => o.value)).toEqual(SUMMARY_CHOICES.map(choiceValue));
    expect(panel.choiceOptions.map((o) => o.label)).toEqual(SUMMARY_CHOICES.map(choiceLabel));
    expect(panel.choiceOptions.find((o) => o.value === "fable·high")?.nowLabel).toBe("Fable · now 5.1");
    expect(getFullView(db, eventId, CATALOG)!.choice.options).toEqual(panel.choiceOptions);
  });
});

describe("the runner's namespaced claim ids (browser pass Bug 1)", () => {
  // The runner stores checked claim ids as `s<seq>.<id>`; output_json keeps the model's raw ids.
  it("joins a namespaced checked claim to the model's raw-id claim", () => {
    const { runId } = seedDoneRun("s1.c1");
    const seq = db.prepare("SELECT seq FROM filing_summary_sections WHERE run_id=?").get(runId) as { seq: number };
    expect(seq.seq).toBe(1);
    const claim = getFullView(db, eventId, CATALOG)!.runs[0].sections[0].claims[0];
    expect(claim.claimId).toBe("s1.c1");
    const [cc1, cc2] = claim.comparisonChecks;
    expect(cc1.left).toEqual({ figureId: "f1", displayText: "$64.601B", source: "filing" });
    expect(cc1.right?.bogey?.provenance).toBe("Finnhub consensus");
    expect(cc2.leftHigh?.displayText).toBe("$1.20");
    const [found, missing] = claim.footnotes;
    expect(found.modelQuote).toBeNull();
    expect(missing.modelQuote).toBe("a quote the model made up");
    const panel = getPanelViews(db, [eventId], CATALOG)[eventId];
    expect(panel.shown?.top[0].comparisonChecks[0].left?.displayText).toBe("$64.601B");
  });
});

describe("pastWithoutSummary (browser pass Bug 2)", () => {
  // The event is dated 2026-10-22.
  const NEXT_DAY = new Date("2026-10-23T15:00:00Z");
  const SAME_DAY_LATE = new Date("2026-10-23T03:30:00Z"); // 23:30 Eastern on 2026-10-22

  it("is true for an earlier day's print with no filing-summary state and no run", () => {
    expect(getPanelViews(db, [eventId], CATALOG, NEXT_DAY)[eventId].pastWithoutSummary).toBe(true);
  });

  it("is false on the print's own Eastern day, even after UTC midnight", () => {
    expect(getPanelViews(db, [eventId], CATALOG, SAME_DAY_LATE)[eventId].pastWithoutSummary).toBe(false);
  });

  it("is false once the event has a filing-summary state row or a run", () => {
    upsertEventState(db, eventId, { pollState: "past_cutoff" });
    expect(getPanelViews(db, [eventId], CATALOG, NEXT_DAY)[eventId].pastWithoutSummary).toBe(false);
  });
});
