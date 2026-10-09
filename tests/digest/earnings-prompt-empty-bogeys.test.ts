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
