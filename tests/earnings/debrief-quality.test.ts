/**
 * Morning-debrief quality bar (owner-approved 2026-11-04), seeded on the shape of the
 * 2026-11-04 email: a debrief that covered one name, a two-day-old unprepped PLTR-like
 * print, narrated with nothing to say. Invented issuers and round figures only.
 *
 * Now: Wednesday 2026-11-04 07:50 ET (EST: UTC-5 after the Nov 1 change) = 12:50Z.
 * Last night = Tuesday 11-03 after the close; this morning's BMO prints are 11-04.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/cron/earnings-marker-check", () => ({
  checkEarningsCloudMarker: vi.fn().mockResolvedValue(null),
  setEarningsRunningMarker: vi.fn().mockResolvedValue(null),
  clearEarningsRunningMarker: vi.fn().mockResolvedValue(null),
  writeMacSentEarningsMarker: vi.fn().mockResolvedValue(null),
  fetchCloudSentEarnings: vi.fn().mockResolvedValue([]),
  fetchCloudEarningsBody: vi.fn().mockResolvedValue(null),
  checkPrintPushMarker: vi.fn().mockResolvedValue(false),
  writePrintPushMarker: vi.fn().mockResolvedValue(null),
}));

import { sendEmail } from "@/lib/email";
import { findDebriefCandidates, renderDebriefSections, debriefContextGap } from "@/lib/earnings/debrief";
import { runMorningDebrief } from "@/lib/earnings/debrief-send";
import { renderHeadlineTable } from "@/lib/digest/send-earnings-email";
import { getEventById } from "@/lib/queries/calendar";

const NOW = new Date("2026-11-04T12:50:00Z");
const TODAY = "2026-11-04";
const LAST_NIGHT = "2026-11-03";
const TWO_DAYS_AGO = "2026-11-02";

let db: Database.Database;
let counter = 0;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.mocked(sendEmail).mockReset();
  vi.mocked(sendEmail).mockResolvedValue({ messageId: "<d@x>", response: "250 OK" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const MEASURED = (date: string) =>
  JSON.stringify({
    t0_utc: `${date}T21:05:00.000Z`,
    window_min: 120,
    captured_at: `${date}T23:30:00.000Z`,
    symbol: { t_pre: 100, t_post: 102, delta_pct: 2 },
  });

function seed(opts: {
  symbol: string;
  date: string;
  slotTime?: string; // release_time
  reaction?: boolean;
  actual?: string | null;
  guidance?: boolean;
  bogey?: boolean;
  transcript?: boolean;
  enriched?: boolean;
}): number {
  counter += 1;
  const sec = Number(db.prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`).run(opts.symbol, opts.symbol).lastInsertRowid);
  const acct = Number(db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(`a-${opts.symbol}`).lastInsertRowid);
  db.prepare(`INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 100, '2026-11-01', ?)`).run(acct, sec, `t:${opts.symbol}`);
  const id = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, release_time, title, symbol, actual_value,
                                      source_key, week_of, superseded, enriched_at, reaction_snapshot, consensus_estimate)
         VALUES ('finnhub','earnings',?,?,?,?,?,?,'2026-11-02',0,?,?,'EPS 1.00 · Rev 500M')`,
      )
      .run(
        opts.date,
        opts.slotTime ?? "16:05",
        `${opts.symbol} earnings`,
        opts.symbol,
        opts.actual === undefined ? "EPS 1.05 · Rev 510M" : opts.actual,
        `fh:${opts.symbol}:${counter}`,
        opts.enriched === false ? null : `${opts.date} 23:30:00`,
        opts.reaction === false ? null : MEASURED(opts.date),
      ).lastInsertRowid,
  );
  if (opts.bogey) {
    db.prepare(`INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus, uploaded_at) VALUES (?, 'manual', 'Desk sheet', 1.02, '2026-11-01 12:00:00')`).run(id);
  }
  if (opts.guidance) {
    db.prepare(
      `INSERT INTO earnings_call_notes (event_id, symbol, guidance, updated_at) VALUES (?, ?, 'raised', datetime('now'))`,
    ).run(id, opts.symbol);
  }
  if (opts.transcript) {
    db.prepare(
      `INSERT INTO earnings_transcripts (ticker, year, quarter, source, summary, source_key, fetched_at) VALUES (?, 2026, 3, 'motley_fool', '**Guidance** raised. **Tone** upbeat. **Surprises** none.', ?, ?)`,
    ).run(opts.symbol, `tx:${opts.symbol}`, `${opts.date} 23:59:00`);
  }
  return id;
}

const lastOutcome = () => {
  const r = db.prepare(`SELECT value FROM settings WHERE key = 'last_debrief_outcome'`).get() as { value: string } | undefined;
  return r ? JSON.parse(r.value) : null;
};

describe("(a) the 2026-11-04 shape: one stale, unprepped name is the only candidate", () => {
  it("is excluded as outside the print window, and the debrief sends nothing", async () => {
    // PLTR-like: AMC two trading days ago, actuals present, never armed or prepped, no context.
    seed({ symbol: "PLTR", date: TWO_DAYS_AGO, reaction: true });
    const found = findDebriefCandidates(db, { now: NOW });
    expect(found.unsent).toEqual([]);
    expect(found.excluded).toEqual([expect.objectContaining({ symbol: "PLTR", reason: "outside_print_window" })]);

    const gen = vi.fn();
    const res = await runMorningDebrief(db, { now: NOW, recipient: "desk@example.com", generate: gen });
    expect(res).toMatchObject({ sent: false, skippedReason: "no-qualifying-names" });
    expect(gen).not.toHaveBeenCalled(); // never composed
    expect(sendEmail).not.toHaveBeenCalled(); // never sent
    expect(db.prepare("SELECT COUNT(*) AS n FROM earnings_emails").get()).toEqual({ n: 0 });
    // The skipped outcome is on the audit path and names the stale name.
    const out = lastOutcome();
    expect(out.outcome).toBe("no-qualifying-names");
    expect(out.excluded[0]).toMatchObject({ symbol: "PLTR", reason: "outside_print_window" });
    // The day is NOT burned: a later tick in the window can still send.
    expect(db.prepare(`SELECT value FROM settings WHERE key = 'last_debrief_date'`).get()).toBeUndefined();
  });
});

describe("(b) a fresh print with actuals, reaction and guidance is included, and the narration carries the context", () => {
  it("qualifies, and the payload handed to the model carries scoreboard, bogey sheet and call note", async () => {
    const id = seed({ symbol: "ACME", date: LAST_NIGHT, bogey: true, guidance: true });
    const found = findDebriefCandidates(db, { now: NOW });
    expect(found.unsent.map((c) => c.symbol)).toEqual(["ACME"]);
    expect(found.excluded).toEqual([]);

    const sections = renderDebriefSections(db, found.unsent);
    const md = sections[0].markdown;
    expect(md).toContain("ACME scoreboard");
    expect(md).toContain("Desk sheet"); // the bogey sheet block (same renderer the recap compose uses)
    expect(md).toContain("guidance raised"); // guidance from the call note
    expect(id).toBeGreaterThan(0);

    const gen = vi.fn().mockResolvedValue("# What changed overnight\n- ACME raised its guide");
    const res = await runMorningDebrief(db, { now: NOW, recipient: "desk@example.com", generate: gen });
    expect(res).toMatchObject({ sent: true, covered: ["ACME"] });
    const prompt = gen.mock.calls[0][0] as string;
    expect(prompt).toContain("Desk sheet");
    expect(prompt).toContain("guidance raised");
  });

  it("a transcript desk note alone, or a bogey sheet alone, also clears the content bar", () => {
    const t = seed({ symbol: "TRNS", date: LAST_NIGHT, transcript: true });
    const b = seed({ symbol: "BOGY", date: LAST_NIGHT, bogey: true });
    const none = seed({ symbol: "NONE", date: LAST_NIGHT });
    const get = (id: number) => debriefContextGap(db, { eventId: id, symbol: db.prepare("SELECT symbol FROM calendar_events WHERE id=?").pluck().get(id) as string, event_date: LAST_NIGHT, event_time: null, release_time: "16:05" });
    expect(get(t)).toBeNull();
    expect(get(b)).toBeNull();
    expect(get(none)).toMatch(/nothing to narrate/);
  });
});

describe("(c) a fresh print missing its reaction is held by the shared gate, and named", () => {
  it("is excluded as reaction_pending even though it is inside the window", () => {
    seed({ symbol: "SLOW", date: LAST_NIGHT, reaction: false, bogey: true, guidance: true });
    const found = findDebriefCandidates(db, { now: NOW });
    expect(found.unsent).toEqual([]);
    expect(found.excluded).toEqual([expect.objectContaining({ symbol: "SLOW", reason: "reaction_pending" })]);
  });

  it("actuals withheld as implausible are held by the same gate", () => {
    seed({ symbol: "ODD", date: LAST_NIGHT, actual: "EPS 9.99 · Rev 900M", bogey: true });
    const found = findDebriefCandidates(db, { now: NOW });
    expect(found.excluded).toEqual([expect.objectContaining({ symbol: "ODD", reason: "actuals_unconfirmed" })]);
  });

  it("a name with actuals and a reaction but nothing to say is excluded as no_context", () => {
    seed({ symbol: "BARE", date: LAST_NIGHT });
    const found = findDebriefCandidates(db, { now: NOW });
    expect(found.excluded).toEqual([expect.objectContaining({ symbol: "BARE", reason: "no_context" })]);
  });
});

describe("(d) one qualifying and one stale name: the email covers only the qualifying one", () => {
  it("sends ACME; PLTR is named as excluded in the outcome", async () => {
    seed({ symbol: "ACME", date: LAST_NIGHT, bogey: true, guidance: true });
    seed({ symbol: "PLTR", date: TWO_DAYS_AGO, bogey: true, guidance: true });
    const gen = vi.fn().mockResolvedValue("# What changed overnight\n- ACME");
    const res = await runMorningDebrief(db, { now: NOW, recipient: "desk@example.com", generate: gen });
    expect(res.covered).toEqual(["ACME"]);
    expect(res.excluded).toEqual([expect.objectContaining({ symbol: "PLTR", reason: "outside_print_window" })]);
    const prompt = gen.mock.calls[0][0] as string;
    expect(prompt).toContain("ACME");
    expect(prompt).not.toContain("PLTR");
    expect(lastOutcome()).toMatchObject({ outcome: "sent", covered: ["ACME"] });
  });

  it("a BMO print dated today and an AMC print dated last night are both in the window; last night's BMO is not", () => {
    seed({ symbol: "MORN", date: TODAY, slotTime: "06:00", bogey: true });
    seed({ symbol: "NITE", date: LAST_NIGHT, slotTime: "16:10", bogey: true });
    seed({ symbol: "OLDAM", date: LAST_NIGHT, slotTime: "07:00", bogey: true });
    const found = findDebriefCandidates(db, { now: NOW });
    expect(found.unsent.map((c) => c.symbol).sort()).toEqual(["MORN", "NITE"]);
    expect(found.excluded).toEqual([expect.objectContaining({ symbol: "OLDAM", reason: "outside_print_window" })]);
  });

  it("Monday's debrief covers Friday's after-close prints (the previous trading day)", () => {
    seed({ symbol: "FRI", date: "2026-10-30", slotTime: "16:10", bogey: true });
    const found = findDebriefCandidates(db, { now: new Date("2026-11-02T12:50:00Z") });
    expect(found.unsent.map((c) => c.symbol)).toEqual(["FRI"]);
  });
});

describe("(e) the preview boilerplate never renders in a post-print scoreboard", () => {
  it("absent from the recap scoreboard and from the debrief sections; present in a preview", () => {
    const id = seed({ symbol: "ACME", date: LAST_NIGHT, bogey: true });
    const event = getEventById(db, id)!;
    const recap = renderHeadlineTable(event, "ACME", "recap", null);
    const preview = renderHeadlineTable(event, "ACME", "preview", null);
    expect(recap).not.toMatch(/Empty cells in a preview|fill them in live/);
    expect(preview).toMatch(/Empty cells in a preview are intentional/);
    const section = renderDebriefSections(db, [
      { eventId: id, symbol: "ACME", event_date: LAST_NIGHT, event_time: null, release_time: "16:05" },
    ])[0].markdown;
    expect(section).not.toMatch(/Empty cells in a preview|fill them in live/);
  });
});
