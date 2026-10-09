/**
 * Owner ruling 2026-08-12 (a bogey row with every content column empty is not
 * coverage), carried onto the email send path: the prompt's "## Bogeys" block
 * is built from rows that hold something. An event whose only bogey rows are
 * empty composes exactly like an event with no bogeys.
 *
 * Why it matters: the block tells the model to "treat the most recent entry as
 * the primary consensus reference". An empty newest row would be that entry.
 *
 * The real composeEarningsEmail runs here; only the AI client and the intel
 * refresh are mocked. Invented issuer and round figures: the repo is public.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/ai/provider", () => ({ getRawAnthropicClient: vi.fn() }));
vi.mock("@/lib/earnings/intel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/earnings/intel")>()),
  ensureIntelForEvents: vi.fn(),
}));

let db: InstanceType<typeof Database>;
let eventId: number;
let mockCreate: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = Number(
    db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, title, symbol, source_key, week_of,
            consensus_estimate, actual_value)
         VALUES ('finnhub', 'earnings', '2026-08-04', 'ZZA earnings', 'ZZA',
                 'finnhub:ZZA:2026-08-04', '2026-08-03',
                 'EPS 1.00 · Rev 100M', 'EPS 1.10 · Rev 105M')`,
      )
      .run().lastInsertRowid,
  );

  const { getRawAnthropicClient } = await import("@/lib/ai/provider");
  mockCreate = vi.fn().mockResolvedValue({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "## The setup\n\nbody" }],
  });
  vi.mocked(getRawAnthropicClient).mockReturnValue({
    messages: { create: mockCreate },
  } as unknown as ReturnType<typeof getRawAnthropicClient>);
  const { ensureIntelForEvents } = await import("@/lib/earnings/intel");
  vi.mocked(ensureIntelForEvents).mockResolvedValue(undefined);
});

/** The stored shape the pre-ruling write path left behind: a row, no content. */
function seedEmptyRow(label: string): void {
  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, source_label, notes, segment_breakdown_json, uploaded_at)
     VALUES (?, 'newsletter', ?, '  ', '{}', '2026-08-03 09:00:00')`,
  ).run(eventId, label);
}

async function promptFor(phase: "preview" | "recap"): Promise<{ prompt: string; markdown: string }> {
  const { composeEarningsEmail } = await import("@/lib/digest/send-earnings-email");
  mockCreate.mockClear();
  const result = await composeEarningsEmail(db, eventId, phase);
  const body = mockCreate.mock.calls[0][0] as { messages: Array<{ content: string }> };
  return { prompt: body.messages[0].content, markdown: result.markdown };
}

const BLOCK_HEADING = "## Bogeys (user-curated";
const VENDOR_ONLY_HEADING = "## Bogeys (vendor consensus only — no user-curated bogeys on file)";

describe.each(["preview", "recap"] as const)("%s prompt and all-empty bogey rows", (phase) => {
  it("only-empty rows compose exactly like no rows", async () => {
    const bare = await promptFor(phase);
    expect(bare.prompt).not.toContain(BLOCK_HEADING);

    seedEmptyRow("Desk Notes 8/2");
    seedEmptyRow("Desk Notes 8/3");
    const withEmpties = await promptFor(phase);

    expect(withEmpties.prompt).not.toContain(BLOCK_HEADING);
    expect(withEmpties.prompt).not.toContain("Desk Notes");
    expect(withEmpties.prompt).toBe(bare.prompt);
    expect(withEmpties.markdown).toBe(bare.markdown);
  });

  it("an empty row beside a real one: only the real one is listed, as entry [1]", async () => {
    // The empty row is the NEWEST, the slot the prompt calls the primary reference.
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, notes, uploaded_at)
       VALUES (?, 'newsletter', 'Empty Sheet', '', '2026-08-03 12:00:00')`,
    ).run(eventId);
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus, uploaded_at)
       VALUES (?, 'manual', 'Real Sheet', 1.02, '2026-08-02 12:00:00')`,
    ).run(eventId);

    const { prompt } = await promptFor(phase);
    expect(prompt).toContain(BLOCK_HEADING);
    expect(prompt).toContain("### [1] Real Sheet");
    expect(prompt).not.toContain("Empty Sheet");
    expect(prompt).not.toContain("### [2]");
  });
});

/**
 * Reviewer follow-up (2026-10-08): "holds something" is not "prints something".
 * A row counts for a composer only if that composer prints at least one field
 * from it, so the prompt can never list an entry with nothing under it and the
 * email body can never carry an empty column.
 */
const EXTRA_ID = "11111111-1111-4111-8111-111111111111";
const EXTRAS_JSON = JSON.stringify([
  {
    id: EXTRA_ID,
    label: "Bookings",
    definition: "Total bookings in the quarter",
    unit: "usd",
    kind: "point",
    period: "Q",
    basis: "na",
    consensus: 250_000_000,
    whisper: 260_000_000,
  },
]);

function seedCols(label: string, uploadedAt: string, cols: Record<string, unknown>, source = "newsletter"): void {
  const names = Object.keys(cols);
  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, source_label, uploaded_at${names.map((n) => `, ${n}`).join("")})
     VALUES (?, ?, ?, ?${names.map(() => ", ?").join("")})`,
  ).run(eventId, source, label, uploadedAt, ...Object.values(cols));
}

