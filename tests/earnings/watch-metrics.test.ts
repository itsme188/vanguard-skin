/**
 * Watch metrics (2026-10-20): the company-specific figures a preview says a
 * print is judged on become extra metric lines on the live sheet.
 *
 * Under test:
 *   1. `parseWatchMetrics`: validation, the value-free label/definition rule,
 *      built-in duplicates dropped, kind derived from the period, a derived id
 *      that passes the extra-metrics validator.
 *   2. `mergeWatchMetricsJson`: a stored spec is never dropped or rewritten.
 *   3. End to end through the newsletter scan: two issues naming the same
 *      figure land on ONE sheet line (`compileContracts`), with the first
 *      issue's bogey, and the global scan banks its ledger rows.
 *   4. `upsertBogey` with a NULL label updates the row it found instead of
 *      inserting a duplicate the sheet would read first (bug audit 2026-10-20).
 *
 * Synthetic issuers, newsletter names and figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })),
}));

import {
  carriesFigure,
  mergeWatchMetricsJson,
  parseWatchMetrics,
  watchMetricId,
  existingWatchLinesForEvent,
  MAX_WATCH_METRICS_PER_EXTRACTION,
} from "@/lib/earnings/watch-metrics";
import { parseExtraMetrics, isUuidV4 } from "@/lib/print-watch/extra-metrics";
import { compileContracts } from "@/lib/print-watch/contracts";
import {
  buildExtractionPrompt,
  extractBogeysFromArticleForEvent,
  extractBogeysFromNewArticles,
  NEWSLETTER_EXTRACTOR_VERSION,
  type ArticleInput,
} from "@/lib/earnings/extract-newsletter-bogeys";
import { parseExtractionResponse as parseUploadResponse } from "@/lib/earnings/extract-bogeys";
import { upsertBogey } from "@/lib/mutations/earnings-bogeys";
import { todayET, addDays } from "@/lib/calendar/date-utils";

const GM = {
  label: "Gross margin",
  definition: "Non-GAAP gross margin for the quarter, as a percent of revenue.",
  unit: "pct",
  period: "Q",
  basis: "non_gaap",
  consensus: 44.5,
  whisper: "45%",
};
const GM_GUIDE = {
  label: "Gross margin guide",
  definition: "Next-quarter non-GAAP gross margin guidance.",
  unit: "pct",
  period: "NQ_guide",
  basis: "non_gaap",
  consensus: null,
  whisper: null,
};
const REGION = {
  label: "Northland revenue growth",
  definition: "Year-over-year revenue growth in the Northland region, reported basis.",
  unit: "pct",
  period: "Q",
  basis: "na",
  consensus: null,
  whisper: null,
};

describe("parseWatchMetrics", () => {
  it("reads valid lines into specs the extra-metrics validator accepts", () => {
    const specs = parseWatchMetrics([GM, GM_GUIDE, REGION]);
    expect(specs.map((s) => s.label)).toEqual(["Gross margin", "Gross margin guide", "Northland revenue growth"]);
    expect(specs[0]).toMatchObject({ unit: "pct", period: "Q", basis: "non_gaap", consensus: 44.5, whisper: 45 });
    // A topic with no number is a line with no bogey.
    expect(specs[2]).toMatchObject({ consensus: null, whisper: null });
    for (const s of specs) expect(isUuidV4(s.id)).toBe(true);
    expect(parseExtraMetrics(JSON.stringify(specs)).errors).toEqual([]);
  });

  it("derives kind from the period: point for the quarter, range for a guide, whatever the model said", () => {
    const [q, g] = parseWatchMetrics([{ ...GM, kind: "range" }, { ...GM_GUIDE, kind: "point" }]);
    expect(q.kind).toBe("point");
    expect(g.kind).toBe("range");
  });

  it("reads usd figures as raw dollars, abbreviated or not", () => {
    const [arr] = parseWatchMetrics([
      { label: "Net new ARR", definition: "Net new annual recurring revenue added in the quarter.", unit: "usd", period: "Q", basis: "na", consensus: "$305M", whisper: 320_000_000 },
    ]);
    expect(arr.consensus).toBe(305_000_000);
    expect(arr.whisper).toBe(320_000_000);
  });

  it("drops a line whose label carries a figure, and replaces a definition that does", () => {
    expect(parseWatchMetrics([{ ...GM, label: "Gross margin vs 44.5%" }])).toEqual([]);
    const [s] = parseWatchMetrics([{ ...GM, definition: "Street is at 44.5% and the buyside wants 45%." }]);
    expect(s.definition).toBe("Gross margin, the quarter being reported.");
    expect(carriesFigure("FQ2 gross margin, FY27 guide")).toBe(false);
    expect(carriesFigure("$1.5B")).toBe(true);
    expect(carriesFigure("~300")).toBe(true);
  });

  it("drops total revenue and EPS for the quarter and the next-quarter guide: the sheet has those lines", () => {
    const built = [
      { label: "Revenue", definition: "Total revenue.", unit: "usd", period: "Q", basis: "na" },
      { label: "Adjusted EPS", definition: "Adjusted EPS.", unit: "per_share", period: "Q", basis: "non_gaap" },
      { label: "Revenue guidance", definition: "Next-quarter revenue.", unit: "usd", period: "NQ_guide", basis: "na" },
    ];
    expect(parseWatchMetrics(built)).toEqual([]);
    // A full-year revenue guide has no built-in line, so it stays.
    expect(parseWatchMetrics([{ ...built[2], period: "FY_guide" }])).toHaveLength(1);
  });

  it("drops malformed elements one by one and caps the count", () => {
    const bad = [null, "x", { ...GM, unit: "dollars" }, { ...GM, period: "Q3" }, { ...GM, label: "" }];
    expect(parseWatchMetrics(bad)).toEqual([]);
    expect(parseWatchMetrics("not an array")).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => ({ ...REGION, label: `Region ${"abcdefghi"[i]} revenue growth` }));
    expect(parseWatchMetrics(many)).toHaveLength(MAX_WATCH_METRICS_PER_EXTRACTION);
  });

  it("gives one figure one id however the basis and period words are spelled in the label", () => {
    const a = watchMetricId({ label: "Gross margin (non-GAAP)", period: "Q", unit: "pct", basis: "non_gaap" });
    const b = watchMetricId({ label: "Non-GAAP gross margin", period: "Q", unit: "pct", basis: "non_gaap" });
    const c = watchMetricId({ label: "FQ2 Gross Margin", period: "Q", unit: "pct", basis: "non_gaap" });
    expect(a).toBe(b);
    expect(a).toBe(c);
    // A different period or basis is a different measurement.
    expect(watchMetricId({ label: "Gross margin", period: "NQ_guide", unit: "pct", basis: "non_gaap" })).not.toBe(a);
    expect(watchMetricId({ label: "Gross margin", period: "Q", unit: "pct", basis: "gaap" })).not.toBe(a);
  });
});

describe("mergeWatchMetricsJson", () => {
  it("keeps every stored spec, fills a missing figure, adds new ids", () => {
    const [gmTopic] = parseWatchMetrics([{ ...GM, consensus: null, whisper: null }]);
    const stored = JSON.stringify([{ ...gmTopic, label: "GM (desk edit)" }]);
    const incoming = parseWatchMetrics([GM, REGION]);
    const merged = parseExtraMetrics(mergeWatchMetricsJson(stored, incoming)).specs;
    expect(merged.map((s) => s.label)).toEqual(["GM (desk edit)", "Northland revenue growth"]);
    expect(merged[0]).toMatchObject({ consensus: 44.5, whisper: 45 });
  });

  it("never touches a stored value it cannot read, and stores nothing for nothing", () => {
    expect(mergeWatchMetricsJson("{broken", parseWatchMetrics([GM]))).toBe("{broken");
    expect(mergeWatchMetricsJson(null, [])).toBeNull();
    expect(mergeWatchMetricsJson("[]", [])).toBeNull();
  });
});

describe("upload extractor", () => {
  it("parses watch_metrics off an uploaded sheet", () => {
    const out = parseUploadResponse(JSON.stringify([{ symbol: "XMPL", eps_consensus: 1.1, watch_metrics: [GM] }]));
    expect(out[0].watch_metrics.map((s) => s.label)).toEqual(["Gross margin"]);
    expect(parseUploadResponse(JSON.stringify([{ symbol: "XMPL" }]))[0].watch_metrics).toEqual([]);
  });
});

// ── end to end through the newsletter scan ─────────────────────────────────

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});
afterEach(() => generateTextMock.mockReset());

const FILLER =
  " Desk prose that exists only to clear the two-hundred-character floor the scan query enforces on a newsletter body.".repeat(3);

function seedEvent(symbol = "XMPL"): number {
  const date = addDays(todayET(), 2);
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('manual','earnings',?,?,?,?)`,
      )
      .run(date, symbol, `manual:${symbol}:${date}`, symbol).lastInsertRowid,
  );
  // Armed, so the global scan treats the event as covered.
  db.prepare(`INSERT INTO earnings_worksheet_flags (event_id) VALUES (?)`).run(eventId);
  return eventId;
}

function seedArticle(text: string, receivedAt: string): number {
  db.prepare(`INSERT OR IGNORE INTO research_sources (id, name) VALUES (9001, 'Desk Notes')`).run();
  return Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, subject, sender, received_at, raw_text)
         VALUES (9001, 'Preview', 'desk@example.test', ?, ?)`,
      )
      .run(receivedAt, text + FILLER).lastInsertRowid,
  );
}

const hoursAgo = (h: number) =>
  new Date(Date.now() - h * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

const loadArticle = (id: number): ArticleInput =>
  db
    .prepare(
      `SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text
         FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id WHERE a.id = ?`,
    )
    .get(id) as ArticleInput;

describe("newsletter scan -> sheet lines", () => {
  it("two issues naming one figure make ONE sheet line, with the first issue's bogey", async () => {
    const ev = seedEvent();
    const a1 = seedArticle("XMPL preview: margins are the debate", hoursAgo(30));
    const a2 = seedArticle("XMPL again: gross margin still the debate", hoursAgo(3));

    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify([{ symbol: "XMPL", eps_consensus: 1.1, watch_metrics: [GM, GM_GUIDE] }]),
    });
    await extractBogeysFromArticleForEvent(db, loadArticle(a1), { event_id: ev, symbol: "XMPL", event_date: "x" });
    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify([{ symbol: "XMPL", watch_metrics: [{ ...GM, label: "Gross Margin (non-GAAP)", consensus: 44.0 }, REGION] }]),
    });
    await extractBogeysFromArticleForEvent(db, loadArticle(a2), { event_id: ev, symbol: "XMPL", event_date: "x" });

    // The second call was told what the sheet already had.
    const secondPrompt = (generateTextMock.mock.calls[1][1] as { prompt: string }).prompt;
    expect(secondPrompt).toContain(`"Gross margin" [pct, Q, non_gaap]`);
    expect(secondPrompt).toContain("WATCH METRICS");

    const { contracts, expected, conflicts } = compileContracts(db, ev, "XMPL");
    expect(conflicts).toEqual([]);
    const extra = contracts.filter((c) => c.metric_id.startsWith("x_"));
    expect(extra.map((c) => c.label)).toEqual(["Gross margin", "Gross margin guide", "Northland revenue growth"]);
    const gmLine = extra[0];
    expect(gmLine).toMatchObject({ unit: "percent", period: "Q", basis: "non_gaap", kind: "point" });
    // First issue by rowid wins the consensus; its source label is recorded.
    expect(expected[gmLine.metric_id]).toMatchObject({ value: 44.5, whisper: 45 });
    // A topic line has no bogey entry at all.
    expect(expected[extra[2].metric_id]).toBeUndefined();
    // No definition handed to the release extractor carries a figure.
    for (const c of extra) expect(carriesFigure(c.definition)).toBe(false);
    expect(existingWatchLinesForEvent(db, ev)).toHaveLength(3);
  });

  it("a watch-metrics-only mention is stored, and the global scan banks its ledger row", async () => {
    const ev = seedEvent();
    const a1 = seedArticle("XMPL: all about the Northland recovery", hoursAgo(2));
    generateTextMock.mockResolvedValueOnce({ text: JSON.stringify([{ symbol: "XMPL", watch_metrics: [REGION] }]) });

    const r = await extractBogeysFromNewArticles(db);
    expect(r.bogeysStored).toBe(1);
    const row = db.prepare(`SELECT extra_metrics_json FROM earnings_bogeys WHERE event_id = ?`).get(ev) as {
      extra_metrics_json: string;
    };
    expect(parseExtraMetrics(row.extra_metrics_json).specs.map((s) => s.label)).toEqual(["Northland revenue growth"]);
    expect(
      db.prepare(`SELECT article_id, extractor_version, status, attempts FROM earnings_bogey_scans WHERE event_id = ?`).all(ev),
    ).toEqual([{ article_id: a1, extractor_version: NEWSLETTER_EXTRACTOR_VERSION, status: "hit", attempts: 0 }]);
  });

  it("the prompt asks for watch metrics and lists a reporter's existing lines", () => {
    const prompt = buildExtractionPrompt(
      { id: 1, source_name: "Desk Notes", subject: "s", received_at: "r", raw_text: "XMPL" },
      [{ symbol: "XMPL", event_id: 1, event_date: "2026-10-22", existing_lines: [`"Gross margin" [pct, Q, non_gaap]`] }],
    );
    expect(prompt).toContain("XMPL (reports 2026-10-22); lines already on its sheet: \"Gross margin\" [pct, Q, non_gaap]");
    expect(prompt).toContain(`"watch_metrics"`);
    expect(prompt).toContain(`"China recovery" -> Greater China revenue growth`);
  });
});

describe("upsertBogey with no label (bug audit 2026-10-20)", () => {
  it("a second save of an unlabelled hand-entered sheet updates it: one row, and the sheet shows the new figure", () => {
    const ev = seedEvent();
    const first = upsertBogey(db, { event_id: ev, source: "manual", source_label: null, eps_consensus: 0.46 });
    const second = upsertBogey(db, { event_id: ev, source: "manual", source_label: null, eps_consensus: 0.5 });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM earnings_bogeys WHERE event_id = ?`).get(ev)).toEqual({ n: 1 });
    expect(compileContracts(db, ev, "XMPL").expected.eps_adj_q.value).toBe(0.5);
  });

  it("where duplicates were already stored, the oldest row (the one the sheet reads) takes the new figure", () => {
    const ev = seedEvent();
    const ins = db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus) VALUES (?, 'manual', NULL, ?)`,
    );
    const oldest = Number(ins.run(ev, 0.4).lastInsertRowid);
    ins.run(ev, 0.45);
    expect(upsertBogey(db, { event_id: ev, source: "manual", source_label: null, eps_consensus: 0.5 }).id).toBe(oldest);
    expect(compileContracts(db, ev, "XMPL").expected.eps_adj_q.value).toBe(0.5);
  });

  it("preserve mode by id keeps a stored figure the incoming write lacks", () => {
    const ev = seedEvent();
    upsertBogey(db, { event_id: ev, source: "manual", source_label: null, eps_consensus: 0.46, notes: "n" });
    upsertBogey(db, { event_id: ev, source: "manual", source_label: null, eps_whisper: 0.5, preserveExisting: true });
    expect(
      db.prepare(`SELECT eps_consensus, eps_whisper, notes FROM earnings_bogeys WHERE event_id = ?`).get(ev),
    ).toEqual({ eps_consensus: 0.46, eps_whisper: 0.5, notes: "n" });
  });
});
