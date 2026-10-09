/**
 * The two PRINTED sheets (the pre-print worksheet and the post-print sheet)
 * carry the same "## Sheet bogeys — by source" table the email body carries.
 * Commit 28e56812 stopped the email from giving a column to a bogey row the
 * table shows nothing from; the two printed sheets still read every row, so an
 * all-empty row (or a notes-only one) was a column of dashes on paper.
 *
 * Both loaders now read through the same pair the email uses:
 * `sheetBogeysWithCells(getBogeysWithContentForEvent(...))`.
 *
 * A sheet for an event with normal curated rows is byte-identical to before.
 * Invented issuer and round figures only: the repo is public.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { loadPrintSheetInputs } from "@/lib/earnings/worksheet";
import { loadPostPrintSheetInputs } from "@/lib/earnings/post-print-sheet";
import { upsertPrint } from "@/lib/print-watch/store";
import { getBogeysForEvent } from "@/lib/queries/earnings-bogeys";
import { renderSheetBogeysBlock } from "@/lib/digest/send-earnings-email";

// Nothing here calls a model; the loaders only reach the composer's module graph.
vi.mock("@/lib/ai/provider", () => ({ getRawAnthropicClient: vi.fn() }));

const PREVIEW_AI_MD = `## Line-by-line bogies

| Metric | Consensus / Prior | Actual | Δ |
|---|---|---|---|
| Revenue | Street ~$100M | — | — |

## The setup

Body.
`;

let db: InstanceType<typeof Database>;
let eventId: number;
let printId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, event_time, release_time, title, symbol, source_key, week_of, consensus_estimate)
         VALUES ('finnhub','earnings','2026-08-04','AMC','16:05','ZZA earnings','ZZA','finnhub:ZZA:2026-08-04','2026-08-03','EPS 1.00 · Rev 100M')`,
      )
      .run().lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, ai_output_md, error)
     VALUES (?, 'preview', 'me@example.com', '2026-08-04 12:05:00', ?, NULL)`,
  ).run(eventId, PREVIEW_AI_MD);
  printId = upsertPrint(db, eventId, "ZZA", "2026-08-04", "16:05");
});

afterEach(() => db.close());

function seed(label: string, uploadedAt: string, cols: Record<string, unknown>, source = "newsletter"): void {
  const names = Object.keys(cols);
  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, source_label, uploaded_at${names.map((n) => `, ${n}`).join("")})
     VALUES (?, ?, ?, ?${names.map(() => ", ?").join("")})`,
  ).run(eventId, source, label, uploadedAt, ...Object.values(cols));
}

const worksheetMd = () => loadPrintSheetInputs(db, eventId)!.sheetBogeysMd;
const postPrintMd = () => loadPostPrintSheetInputs(db, printId)!.bogeysMd;

describe.each([
  ["pre-print worksheet", worksheetMd],
  ["post-print sheet", postPrintMd],
] as Array<[string, () => string]>)("%s: sheet-bogeys table", (_name, sheetMd) => {
  it("normal curated rows print byte-for-byte as before", () => {
    seed("TMT Sheet", "2026-08-02 12:00:00", {
      eps_consensus: 1.02,
      eps_whisper: 1.08,
      revenue_consensus_usd: 100_000_000,
      revenue_whisper_usd: 104_000_000,
      expected_move_pct: 6,
      segment_breakdown_json: '{"Cloud":{"consensus":40000000,"whisper":42000000}}',
      guidance_notes: "watch the guide",
    }, "pdf_upload");
    seed("Desk Sheet", "2026-08-03 12:00:00", { eps_consensus: 1.04 }, "manual");

    const expected = `## Sheet bogeys — by source

| Metric | Desk Sheet (8/03) | TMT Sheet (8/02) |
|---|---|---|
| EPS | 1.04 | 1.02 · **w 1.08** |
| Revenue | — | $100.0M · **w $104.0M** |
| Expected move | — | ±6.0% |
| Cloud (seg) | — | $40.0M · **w $42.0M** |`;
    expect(sheetMd()).toBe(expected);
    // And it is exactly what the old, unfiltered read rendered.
    expect(sheetMd()).toBe(renderSheetBogeysBlock(getBogeysForEvent(db, eventId)));
  });

  it("an all-empty row beside a curated one is not a column of dashes", () => {
    seed("empty row", "2026-08-03 12:00:00", {});
    seed("content row", "2026-08-02 12:00:00", { eps_consensus: 1.02 }, "manual");
    expect(sheetMd()).toBe(`## Sheet bogeys — by source

| Metric | content row (8/02) |
|---|---|
| EPS | 1.02 |`);
  });

  it("a row the table shows no cell from (notes only) is not a column", () => {
    seed("notes only", "2026-08-03 12:00:00", { notes: "watch margins" }, "manual");
    seed("content row", "2026-08-02 12:00:00", { eps_consensus: 1.02 }, "manual");
    const md = sheetMd();
    expect(md).toContain("| Metric | content row (8/02) |");
    expect(md).not.toContain("notes only");
  });

  it("only-empty rows print no table, exactly like no rows", () => {
    expect(sheetMd()).toBe("");
    seed("empty row", "2026-08-03 12:00:00", {});
    seed("blank row", "2026-08-02 12:00:00", { notes: "  ", segment_breakdown_json: "{}" });
    expect(sheetMd()).toBe("");
  });

  it("empty rows do not use up the three-column cap or inflate the older-sheets count", () => {
    seed("empty A", "2026-08-07 12:00:00", {});
    seed("empty B", "2026-08-06 12:00:00", {});
    seed("empty C", "2026-08-05 12:00:00", {});
    seed("content row", "2026-08-02 12:00:00", { eps_consensus: 1.02 }, "manual");
    const md = sheetMd();
    expect(md).toContain("| Metric | content row (8/02) |");
    expect(md).not.toContain("older sheet");
  });
});