describe.each(["preview", "recap"] as const)("%s: a row counts only if the composer prints something from it", (phase) => {
  it("a normal curated row renders byte-for-byte as before", async () => {
    seedCols("TMT Sheet", "2026-08-02 12:00:00", {
      eps_consensus: 1.02,
      eps_whisper: 1.08,
      revenue_consensus_usd: 100_000_000,
      revenue_whisper_usd: 104_000_000,
      expected_move_pct: 6,
      segment_breakdown_json: '{"Cloud":{"consensus":40000000,"whisper":42000000}}',
      guidance_notes: "watch the guide",
      notes: "a note",
    });
    const { prompt, markdown } = await promptFor(phase);
    expect(prompt).toContain(`
## Bogeys (user-curated — preferred over Finnhub consensus, most recent first)

These are bogeys the user pulled from preferred sources (TMT Breakout, sell-side notes) and uploaded for THIS event. **Treat the most recent entry as the primary consensus reference.** Whisper numbers, when present, are the directional bar that matters — beat-the-whisper is the meaningful event, not beat-consensus. Cite the source label inline when discussing them.

### [1] TMT Sheet (uploaded 2026-08-02 12:00:00)
EPS consensus 1.02 · EPS **whisper 1.08** · revenue consensus $100.0M · revenue **whisper $104.0M** · expected move ±6.0%
Segment splits:
  - Cloud: consensus $40.0M, whisper $42.0M
Guidance: watch the guide
Notes: a note
`);
    expect(prompt).not.toContain("vendor");
    expect(markdown).toContain(`## Sheet bogeys — by source

| Metric | TMT Sheet (8/02) |
|---|---|
| EPS | 1.02 · **w 1.08** |
| Revenue | $100.0M · **w $104.0M** |
| Expected move | ±6.0% |
| Cloud (seg) | $40.0M · **w $42.0M** |`);
  });

  it("a vendor-EPS-only row prints the vendor figure, labelled as the vendor's", async () => {
    seedCols("Sell-side consensus (Finnhub)", "2026-08-03 12:00:00", { eps_consensus_vendor: 1.05 }, "finnhub");
    const { prompt } = await promptFor(phase);
    // The only printed entry is the vendor's, so the block does not claim
    // curated bogeys (ruling 2026-10-08; pinned in full further down).
    expect(prompt).toContain(VENDOR_ONLY_HEADING);
    expect(prompt).not.toContain(BLOCK_HEADING);
    expect(prompt).toContain("### [1] Sell-side consensus (Finnhub)");
    expect(prompt).toContain("vendor EPS consensus 1.05 (basis unspecified)");
    // Never dressed as the curated consensus.
    expect(prompt).not.toMatch(/(^|[^r] )EPS consensus 1\.05/m);
    expect(prompt).toContain("is the data vendor's figure");
  });

  it("the row the real consensus step writes with no vendor revenue shows its EPS figure", async () => {
    const { saveBogeyWithRecompile } = await import("@/lib/mutations/earnings-bogeys");
    saveBogeyWithRecompile(db, {
      event_id: eventId,
      source: "finnhub",
      source_label: "Sell-side consensus (Finnhub)",
      eps_consensus: null,
      eps_consensus_vendor: 1.05,
      revenue_consensus_usd: null,
      notes: "Vendor consensus (Finnhub) — EPS basis unspecified; shown labelled, never the adjusted-EPS bogey.",
    });
    const { prompt } = await promptFor(phase);
    expect(prompt).toContain("vendor EPS consensus 1.05 (basis unspecified)");
  });

  it("a vendor row newer than a curated row is flagged as not the primary reference", async () => {
    seedCols("Sell-side consensus (Finnhub)", "2026-08-03 12:00:00", { eps_consensus_vendor: 1.05 }, "finnhub");
    seedCols("Real Sheet", "2026-08-02 12:00:00", { eps_consensus: 1.02 }, "manual");
    const { prompt } = await promptFor(phase);
    expect(prompt).toContain("### [1] Sell-side consensus (Finnhub)");
    expect(prompt).toContain("### [2] Real Sheet");
    expect(prompt).toContain("never the primary consensus reference when a curated entry is listed");
  });

  it("an extras-only row prints its metric line", async () => {
    seedCols("Desk Sheet", "2026-08-03 12:00:00", { extra_metrics_json: EXTRAS_JSON }, "manual");
    const { prompt } = await promptFor(phase);
    expect(prompt).toContain("### [1] Desk Sheet");
    expect(prompt).toContain("Extra metrics:\n  - Bookings (this quarter): consensus $250.0M, whisper $260.0M");
  });

  it("rows that hold something no composer prints compose exactly like no rows", async () => {
    const bare = await promptFor(phase);
    // Each passes the content rule and prints nothing.
    seedCols("Unreadable extras", "2026-08-03 12:00:00", { extra_metrics_json: '[{"label":"Bookings"}]' });
    seedCols("Extras with no figure", "2026-08-03 11:00:00", {
      extra_metrics_json: JSON.stringify([{ ...JSON.parse(EXTRAS_JSON)[0], consensus: null, whisper: null }]),
    });
    seedCols("Segment with no figure", "2026-08-03 10:00:00", { segment_breakdown_json: '{"Cloud":{}}' });
    seedCols("Broken segments", "2026-08-03 09:00:00", { segment_breakdown_json: "{not json" });
    const after = await promptFor(phase);
    expect(after.prompt).not.toContain(BLOCK_HEADING);
    expect(after.prompt).toBe(bare.prompt);
    expect(after.markdown).toBe(bare.markdown);
  });

  it("one printed row among unprinted ones is entry [1] and the only entry", async () => {
    seedCols("Segment with no figure", "2026-08-03 12:00:00", { segment_breakdown_json: '{"Cloud":{}}' });
    seedCols("Real Sheet", "2026-08-02 12:00:00", { expected_move_pct: 5 }, "manual");
    const { prompt } = await promptFor(phase);
    expect(prompt).toContain("### [1] Real Sheet");
    expect(prompt).toContain("expected move ±5.0%");
    expect(prompt).not.toContain("Segment with no figure");
    expect(prompt).not.toContain("### [2]");
  });

  it("S2: the email body's sheet table never carries an empty row as a column", async () => {
    seedCols("empty row", "2026-10-09 12:00:00", {});
    seedCols("content row", "2026-10-09 11:00:00", { eps_consensus: 1.02 }, "manual");
    const { markdown } = await promptFor(phase);
    expect(markdown).toContain("| Metric | content row (10/09) |");
    expect(markdown).not.toContain("empty row");
  });

  it("S2: a row with nothing the sheet table shows is not a column of dashes", async () => {
    seedCols("notes only", "2026-10-09 12:00:00", { notes: "watch margins" }, "manual");
    seedCols("content row", "2026-10-09 11:00:00", { eps_consensus: 1.02 }, "manual");
    const { markdown, prompt } = await promptFor(phase);
    expect(markdown).toContain("| Metric | content row (10/09) |");
    expect(markdown).not.toContain("notes only (10/09)");
    // The prompt block DOES print the note, so the row still counts there.
    expect(prompt).toContain("### [1] notes only");
    expect(prompt).toContain("Notes: watch margins");
  });
});

