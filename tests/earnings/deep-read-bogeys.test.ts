/**
 * The armed-event deep read (2026-10-20): one frontier-tier call reads every
 * preview of the days before an armed print, matched by ticker OR company
 * name, and stores one reconciled bogey row that ranks above per-article rows.
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

import {
  companyNameAliases,
  gatherDeepReadInputs,
  parseDeepReadResponse,
  runDeepRead,
} from "@/lib/earnings/deep-read-bogeys";
import { makeNewsletterSynthesisStep } from "@/lib/earnings/prepare-steps/newsletter-synthesis";
import { DEEP_READ_BOGEY_LABEL } from "@/lib/earnings/bogey-claim";
import { compileContracts } from "@/lib/print-watch/contracts";
import { FEATURE_MODELS } from "@/lib/ai/models";

const FILLER = " Market color with nothing about any company in it, padding the body past the scan floor.".repeat(4);

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT OR IGNORE INTO research_sources (id, name) VALUES (9001, 'Desk Notes'), (9002, 'Tape Letter')`).run();
});
afterEach(() => generateTextMock.mockReset());

// An after-close print on 2026-10-22: the slot floor is 16:00 ET = 20:00 UTC (EDT).
function seedEvent(): number {
  db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('XMPL', 'Exemplar Devices, Inc.', 'Stock')`).run();
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, source_key, symbol)
         VALUES ('manual','earnings','2026-10-22','AMC','XMPL','manual:XMPL:2026-10-22','XMPL')`,
      )
      .run().lastInsertRowid,
  );
}

function seedArticle(source: number, receivedAtUtc: string, body: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, subject, sender, received_at, raw_text)
         VALUES (?, 'Weekly preview', 'desk@example.test', ?, ?)`,
      )
      .run(source, receivedAtUtc, body + FILLER).lastInsertRowid,
  );
}

describe("companyNameAliases", () => {
  it("drops corporate suffixes and keeps a distinctive first word", () => {
    expect(companyNameAliases("Exemplar Devices, Inc.")).toEqual(["Exemplar Devices", "Exemplar"]);
    expect(companyNameAliases("The Sample Company")).toEqual(["Sample"]);
    // A generic first word never stands alone.
    expect(companyNameAliases("General Widgets Corp")).toEqual(["General Widgets"]);
    expect(companyNameAliases(null)).toEqual([]);
  });
});

describe("gatherDeepReadInputs", () => {
  it("reads articles naming the company by ticker OR name, before the slot floor, newest first", () => {
    const ev = seedEvent();
    const byName = seedArticle(9001, "2026-10-20 12:00:00", "Exemplar into the print: gross margin is the debate.");
    const byTicker = seedArticle(9002, "2026-10-21 12:00:00", "XMPL whisper above the Street.");
    seedArticle(9001, "2026-10-21 13:00:00", "Nothing about our name here at all."); // no mention
    seedArticle(9002, "2026-10-22 20:30:00", "Exemplar beat and raised."); // after the 16:00 ET floor
    seedArticle(9001, "2026-10-01 12:00:00", "Exemplar, three weeks early."); // outside the window

    const inputs = gatherDeepReadInputs(db, ev)!;
    expect(inputs.cutoffIso).toBe("2026-10-22T20:00:00.000Z");
    expect(inputs.companyName).toBe("Exemplar Devices, Inc.");
    expect(inputs.articles.map((a) => a.id)).toEqual([byTicker, byName]);
    expect(inputs.articles[1].excerpt).toContain("gross margin is the debate");
    expect(inputs.articles[0].label).toBe("Tape Letter 10/21");
  });
});

describe("parseDeepReadResponse", () => {
  it("keeps only cited ids that were given, and reads the figures", () => {
    const out = parseDeepReadResponse(
      JSON.stringify([
        {
          eps_consensus: 1.2,
          revenue_whisper: "$2.1B",
          sources: [{ figure: "eps", article_id: 7 }, { figure: "rev", article_id: 999 }],
          conflicts: ["Desk Notes whisper 2.1B vs Tape Letter 2.0B"],
        },
      ]),
      new Set([7]),
    )!;
    expect(out.eps_consensus).toBe(1.2);
    expect(out.revenue_whisper).toBe(2_100_000_000);
    expect(out.sourceArticleIds).toEqual([7]);
    expect(out.conflicts).toHaveLength(1);
    expect(parseDeepReadResponse("not json", new Set())).toBeNull();
  });
});

describe("runDeepRead", () => {
  it("is on the frontier tier", () => {
    expect(FEATURE_MODELS.armedBogeyDeepRead).toBe("anthropic/$frontier");
  });

  it("stores one reconciled row that outranks a single-article newsletter row and the vendor row on the sheet", async () => {
    const ev = seedEvent();
    const a1 = seedArticle(9001, "2026-10-20 12:00:00", "Exemplar preview: Street EPS 1.10, buyside wants 1.25.");
    const a2 = seedArticle(9002, "2026-10-21 12:00:00", "XMPL: Street now 1.15 after revisions; whisper 1.30.");
    // What the per-article scan and the vendor step stored first (lower rowids).
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, research_article_id, eps_consensus, eps_whisper)
       VALUES (?, 'finnhub', 'Finnhub consensus', NULL, 1.05, NULL), (?, 'newsletter', 'Desk Notes 10/20', ?, 1.10, 1.25)`,
    ).run(ev, ev, a1);

    generateTextMock.mockResolvedValueOnce({
      text: JSON.stringify([
        {
          eps_consensus: 1.15,
          eps_whisper: 1.3,
          notes: "Margins are the debate.",
          watch_metrics: [
            { label: "Gross margin", definition: "Non-GAAP gross margin for the quarter.", unit: "pct", period: "Q", basis: "non_gaap", consensus: 44, whisper: null },
          ],
          sources: [{ figure: "eps", article_id: a2 }, { figure: "eps whisper", article_id: a2 }],
          conflicts: ["Desk Notes 10/20 had Street 1.10, Tape Letter 10/21 has 1.15 after revisions"],
        },
      ]),
    });

    const out = await runDeepRead(db, ev);
    expect(out).toMatchObject({ articlesRead: 2, stored: true });
    const [feature, opts] = generateTextMock.mock.calls[0] as [string, { prompt: string }];
    expect(feature).toBe("armedBogeyDeepRead");
    expect(opts.prompt).toContain(`=== ARTICLE ${a2} · Tape Letter 10/21`);
    expect(opts.prompt).toContain("most recent issue");

    const row = db
      .prepare(`SELECT source, research_article_id, eps_consensus, notes FROM earnings_bogeys WHERE source_label = ?`)
      .get(DEEP_READ_BOGEY_LABEL) as { source: string; research_article_id: number; eps_consensus: number; notes: string };
    expect(row).toMatchObject({ source: "newsletter", research_article_id: a2, eps_consensus: 1.15 });
    expect(row.notes).toContain("Disagreements:");
    expect(row.notes).toContain("From: Tape Letter 10/21");

    const { expected, contracts } = compileContracts(db, ev, "XMPL");
    expect(expected.eps_adj_q).toMatchObject({ value: 1.15, whisper: 1.3, source_label: DEEP_READ_BOGEY_LABEL });
    expect(contracts.some((c) => c.label === "Gross margin")).toBe(true);
  });

  it("a re-run replaces the reading; an empty answer stores nothing and leaves the last one", async () => {
    const ev = seedEvent();
    seedArticle(9001, "2026-10-20 12:00:00", "Exemplar preview.");
    generateTextMock.mockResolvedValueOnce({ text: JSON.stringify([{ eps_consensus: 1.15 }]) });
    await runDeepRead(db, ev);
    generateTextMock.mockResolvedValueOnce({ text: JSON.stringify([{ eps_consensus: 1.2 }]) });
    await runDeepRead(db, ev);
    generateTextMock.mockResolvedValueOnce({ text: "[{}]" });
    expect((await runDeepRead(db, ev)).stored).toBe(false);
    expect(db.prepare(`SELECT eps_consensus FROM earnings_bogeys WHERE source_label = ?`).all(DEEP_READ_BOGEY_LABEL)).toEqual([
      { eps_consensus: 1.2 },
    ]);
  });

  it("makes no call when no preview names the company", async () => {
    const ev = seedEvent();
    seedArticle(9001, "2026-10-20 12:00:00", "Nothing relevant.");
    expect(await runDeepRead(db, ev)).toEqual({ articlesRead: 0, stored: false, modelId: null });
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("newsletter_synthesis prepare step", () => {
  const ctx = { now: () => Date.now(), signal: new AbortController().signal };

  it("re-runs for a new preview before the floor, never for a recap after it", () => {
    const ev = seedEvent();
    const step = makeNewsletterSynthesisStep({ run: vi.fn() });
    seedArticle(9001, "2026-10-20 12:00:00", "Exemplar preview.");
    const fp1 = step.fingerprint(db, ev);
    seedArticle(9002, "2026-10-22 21:00:00", "Exemplar beat and raised."); // after the print
    expect(step.fingerprint(db, ev)).toBe(fp1);
    seedArticle(9002, "2026-10-21 12:00:00", "XMPL day-before preview.");
    expect(step.fingerprint(db, ev)).not.toBe(fp1);
  });

  it("books a model failure as failed, and nothing to read as done", async () => {
    const ev = seedEvent();
    const failing = makeNewsletterSynthesisStep({ run: vi.fn(async () => { throw new Error("overloaded"); }) });
    expect(await failing.run(db, ev, ctx)).toEqual({ status: "failed", error: "overloaded" });
    const empty = makeNewsletterSynthesisStep({ run: vi.fn(async () => ({ articlesRead: 0, stored: false, modelId: null })) });
    expect(await empty.run(db, ev, ctx)).toEqual({ status: "done", note: "no preview names the company yet" });
  });
});
