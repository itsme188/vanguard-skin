import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { renderSheetBogeysBlock, assembleEmailMarkdown } from "@/lib/digest/send-earnings-email";
import type { EarningsBogey } from "@/lib/queries/earnings-bogeys";

// FIX 2 (2026-08-06 final-review pass): composeEarningsEmail's real block
// order is pinned below against the actual Anthropic call site and the
// actual `ensureIntelForEvents` intel-refresh call site — both mocked so
// the pin never touches the network (real IBKR/Alpha Vantage credentials
// can be live on this machine).
vi.mock("@/lib/ai/provider", () => ({ getRawAnthropicClient: vi.fn() }));
vi.mock("@/lib/earnings/intel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/earnings/intel")>()),
  ensureIntelForEvents: vi.fn(),
}));

function bogey(over: Partial<EarningsBogey>): EarningsBogey {
  return {
    id: 1, event_id: 1, source: "pdf_upload", source_label: "TMT Breakout",
    source_url: null, raw_pdf_r2_key: null, eps_consensus: null, eps_whisper: null,
    revenue_consensus_usd: null, revenue_whisper_usd: null, expected_move_pct: null,
    segment_breakdown_json: null, guidance_notes: null, notes: null,
    uploaded_at: "2026-08-04 10:00:00", ...over,
  } as EarningsBogey;
}

describe("renderSheetBogeysBlock", () => {
  it("returns empty string with no bogeys", () => {
    expect(renderSheetBogeysBlock([])).toBe("");
  });

  it("renders one column per source, most recent first, whispers bolded with w-mark", () => {
    const md = renderSheetBogeysBlock([
      bogey({ source_label: "FundaAI", uploaded_at: "2026-08-05 09:00:00", eps_consensus: 4.28 }),
      bogey({ source_label: "TMT Breakout", uploaded_at: "2026-08-04 10:00:00", eps_consensus: 4.30, eps_whisper: 4.42, revenue_consensus_usd: 4_340_000_000 }),
    ]);
    expect(md).toContain("## Sheet bogeys — by source");
    const header = md.split("\n").find((l) => l.startsWith("| Metric"))!;
    // Most recent source first
    expect(header.indexOf("FundaAI")).toBeLessThan(header.indexOf("TMT Breakout"));
    expect(md).toContain("**w 4.42**");
    expect(md).toContain("$4.34B");
    // Metric rows only where >=1 source has a value: no Expected move row here
    expect(md).not.toContain("| Expected move");
  });

  it("unions segment rows across sources and skips malformed segment JSON", () => {
    const md = renderSheetBogeysBlock([
      bogey({ source_label: "A", segment_breakdown_json: JSON.stringify({ "Cloud rev": { consensus: 1_200_000_000 } }) }),
      bogey({ source_label: "B", uploaded_at: "2026-08-03 10:00:00", segment_breakdown_json: "{not json" }),
    ]);
    expect(md).toContain("Cloud rev (seg)");
    expect(md).toContain("$1.20B");
  });

  it("caps at 3 source columns with an older-sheets line", () => {
    const md = renderSheetBogeysBlock([
      bogey({ source_label: "S1", uploaded_at: "2026-08-05 09:00:00", eps_consensus: 1 }),
      bogey({ source_label: "S2", uploaded_at: "2026-08-04 09:00:00", eps_consensus: 1 }),
      bogey({ source_label: "S3", uploaded_at: "2026-08-03 09:00:00", eps_consensus: 1 }),
      bogey({ source_label: "S4", uploaded_at: "2026-08-02 09:00:00", eps_consensus: 1 }),
    ]);
    expect(md).not.toContain("S4");
    expect(md).toContain("(+1 older sheet");
  });
});

describe("assembleEmailMarkdown", () => {
  it("filters falsy values and joins blocks with double newlines", () => {
    const md = assembleEmailMarkdown([
      "## Headline",
      "", // falsy but included to test filtering
      "## Past prints",
      null,
      "## Sheet bogeys",
      "## AI output",
    ]);
    expect(md).toBe("## Headline\n\n## Past prints\n\n## Sheet bogeys\n\n## AI output");
  });

  it("with all falsy returns empty string", () => {
    const md = assembleEmailMarkdown([null, false, undefined, ""]);
    expect(md).toBe("");
  });
});