/**
 * Wording follow-up (2026-10-08): the block's heading and lead-in say "curated"
 * only when at least one PRINTED entry is not the vendor's. The claim is read
 * off the same printed entries the block lists, so it cannot disagree with them.
 */
const CURATED_LEAD = `
## Bogeys (user-curated — preferred over Finnhub consensus, most recent first)

These are bogeys the user pulled from preferred sources (TMT Breakout, sell-side notes) and uploaded for THIS event. **Treat the most recent entry as the primary consensus reference.** Whisper numbers, when present, are the directional bar that matters — beat-the-whisper is the meaningful event, not beat-consensus. Cite the source label inline when discussing them.

`;
const VENDOR_CLAUSE = `A "vendor EPS consensus" figure is the data vendor's figure on an unspecified basis, not a curated bogey: quote it as the vendor's, and an entry that carries only vendor figures is never the primary consensus reference when a curated entry is listed.

`;
const VENDOR_ONLY_LEAD = `
## Bogeys (vendor consensus only — no user-curated bogeys on file)

These are the data vendor's (Finnhub) consensus figures for THIS event. The user has uploaded no curated bogeys and no whisper numbers, so do not describe these figures as curated, as a whisper, or as the user's preferred reference. Cite the source label inline when discussing them.

`;

describe.each(["preview", "recap"] as const)("%s: the block says curated only when a curated entry is printed", (phase) => {
  async function seedRealVendorRow(revenue: number | null): Promise<void> {
    const { saveBogeyWithRecompile } = await import("@/lib/mutations/earnings-bogeys");
    saveBogeyWithRecompile(db, {
      event_id: eventId,
      source: "finnhub",
      source_label: "Sell-side consensus (Finnhub)",
      eps_consensus: null,
      eps_consensus_vendor: 1.05,
      revenue_consensus_usd: revenue,
      notes: "Vendor consensus (Finnhub) — EPS basis unspecified; shown labelled, never the adjusted-EPS bogey.",
    });
  }

  it("only the vendor's row (as the real consensus step writes it): vendor wording, no curated claim", async () => {
    await seedRealVendorRow(100_000_000);
    const { prompt } = await promptFor(phase);
    expect(prompt).toContain(
      `${VENDOR_ONLY_LEAD}${VENDOR_CLAUSE}### [1] Sell-side consensus (Finnhub) (uploaded `,
    );
    expect(prompt).toContain("vendor EPS consensus 1.05 (basis unspecified) · revenue consensus $100.0M");
    expect(prompt).not.toContain("user-curated — preferred");
    expect(prompt).not.toContain("bogeys the user pulled from preferred sources");
    expect(prompt).not.toContain("Treat the most recent entry as the primary consensus reference");
  });

  it("a vendor row beside a curated row: every string is the curated one, byte for byte", async () => {
    seedCols("Sell-side consensus (Finnhub)", "2026-08-03 12:00:00", { eps_consensus_vendor: 1.05 }, "finnhub");
    seedCols("Real Sheet", "2026-08-02 12:00:00", { eps_consensus: 1.02 }, "manual");
    const { prompt } = await promptFor(phase);
    expect(prompt).toContain(
      `${CURATED_LEAD}${VENDOR_CLAUSE}### [1] Sell-side consensus (Finnhub) (uploaded 2026-08-03 12:00:00)
vendor EPS consensus 1.05 (basis unspecified)

---

### [2] Real Sheet (uploaded 2026-08-02 12:00:00)
EPS consensus 1.02
`,
    );
    expect(prompt).not.toContain("vendor consensus only");
  });

  it("a curated row alone: the curated lead, byte for byte, and no vendor wording", async () => {
    seedCols("Real Sheet", "2026-08-02 12:00:00", { eps_consensus: 1.02 }, "manual");
    const { prompt } = await promptFor(phase);
    expect(prompt).toContain(`${CURATED_LEAD}### [1] Real Sheet (uploaded 2026-08-02 12:00:00)\nEPS consensus 1.02\n`);
    expect(prompt).not.toContain("vendor consensus only");
  });

  it("the claim follows the PRINTED entries: a curated row that prints nothing does not make it curated", async () => {
    await seedRealVendorRow(null);
    // Holds something (passes the content rule), prints nothing.
    seedCols("Segment with no figure", "2026-08-03 12:00:00", { segment_breakdown_json: '{"Cloud":{}}' }, "manual");
    const { prompt } = await promptFor(phase);
    expect(prompt).toContain(VENDOR_ONLY_HEADING);
    expect(prompt).not.toContain(BLOCK_HEADING);
    expect(prompt).not.toContain("Segment with no figure");
  });

  it("a hand-entered row that carries only a vendor-column figure is still a curated entry (the source decides)", async () => {
    seedCols("Desk entry", "2026-08-03 12:00:00", { eps_consensus_vendor: 1.05 }, "manual");
    const { prompt } = await promptFor(phase);
    expect(prompt).toContain(BLOCK_HEADING);
    expect(prompt).not.toContain(VENDOR_ONLY_HEADING);
  });
});
