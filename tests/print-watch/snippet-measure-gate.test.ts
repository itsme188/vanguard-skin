// QA finding `dashboard-today-earnings-hub-…-sheet-accepts-company-revenue-g`
// (owner ruling 2026-11-01): a metric line accepts a figure only when the cited
// snippet names the metric. Two readers agreeing on a number lifted from a
// sentence about a DIFFERENT measure (total revenue for a segment growth line)
// is not agreement on the line. Synthetic labels and round figures only.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcile } from "@/lib/print-watch/reconcile";
import {
  snippetMeasureMismatch,
  SNIPPET_NAMES_ANOTHER_MEASURE,
} from "@/lib/print-watch/snippet-measure-gate";
import { getSheet, upsertLines, upsertPrint } from "@/lib/print-watch/store";
import { factsFromLines } from "@/lib/print-watch/read-facts";
import type { LineContract, PrintWatchLine, TaggedCandidate } from "@/lib/print-watch/types";

function contract(o: Partial<LineContract> = {}): LineContract {
  return {
    metric_id: "x_widget_growth_Q",
    label: "Widget revenue growth",
    definition: "Year-over-year growth in Widget revenue for the quarter.",
    basis: "na",
    period: "Q",
    currency: "USD",
    unit: "percent",
    kind: "point",
    segment: null,
    ...o,
  };
}

function cand(o: Partial<TaggedCandidate> = {}): TaggedCandidate {
  return {
    metric_id: "x_widget_growth_Q",
    value: 12,
    value_high: null,
    raw_text: "12 percent",
    snippet: "The Company posted quarterly revenue of $10.0 billion, up 12 percent year over year",
    location_hint: null,
    not_disclosed: false,
    doc_id: 1,
    representation: "repA",
    weak_pair: false,
    ...o,
  };
}

const OFF_MEASURE = "The Company posted quarterly revenue of $10.0 billion, up 12 percent year over year";
const ON_MEASURE = "Widget revenue grew 12 percent from the year-ago quarter";

describe("snippetMeasureMismatch (pure lexical gate)", () => {
  it("a specific label needs its distinguishing word in the snippet", () => {
    expect(snippetMeasureMismatch(contract(), OFF_MEASURE)).toBe(SNIPPET_NAMES_ANOTHER_MEASURE);
    expect(snippetMeasureMismatch(contract(), ON_MEASURE)).toBeNull();
  });

  it("the reason reads 'snippet names another measure'", () => {
    expect(SNIPPET_NAMES_ANOTHER_MEASURE).toBe("snippet names another measure");
  });

  it("case, punctuation and simple plurals do not matter", () => {
    expect(snippetMeasureMismatch(contract(), "WIDGETS: revenue +12%")).toBeNull();
    expect(snippetMeasureMismatch(contract({ label: "Gadget units" }), "gadget unit shipments rose 12 percent")).toBeNull();
  });

  it("every distinguishing word must appear, not just one of them", () => {
    const c = contract({ label: "Gadget operating margin" });
    expect(snippetMeasureMismatch(c, "Operating margin was 12 percent")).toBe(SNIPPET_NAMES_ANOTHER_MEASURE);
    expect(snippetMeasureMismatch(c, "Gadget operating margin was 12 percent")).toBeNull();
  });

  it("a stored segment name is an accepted alias", () => {
    const c = contract({ label: "Segment A revenue", segment: "Widget Cloud" });
    expect(snippetMeasureMismatch(c, "Widget Cloud revenue was $1.0 billion")).toBeNull();
    expect(snippetMeasureMismatch(c, OFF_MEASURE)).toBe(SNIPPET_NAMES_ANOTHER_MEASURE);
  });

  it("a proper-noun word from the definition is an accepted alias", () => {
    const c = contract({ label: "Net new ARR", definition: "Net new annual recurring revenue for Widgetron." });
    expect(snippetMeasureMismatch(c, "Widgetron annual recurring revenue added $10 million")).toBeNull();
    expect(snippetMeasureMismatch(c, "Total revenue added $10 million")).toBe(SNIPPET_NAMES_ANOTHER_MEASURE);
  });

  it("a generic-only label has no distinguishing word and passes", () => {
    for (const label of ["Revenue", "EPS (Adj.)", "EPS (GAAP)", "Revenue Guidance (Next Q)", "EPS (Adj.) Guidance (Next Q)"]) {
      expect(snippetMeasureMismatch(contract({ label, definition: "Total quarterly revenue." }), OFF_MEASURE)).toBeNull();
    }
  });

  it("never throws on missing or odd data; a null snippet is unchanged behaviour", () => {
    expect(snippetMeasureMismatch(contract(), null)).toBeNull();
    expect(snippetMeasureMismatch(contract(), "")).toBeNull();
    expect(snippetMeasureMismatch(contract({ label: undefined as unknown as string, definition: null as unknown as string }), OFF_MEASURE)).toBeNull();
    expect(snippetMeasureMismatch(null as unknown as LineContract, OFF_MEASURE)).toBeNull();
  });
});