describe("renderSheetBogeysBlock — pipe escaping (AI-extracted free text)", () => {
  it("escapes a pipe in source_label so it can't shift the header row's columns", () => {
    const md = renderSheetBogeysBlock([
      bogey({ source_label: "TMT | Breakout", uploaded_at: "2026-08-05 09:00:00", eps_consensus: 4.3 }),
    ]);
    const header = md.split("\n").find((l) => l.startsWith("| Metric"))!;
    // The pipe survives as a literal escaped "\|" inside the cell...
    expect(header).toContain("TMT \\| Breakout");
    // ...so a markdown-table-aware split (only unescaped "|" are column
    // separators) still finds exactly 2 columns: "Metric" + one source.
    const cells = header
      .split(/(?<!\\)\|/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    expect(cells).toEqual(["Metric", "TMT \\| Breakout (8/05)"]);
  });

  it("escapes a pipe in a segment_breakdown_json key so the row label can't shift columns", () => {
    const md = renderSheetBogeysBlock([
      bogey({
        source_label: "A",
        segment_breakdown_json: JSON.stringify({ "Cloud | AI": { consensus: 1_000_000 } }),
      }),
    ]);
    const row = md.split("\n").find((l) => l.startsWith("| Cloud"))!;
    expect(row).toContain("Cloud \\| AI (seg)");
    const cells = row
      .split(/(?<!\\)\|/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    // Label cell + one source-value cell — a raw unescaped pipe would have
    // produced 3+ cells here instead.
    expect(cells).toHaveLength(2);
  });
});

describe("composeEarningsEmail block order (real function, both phases)", () => {
  // Pin: composeEarningsEmail assembles
  //   [headlineTable, pastPrintsBlock (preview only), sheetBogeysBlock, aiMarkdown]
  // for BOTH phases (pastPrintsBlock is "" on recap). The recap prompt's
  // sheet-bogey attribution rule tells the model this table renders "above"
  // its own output — this test exercises the REAL composeEarningsEmail
  // function (not just assembleEmailMarkdown) so a reorder of that array
  // fails here, not just in a manual re-read of the source.
  //
  // Network-touching dependencies (IBKR straddle, Alpha Vantage history) are
  // avoided by giving the event a truthy `actual_value` even for the preview
  // compose — composeEarningsEmail only attempts the forceFresh intel
  // refresh when `phase === "preview" && !event.actual_value`, so this
  // sidesteps that branch entirely without needing to mock it. The
  // `ensureIntelForEvents` mock below is belt-and-suspenders in case that
  // guard is ever loosened.
  let db: InstanceType<typeof Database>;
  let eventId: number;
  const AI_MARKER = "AI-OUTPUT-MARKER-9f3c";

  beforeEach(async () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const result = db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, title, symbol, source_key, week_of,
            consensus_estimate, actual_value)
         VALUES ('finnhub', 'earnings', '2026-08-04', 'ACME earnings', 'ACME',
                 'finnhub:ACME:2026-08-04', '2026-08-03',
                 'EPS 1.00 · Rev 100M', 'EPS 1.10 · Rev 105M')`,
      )
      .run();
    eventId = result.lastInsertRowid as number;

    // Non-empty history so the preview's "## Past prints" block is present
    // (renderPastPrintsBlock returns "" on empty history — we need it
    // non-empty to prove it lands BETWEEN the scoreboard and the sheet
    // bogeys, matching the recap's forced "" for the same slot).
    db.prepare(
      `INSERT INTO earnings_report_history
         (symbol, reported_date, eps_actual, eps_estimate, surprise_pct, post_print_move_pct)
       VALUES ('ACME', '2026-05-05', 1.05, 1.00, 5.0, 2.1)`,
    ).run();

    // Non-empty sheet bogeys so "## Sheet bogeys — by source" renders on
    // both phases.
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus)
       VALUES (?, 'manual', 'Test Sheet', 1.02)`,
    ).run(eventId);

    const { getRawAnthropicClient } = await import("@/lib/ai/provider");
    vi.mocked(getRawAnthropicClient).mockReturnValue({
      messages: {
        create: vi.fn().mockResolvedValue({
          stop_reason: "end_turn",
          content: [{ type: "text", text: `## The setup\n\n${AI_MARKER}` }],
        }),
      },
    } as unknown as ReturnType<typeof getRawAnthropicClient>);

    const { ensureIntelForEvents } = await import("@/lib/earnings/intel");
    vi.mocked(ensureIntelForEvents).mockResolvedValue(undefined);
  });

  it("preview: scoreboard, then past prints, then sheet bogeys, then AI output", async () => {
    const { composeEarningsEmail } = await import("@/lib/digest/send-earnings-email");
    const result = await composeEarningsEmail(db, eventId, "preview");
    const md = result.markdown;

    const iScoreboard = md.indexOf("## ACME scoreboard");
    const iPastPrints = md.indexOf("## Past prints");
    const iSheetBogeys = md.indexOf("## Sheet bogeys — by source");
    const iAi = md.indexOf(AI_MARKER);

    expect(iScoreboard).toBeGreaterThanOrEqual(0);
    expect(iPastPrints).toBeGreaterThan(iScoreboard);
    expect(iSheetBogeys).toBeGreaterThan(iPastPrints);
    expect(iAi).toBeGreaterThan(iSheetBogeys);
  });

  it("recap: scoreboard, then sheet bogeys (no past prints), then AI output", async () => {
    const { composeEarningsEmail } = await import("@/lib/digest/send-earnings-email");
    const result = await composeEarningsEmail(db, eventId, "recap");
    const md = result.markdown;

    const iScoreboard = md.indexOf("## ACME scoreboard");
    const iSheetBogeys = md.indexOf("## Sheet bogeys — by source");
    const iAi = md.indexOf(AI_MARKER);

    expect(iScoreboard).toBeGreaterThanOrEqual(0);
    // pastPrintsBlock is forced "" on recap — it must never appear at all,
    // and the sheet-bogeys table must sit directly under the scoreboard,
    // above the AI's own output (the exact claim FIX 1 corrected the recap
    // prompt to make).
    expect(md).not.toContain("## Past prints");
    expect(iSheetBogeys).toBeGreaterThan(iScoreboard);
    expect(iAi).toBeGreaterThan(iSheetBogeys);
  });
});
