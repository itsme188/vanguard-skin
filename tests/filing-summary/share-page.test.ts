/**
 * The shareable page (Task 12): escaped, script-free, sec.gov links only,
 * counts that agree with `countStatuses`, a plain sentence for every reason
 * code. Synthetic data only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { createRun, insertFiling } from "@/lib/filing-summary/store";
import { getFullView, type FullView } from "@/lib/filing-summary/view";
import {
  escapeHtml,
  renderSharePage,
  shareFileName,
  shareHeaderLine,
} from "@/lib/filing-summary/share-page";
import { countStatuses, REASON_CODES } from "@/lib/filing-summary/evaluate";
import { countsText, hasReasonText } from "@/lib/filing-summary/labels";
import type { CheckedClaim, CheckedSection, ModelSectionOutput } from "@/lib/filing-summary/types";

const CATALOG = ["claude-opus-5-5"];
let db: Database.Database;
let eventId: number;
let runId: number;

const claims: CheckedClaim[] = [
  {
    claimId: "s1.c1",
    renderedText: "Revenue <script>alert(1)</script> beat the bogey.",
    status: "contradicted",
    top: true,
    routine: false,
    footnotes: [
      { citationId: "q1", document: "ex991.htm", status: "found", page: null, para: 3,
        sentence: "Revenue was \"strong\" & rising.", url: "javascript:alert(1)" },
      { citationId: "q2", document: "ex991.htm", status: "not_found", page: null, para: null, sentence: null, url: null },
    ],
    figureChecks: [],
    comparisonChecks: [
      { relation: "above", verdict: "contradicted", difference: -1, differencePct: -0.1,
        shownText: "-0.10%", reasons: [{ code: "relation_contradicted", figureId: null, detail: "x" }] },
    ],
    reasons: [{ code: "relation_contradicted", figureId: null, detail: "x" }],
    correction: null,
  },
  { claimId: "s1.c2", renderedText: "Margins held.", status: "checked", top: false, routine: false,
    footnotes: [], figureChecks: [], comparisonChecks: [], reasons: [], correction: null },
  { claimId: "s1.c3", renderedText: "Guidance is in line.", status: "unconfirmed", top: false, routine: false,
    footnotes: [], figureChecks: [{ figureId: "f1", established: false, foundValue: null,
      reasons: [{ code: "metric_unconfirmed", figureId: "f1", detail: "" }] }],
    comparisonChecks: [], reasons: [], correction: null },
];

// fiscalQuarter null: the header test below expects no quarter label.
const PERIOD = { kind: "quarter", role: "actual", endDate: null, fiscalYear: 2026, fiscalQuarter: null, anchor: null, label: "Q3 2026" } as const;
const output: ModelSectionOutput = {
  headline: "Mixed",
  bullets: [{
    top: true, routine: false,
    claims: [{
      id: "s1.c1", text: "Revenue {f1} beat {f2}.",
      citations: [
        { id: "q1", document: "ex991.htm", quote: "Revenue was strong", isTableRow: false },
        { id: "q2", document: "ex991.htm", quote: "A <made up> quote", isTableRow: false },
      ],
      figures: [
        { id: "f1", valueText: "$64.5B", value: 64.5, unit: "usd", scale: "billions", metric: "revenue", period: { ...PERIOD },
          basis: "reported", basisNote: null, sourceKind: "quote", citationId: "q1", label: "Revenue", bogeyKey: null, operation: null, inputs: [] },
        { id: "f2", valueText: "$64.57B", value: 64.57, unit: "usd", scale: "billions", metric: "revenue", period: { ...PERIOD },
          basis: "reported", basisNote: null, sourceKind: "bogey", citationId: null, label: null, bogeyKey: "b1.revenue_consensus_usd", operation: null, inputs: [] },
      ],
      comparisons: [{ left: "f1", leftHigh: null, right: "f2", rightHigh: null, relation: "above" }],
      corrects: null,
    }],
  }],
};

function view(): FullView {
  return getFullView(db, eventId, CATALOG)!;
}

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
  const { id: f1 } = insertFiling(db, {
    eventId, accession: "0000000001-26-000001", cik: "0000000001", form: "8-K", role: "earnings",
    items: "2.02", acceptedAt: "2026-10-22T20:05:00.000Z", discoveredAt: "2026-10-22T20:06:00.000Z",
    identityVerdict: "accepted", identityReason: null, fetchState: "fetched",
  });
  runId = createRun(db, {
    eventId, trigger: "auto", choice: { family: "opus", effort: "high" }, modelId: "claude-opus-5-5",
    fallbackNote: null, requestKey: null, filingIds: [f1],
    bogeySnapshotJson: JSON.stringify([
      { key: "b1.revenue_consensus_usd", label: "Revenue consensus", value: 64_570_000_000, unit: "usd",
        scale: "units", period: {}, basis: "reported", provenance: "Synthetic Weekly <b>", asOf: "2026-10-20",
        rowKind: "newsletter" },
    ]),
  }).runId;
  const checked: CheckedSection = { headline: "Mixed <i>quarter</i>", claims, counts: countStatuses(claims) };
  db.prepare(
    `UPDATE filing_summary_sections SET status='done', checked_json=?, output_json=?, incomplete=1,
       coverage_json=?, model_id='claude-opus-5-5', effort='high' WHERE run_id=?`,
  ).run(
    JSON.stringify(checked),
    JSON.stringify(output),
    JSON.stringify([
      { fileName: "ex991.htm", docType: "EX-99.1", status: "read", reason: null },
      { fileName: "logo.jpg", docType: "GRAPHIC", status: "skipped", reason: "graphic" },
    ]),
    runId,
  );
  db.prepare("UPDATE filing_summary_runs SET status='done' WHERE id=?").run(runId);
});

describe("renderSharePage", () => {
  it("escapes every text and carries no script", () => {
    const html = renderSharePage(view(), runId);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("Revenue &lt;script&gt;alert(1)&lt;/script&gt; beat the bogey.");
    expect(html).toContain("Mixed &lt;i&gt;quarter&lt;/i&gt;");
    expect(html).toContain("Synthetic Weekly &lt;b&gt;");
    expect(html).toContain("Revenue was &quot;strong&quot; &amp; rising.");
    expect(html).not.toContain("javascript:");
  });

  it("links only to sec.gov archive URLs", () => {
    const html = renderSharePage(view(), runId);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h.startsWith("https://www.sec.gov/Archives/edgar/data/")).toBe(true);
    expect(html).not.toContain("/dashboard");
    expect(html).not.toContain("/api/");
  });

  it("states the header counts exactly as countStatuses gives them", () => {
    const v = view();
    const html = renderSharePage(v, runId);
    const expected = countsText(countStatuses(claims));
    expect(expected).toBe("3 claims · 1 checked · 1 contradicted · 1 unconfirmed");
    expect(shareHeaderLine(v, v.runs[0])).toBe(`SYNW · filing summary · Opus 5.5 high · ${expected}`);
    expect(html).toContain(`<h1>${escapeHtml(`SYNW · filing summary · Opus 5.5 high · ${expected}`)}</h1>`);
  });

  it("shows the incomplete banner, reasons, the shown difference, bogey provenance and filing time", () => {
    const html = renderSharePage(view(), runId);
    expect(html).toContain("Incomplete:");
    expect(html).toContain("The filing&#39;s own figures do not support the stated comparison.");
    expect(html).toContain("The number is in the cited line, but the line&#39;s label does not name this metric.");
    // Ruling A: the comparison line names both operands and the bogey's source and date.
    expect(html).toContain(
      `<li class="s-danger">${escapeHtml("filing: $64.5B is below $64.57B (Synthetic Weekly <b>, 2026-10-20), -0.10%")}</li>`,
    );
    // Ruling B: an unlocated quote prints the quote as the model gave it, escaped.
    expect(html).toContain(escapeHtml("Quote as the model gave it: “A <made up> quote”"));
    expect(html).not.toContain("<made up>");
    expect(html).toContain("$64.57B");
    expect(html).toContain("2026-10-20");
    expect(html).toContain("accepted 4:05 pm ET");
    expect(html).toContain("paragraph 3");
    expect(html).toContain("logo.jpg (GRAPHIC): skipped — graphic");
    expect(html).toContain("1 Top claim is contradicted");
  });

  it("has light and dark themes and a phone viewport", () => {
    const html = renderSharePage(view(), runId);
    expect(html).toContain("@media (prefers-color-scheme:dark)");
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });

  it("throws for a run not in the view", () => {
    expect(() => renderSharePage(view(), runId + 100)).toThrow();
  });

  it("names the file from validated parts", () => {
    expect(shareFileName(view(), 7)).toBe("SYNW-2026-10-22-filing-summary-run7.html");
  });

  it("never prints a section's stored error text, only a fixed sentence for its class", () => {
    db.prepare(
      "UPDATE filing_summary_sections SET status='failed', error_class='timeout', error_text='CANARY-ERR' WHERE run_id=?",
    ).run(runId);
    db.prepare("UPDATE filing_summary_runs SET status='failed' WHERE id=?").run(runId);
    const html = renderSharePage(view(), runId);
    expect(html).not.toContain("CANARY-ERR");
    expect(html).toContain("Not summarised: the model call timed out.");
  });

  it("reads the severity class by own property only", () => {
    const v = view();
    (v.runs[0].sections[0].claims[0] as { status: string }).status = "constructor";
    const html = renderSharePage(v, runId);
    expect(html).toContain('class="status s-muted"');
    expect(html).not.toContain("s-function");
  });
});

describe("reason sentences", () => {
  it("has a sentence for every reason code the checker can emit", () => {
    const missing = REASON_CODES.filter((c) => !hasReasonText(c));
    expect(missing).toEqual([]);
  });
});