describe("reconcile applies the gate", () => {
  it("two independent readers agreeing on an off-measure figure leave the line unconfirmed, not agreed", () => {
    const [line] = reconcile([contract()], {}, [cand({ doc_id: 1 }), cand({ doc_id: 2 })], []);
    expect(line.state).toBe("single_source");
    expect(line.state_reason).toBe(SNIPPET_NAMES_ANOTHER_MEASURE);
    expect(line.value).toBe(12);
    expect(line.snippet).toBe(OFF_MEASURE);
  });

  it("one off-measure reader among agreeing readers is enough to block agreement", () => {
    const [line] = reconcile([contract()], {}, [cand({ doc_id: 1, snippet: ON_MEASURE }), cand({ doc_id: 2 })], []);
    expect(line.state).toBe("single_source");
    expect(line.state_reason).toBe(SNIPPET_NAMES_ANOTHER_MEASURE);
  });

  it("snippets that name the metric still agree, with no reason attached", () => {
    const [line] = reconcile(
      [contract()],
      {},
      [cand({ doc_id: 1, snippet: ON_MEASURE }), cand({ doc_id: 2, snippet: "Widget revenue up 12% y/y" })],
      [],
    );
    expect(line.state).toBe("agreed");
    expect(line).not.toHaveProperty("state_reason");
  });

  it("a single off-measure candidate is single source with the reason", () => {
    const [line] = reconcile([contract()], {}, [cand()], []);
    expect(line.state).toBe("single_source");
    expect(line.state_reason).toBe(SNIPPET_NAMES_ANOTHER_MEASURE);
  });

  it("null snippets keep today's behaviour", () => {
    const [line] = reconcile([contract()], {}, [cand({ doc_id: 1, snippet: null }), cand({ doc_id: 2, snippet: null })], []);
    expect(line.state).toBe("agreed");
  });

  it("a value disagreement is still a conflict", () => {
    const [line] = reconcile([contract()], {}, [cand({ doc_id: 1 }), cand({ doc_id: 2, value: 13 })], []);
    expect(line.state).toBe("conflict");
  });
});

describe("downstream: Accept all agreed and the first-pass read", () => {
  it("the gated line is not among the agreed ids, and the first-pass read never scores it", () => {
    const lines = reconcile([contract()], {}, [cand({ doc_id: 1 }), cand({ doc_id: 2 })], []);
    const agreedIds = lines.filter((l) => l.state === "agreed").map((l) => l.metric_id);
    expect(agreedIds).toEqual([]);
    expect(factsFromLines(lines, null)).toEqual([]);
  });

  it("getSheet presents a stored agreed off-measure line as unconfirmed with the reason", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const eventId = Number(
      db
        .prepare(
          `INSERT INTO calendar_events (event_type, title, event_date, source, source_key, symbol)
           VALUES ('earnings', 'WIDG earnings', '2026-08-20', 'finnhub', 'finnhub:WIDG:2026-08-20', 'WIDG')`,
        )
        .run().lastInsertRowid,
    );
    const printId = upsertPrint(db, eventId, "WIDG", "2026-08-20", null);
    const stored: PrintWatchLine = {
      metric_id: "x_widget_growth_Q",
      contract: contract(),
      expected: null,
      state: "agreed",
      value: 12,
      value_high: null,
      snippet: OFF_MEASURE,
      source_doc_id: null,
      candidates_json: "[]",
    };
    const fine: PrintWatchLine = { ...stored, metric_id: "revenue_q", contract: contract({ metric_id: "revenue_q", label: "Revenue" }) };
    upsertLines(db, printId, [stored, fine]);
    const sheet = getSheet(db, printId);
    const gated = sheet.find((l) => l.metric_id === "x_widget_growth_Q")!;
    expect(gated.state).toBe("single_source");
    expect(gated.state_reason).toBe(SNIPPET_NAMES_ANOTHER_MEASURE);
    const ok = sheet.find((l) => l.metric_id === "revenue_q")!;
    expect(ok.state).toBe("agreed");
    expect(ok).not.toHaveProperty("state_reason");
  });
});
