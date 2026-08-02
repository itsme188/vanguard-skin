/**
 * Morning-debrief candidate selection (Task 1 of the 2026-08-02
 * morning-debrief plan). Pure candidate-finding only — no prompt building,
 * no sending. Later tasks (2 = sections/prompt, 3 = sender) import
 * `DebriefCandidate` / `DebriefRosterEntry` / `DebriefCandidates` and
 * `findDebriefCandidates` from lib/earnings/debrief.ts.
 *
 * Spec: this replaces the same-evening earnings "wrap" email with a
 * 7:45 ET morning debrief — sibling logic to getExpectedRecapCluster in
 * lib/earnings/wrap.ts, but windowed on [yesterday, today] instead of a
 * same-day (date, slot) cluster, and honest about live in_progress claims
 * (they exclude a candidate from `unsent` rather than counting it as a
 * cluster member).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  findDebriefCandidates,
  renderDebriefSections,
  buildDebriefPrompt,
  assembleDebriefMarkdown,
  type DebriefSection,
  type DebriefRosterEntry,
} from "@/lib/earnings/debrief";
import {
  setMutedEarningsSymbols,
  setEarningsEmailsEnabled,
} from "@/lib/queries/earnings-settings";

// "Today" for every test — ET. Chosen so composeReleaseInstant's DST branch
// resolves to EDT (August). NOW is 2026-08-02T11:45 UTC = 07:45 ET.
const TODAY = "2026-08-02";
const YESTERDAY = "2026-08-01";
const NOW = new Date("2026-08-02T11:45:00Z");

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedHeld(symbol: string): number {
  const sec = Number(
    db
      .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')`)
      .run(symbol, symbol).lastInsertRowid,
  );
  const acct = Number(
    db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(`a-${symbol}`).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 100, '2026-08-01', ?)`,
  ).run(acct, sec, `t:${symbol}`);
  return sec;
}

let eventCounter = 0;
function seedEvent(opts: {
  symbol: string;
  date?: string;
  releaseTime?: string | null;
  eventTime?: string | null;
  actual?: string | null;
  superseded?: number;
}): number {
  eventCounter += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
          (source, event_type, event_date, event_time, release_time, title, symbol,
           actual_value, source_key, week_of, superseded)
         VALUES ('finnhub', 'earnings', ?, ?, ?, ?, ?, ?, ?, '2026-07-27', ?)`,
      )
      .run(
        opts.date ?? TODAY,
        opts.eventTime ?? null,
        opts.releaseTime === undefined ? null : opts.releaseTime,
        `${opts.symbol} earnings`,
        opts.symbol,
        opts.actual === undefined ? "EPS 1.00 · Rev 500M" : opts.actual,
        `finnhub:${opts.symbol}:${opts.date ?? TODAY}:${eventCounter}`,
        opts.superseded ?? 0,
      ).lastInsertRowid,
  );
}

function seedRecapEmail(eventId: number, error: string | null, sentAt: string): void {
  db.prepare(
    `INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error)
     VALUES (?, 'recap', 'x', ?, ?)`,
  ).run(eventId, sentAt, error);
}

function seedRecapSkip(eventId: number): void {
  db.prepare(`INSERT INTO earnings_email_skips (event_id, phase) VALUES (?, 'recap')`).run(
    eventId,
  );
}

let transcriptCounter = 0;
function seedTranscript(opts: {
  ticker: string;
  summary: string;
  fetchedAt: string;
  year?: number;
  quarter?: number;
  source?: string;
}): void {
  transcriptCounter += 1;
  db.prepare(
    `INSERT INTO earnings_transcripts
      (ticker, year, quarter, source, summary, source_key, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.ticker,
    opts.year ?? 2026,
    opts.quarter ?? 2,
    opts.source ?? "edgar_8k",
    opts.summary,
    `test:${opts.ticker}:${transcriptCounter}`,
    opts.fetchedAt,
  );
}

function seedCallNote(
  eventId: number,
  symbol: string,
  opts: { guidance?: string | null; tone?: string | null; surprises?: string | null },
): void {
  db.prepare(
    `INSERT INTO earnings_call_notes (event_id, symbol, guidance, tone, surprises)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(eventId, symbol, opts.guidance ?? null, opts.tone ?? null, opts.surprises ?? null);
}

describe("findDebriefCandidates", () => {
  it("selects held earnings from yesterday+today with actuals and no recap audit row", () => {
    seedHeld("AAA");
    const todayId = seedEvent({ symbol: "AAA", date: TODAY });
    seedHeld("BBB");
    const yesterdayId = seedEvent({ symbol: "BBB", date: YESTERDAY });

    const result = findDebriefCandidates(db, { now: NOW });
    const ids = result.unsent.map((c) => c.eventId).sort((a, b) => a - b);
    expect(ids).toEqual([todayId, yesterdayId].sort((a, b) => a - b));
    const aaa = result.unsent.find((c) => c.symbol === "AAA")!;
    expect(aaa).toMatchObject({
      eventId: todayId,
      symbol: "AAA",
      event_date: TODAY,
    });
  });

  /**
   * Integration case for the 2026-08-02 rewire (Task 4): the EOD wrap was
   * retired from the sweep, so a recap candidate whose (date, slot) cluster
   * reached WRAP_THRESHOLD "yesterday" and got suppressed by the sweep's
   * still-live wrap-pending branch (lib/calendar/email-sweep.ts) — the
   * suppression just `continue`s the candidate loop, writing NO
   * earnings_emails row and NO earnings_email_skips row for it — is
   * indistinguishable, DB-wise, from any other never-sent recap. This
   * morning's findDebriefCandidates call must pick it up as `unsent`: with
   * no wrap pass left to ever fire for it, the morning debrief is now the
   * only path that recaps it at all.
   */
  it("a recap candidate wrap-suppressed YESTERDAY (never sent — no earnings_emails/earnings_email_skips row) appears in this morning's debrief candidates", () => {
    seedHeld("WRAPPED");
    const wrapSuppressedId = seedEvent({
      symbol: "WRAPPED",
      date: YESTERDAY,
      eventTime: "AMC",
      releaseTime: "16:15",
    });

    const result = findDebriefCandidates(db, { now: NOW });

    expect(result.unsent.map((c) => c.eventId)).toContain(wrapSuppressedId);
    const wrapped = result.unsent.find((c) => c.symbol === "WRAPPED")!;
    expect(wrapped).toMatchObject({
      eventId: wrapSuppressedId,
      symbol: "WRAPPED",
      event_date: YESTERDAY,
    });
    // Not on the "already recapped" roster either — it was never sent.
    expect(result.alreadyRecapped.find((r) => r.symbol === "WRAPPED")).toBeUndefined();
  });

  it("excludes: no actuals; recap already sent (error NULL); sent-by-cloud; recap skip row; muted symbol; not held/watchlist; superseded", () => {
    seedHeld("NOACT");
    seedEvent({ symbol: "NOACT", actual: null });

    seedHeld("SENTLOCAL");
    const sentLocalId = seedEvent({ symbol: "SENTLOCAL" });
    seedRecapEmail(sentLocalId, null, "2026-08-02 07:00:00");

    seedHeld("SENTCLOUD");
    const sentCloudId = seedEvent({ symbol: "SENTCLOUD" });
    seedRecapEmail(sentCloudId, "sent-by-cloud", "2026-08-02 07:10:00");

    seedHeld("SKIPPED");
    const skippedId = seedEvent({ symbol: "SKIPPED" });
    seedRecapSkip(skippedId);

    seedHeld("MUTED");
    seedEvent({ symbol: "MUTED" });
    setMutedEarningsSymbols(db, ["MUTED"]);

    // Not held, not watchlisted.
    seedEvent({ symbol: "NOPOS" });

    seedHeld("GONE");
    seedEvent({ symbol: "GONE", superseded: 1 });

    const result = findDebriefCandidates(db, { now: NOW });
    expect(result.unsent).toEqual([]);
  });

  it("excludes every candidate when the master toggle is off", () => {
    seedHeld("WOULDPASS");
    seedEvent({ symbol: "WOULDPASS" });
    setEarningsEmailsEnabled(db, false);

    const result = findDebriefCandidates(db, { now: NOW });
    expect(result.unsent).toEqual([]);
  });

  it("a live in_progress recap claim excludes the event (another process is sending it)", () => {
    seedHeld("CLAIM");
    const claimId = seedEvent({ symbol: "CLAIM" });
    seedRecapEmail(claimId, "in_progress", "2026-08-02 07:00:00");

    const result = findDebriefCandidates(db, { now: NOW });
    expect(result.unsent).toEqual([]);
    // Not a completed send either — must not appear on the roster.
    expect(result.alreadyRecapped.find((r) => r.symbol === "CLAIM")).toBeUndefined();
  });

  it("released under 60 minutes ago is excluded (release_time known); a stale release or unknown release_time is included", () => {
    // NOW = 07:45 ET. Released 07:00 ET → 45 min ago → excluded.
    seedHeld("RECENT");
    seedEvent({ symbol: "RECENT", releaseTime: "07:00" });

    // Released 06:00 ET → 105 min ago → included.
    seedHeld("OLD");
    const oldId = seedEvent({ symbol: "OLD", releaseTime: "06:00" });

    // No release_time on record → included (never held back for lack of data).
    seedHeld("UNKNOWN");
    const unknownId = seedEvent({ symbol: "UNKNOWN", releaseTime: null });

    const result = findDebriefCandidates(db, { now: NOW });
    const ids = result.unsent.map((c) => c.eventId).sort((a, b) => a - b);
    expect(ids).toEqual([oldId, unknownId].sort((a, b) => a - b));
  });

  it("family dedupe: GOOG + GOOGL rows on the same date yield one candidate (lowest eventId wins)", () => {
    seedHeld("GOOG");
    const googId = seedEvent({ symbol: "GOOG" });
    const googlId = seedEvent({ symbol: "GOOGL" });
    expect(googId).toBeLessThan(googlId);

    const result = findDebriefCandidates(db, { now: NOW });
    expect(result.unsent).toHaveLength(1);
    expect(result.unsent[0].eventId).toBe(googId);
  });

  it("alreadyRecapped lists yesterday+today's completed recaps (NULL error and sent-by-cloud both count, in_progress does not)", () => {
    seedHeld("DONE1");
    const done1Id = seedEvent({ symbol: "DONE1", date: YESTERDAY });
    seedRecapEmail(done1Id, null, "2026-08-01 20:05:00");

    seedHeld("DONE2");
    const done2Id = seedEvent({ symbol: "DONE2", date: TODAY });
    seedRecapEmail(done2Id, "sent-by-cloud", "2026-08-02 06:00:00");

    seedHeld("PENDING");
    const pendingId = seedEvent({ symbol: "PENDING", date: TODAY });
    seedRecapEmail(pendingId, "in_progress", "2026-08-02 07:30:00");

    // Outside the [yesterday, today] window — must not appear.
    seedHeld("OLDNEWS");
    const oldNewsId = seedEvent({ symbol: "OLDNEWS", date: "2026-07-30" });
    seedRecapEmail(oldNewsId, null, "2026-07-30 20:00:00");

    const result = findDebriefCandidates(db, { now: NOW });
    expect(result.alreadyRecapped.map((r) => r.symbol)).toEqual(["DONE1", "DONE2"]);
    expect(result.alreadyRecapped[0]).toMatchObject({
      symbol: "DONE1",
      sentAt: "2026-08-01 20:05:00",
    });
  });
});

describe("renderDebriefSections", () => {
  it("renders per-name section: heading, scoreboard table, desk-note guidance excerpt when a fresh transcript summary exists", () => {
    seedHeld("ZZZ");
    // Released 06:00 ET, well before NOW (07:45 ET) → clears the 60-min
    // recency filter in findDebriefCandidates.
    seedEvent({ symbol: "ZZZ", date: TODAY, eventTime: "BMO", releaseTime: "06:00" });
    seedTranscript({
      ticker: "ZZZ",
      summary:
        "**Guidance**: Management raised full-year revenue guidance to $5B, citing strength in cloud.\n**Tone**: Confident, upbeat on demand.\n**Surprises**: Margin beat driven by mix shift.",
      fetchedAt: `${TODAY} 06:00:00`,
    });

    const { unsent } = findDebriefCandidates(db, { now: NOW });
    expect(unsent).toHaveLength(1);
    const sections = renderDebriefSections(db, unsent);

    expect(sections).toHaveLength(1);
    const section = sections[0];
    expect(section.symbol).toBe("ZZZ");
    expect(section.markdown).toContain("### ZZZ — 2026-08-02 BMO");
    expect(section.markdown).toContain("ZZZ scoreboard");
    expect(section.markdown).toContain("| **EPS** |");
    expect(section.markdown).toContain("**From the call** (desk note):");
    expect(section.markdown).toContain("**Guidance:**");
    expect(section.markdown).toContain(
      "Management raised full-year revenue guidance to $5B, citing strength in cloud.",
    );
    expect(section.markdown).toContain("**Tone:** Confident, upbeat on demand.");
    // Surprises text belongs to a different labelled span and must not leak
    // into the guidance excerpt.
    expect(section.markdown).not.toContain("Margin beat driven by mix shift.");
  });

  it("desk-note excerpt: caps the **Guidance** span at 900 chars, adds a Tone line when present; extractive-only summaries get a 600-char teaser; no transcript omits the block silently", () => {
    // Case A: guidance span longer than 900 chars gets capped.
    seedHeld("CAPD");
    seedEvent({ symbol: "CAPD" });
    const longGuidance = "Q".repeat(950);
    seedTranscript({
      ticker: "CAPD",
      summary: `**Guidance**: ${longGuidance}\n**Tone**: steady`,
      fetchedAt: `${TODAY} 05:00:00`,
    });

    // Case B: extractive-only summary (no **Guidance** marker) — 600-char teaser.
    seedHeld("TEASE");
    seedEvent({ symbol: "TEASE" });
    const extractive = "Plain extractive summary text. ".repeat(30); // > 600 chars
    seedTranscript({
      ticker: "TEASE",
      summary: extractive,
      fetchedAt: `${TODAY} 05:00:00`,
    });

    // Case C: no transcript at all.
    seedHeld("NOTX");
    seedEvent({ symbol: "NOTX" });

    const { unsent } = findDebriefCandidates(db, { now: NOW });
    const sections = renderDebriefSections(db, unsent);
    const byName = new Map(sections.map((s) => [s.symbol, s]));

    const capd = byName.get("CAPD")!;
    expect(capd.markdown).toContain("Q".repeat(900));
    expect(capd.markdown).not.toContain("Q".repeat(901));
    expect(capd.markdown).toContain("**Tone:** steady");

    const tease = byName.get("TEASE")!;
    expect(tease.markdown).toContain("**From the call** (desk note):");
    expect(tease.markdown).toContain(extractive.slice(0, 600));
    expect(tease.markdown).not.toContain(extractive.slice(0, 601));

    const notx = byName.get("NOTX")!;
    expect(notx.markdown).not.toContain("**From the call**");
  });

  it("includes the user's call note (guidance/tone/surprises) when one exists for the family", () => {
    seedHeld("NOTE");
    const eventId = seedEvent({ symbol: "NOTE" });
    seedCallNote(eventId, "NOTE", {
      guidance: "raised",
      tone: "confident",
      surprises: "beat on margins",
    });

    const { unsent } = findDebriefCandidates(db, { now: NOW });
    const sections = renderDebriefSections(db, unsent);
    const section = sections.find((s) => s.symbol === "NOTE")!;

    expect(section.markdown).toContain("**Your call note:**");
    expect(section.markdown).toContain("guidance raised");
    expect(section.markdown).toContain("tone: confident");
    expect(section.markdown).toContain("surprises: beat on margins");
  });

  it("omits the call-note block when none exists for the family", () => {
    seedHeld("NONOTE");
    seedEvent({ symbol: "NONOTE" });

    const { unsent } = findDebriefCandidates(db, { now: NOW });
    const sections = renderDebriefSections(db, unsent);
    const section = sections.find((s) => s.symbol === "NONOTE")!;

    expect(section.markdown).not.toContain("**Your call note:**");
  });

  it("does NOT render a stale call note from a prior quarter's event (outside the date window)", () => {
    seedHeld("PRIORQ");
    seedEvent({ symbol: "PRIORQ", date: TODAY });
    // A much older event for the same symbol, holding a note from a prior
    // quarter's call — outside the window (2026-05-01 is ~90 days back).
    const oldEventId = seedEvent({ symbol: "PRIORQ", date: "2026-05-01" });
    seedCallNote(oldEventId, "PRIORQ", {
      guidance: "lowered",
      tone: "cautious last quarter",
      surprises: "missed on margins",
    });

    const { unsent } = findDebriefCandidates(db, { now: NOW });
    const sections = renderDebriefSections(db, unsent);
    const section = sections.find((s) => s.symbol === "PRIORQ")!;

    expect(section.markdown).not.toContain("**Your call note:**");
    expect(section.markdown).not.toContain("cautious last quarter");
  });

  it("renders a call note attached to the debriefed event itself", () => {
    seedHeld("THISQ");
    const eventId = seedEvent({ symbol: "THISQ", date: TODAY });
    seedCallNote(eventId, "THISQ", { guidance: "inline", tone: "steady tone" });

    const { unsent } = findDebriefCandidates(db, { now: NOW });
    const sections = renderDebriefSections(db, unsent);
    const section = sections.find((s) => s.symbol === "THISQ")!;

    expect(section.markdown).toContain("**Your call note:**");
    expect(section.markdown).toContain("guidance inline");
    expect(section.markdown).toContain("tone: steady tone");
  });

  it("dual-class: a note attached to the sibling's event row within the window renders for the deduped candidate", () => {
    seedHeld("GOOG");
    const googId = seedEvent({ symbol: "GOOG", date: TODAY });
    const googlId = seedEvent({ symbol: "GOOGL", date: TODAY });
    seedCallNote(googlId, "GOOGL", {
      guidance: "raised",
      tone: "sibling call tone",
      surprises: "ad revenue beat",
    });

    const { unsent } = findDebriefCandidates(db, { now: NOW });
    expect(unsent).toHaveLength(1);
    expect(unsent[0].eventId).toBe(googId);

    const sections = renderDebriefSections(db, unsent);
    const section = sections.find((s) => s.symbol === "GOOG")!;

    expect(section.markdown).toContain("**Your call note:**");
    expect(section.markdown).toContain("guidance raised");
    expect(section.markdown).toContain("tone: sibling call tone");
    expect(section.markdown).toContain("surprises: ad revenue beat");
  });

  it("desk-note excerpt demotes an embedded raw markdown heading before excerpting — no heading line leaks into the section", () => {
    seedHeld("HEAD");
    seedEvent({ symbol: "HEAD" });
    seedTranscript({
      ticker: "HEAD",
      summary:
        "**Guidance**: They raised full-year guidance.\n## Segment detail\nCloud grew 40% while ads were flat.\n**Tone**: confident",
      fetchedAt: `${TODAY} 05:00:00`,
    });

    const { unsent } = findDebriefCandidates(db, { now: NOW });
    const sections = renderDebriefSections(db, unsent);
    const section = sections.find((s) => s.symbol === "HEAD")!;

    expect(section.markdown).toContain("**From the call** (desk note):");
    expect(section.markdown).toContain("They raised full-year guidance.");
    expect(section.markdown).toContain("**Tone:** confident");
    expect(section.markdown).not.toContain("## Segment detail");

    const deskNoteBlock = section.markdown.split("**From the call** (desk note):")[1] ?? "";
    const rawHeadingLines = deskNoteBlock
      .split("\n")
      .filter((l) => /^#{1,6}\s/.test(l.trim()));
    expect(rawHeadingLines).toEqual([]);
  });
});

describe("buildDebriefPrompt", () => {
  it("embeds every section and instructs markdown-only output starting with #", () => {
    const sections: DebriefSection[] = [
      { symbol: "AAA", markdown: "AAA section data goes here" },
      { symbol: "BBB", markdown: "BBB section data goes here" },
    ];

    const prompt = buildDebriefPrompt(sections, "2026-08-02");

    expect(prompt).toContain(
      "You are writing the morning earnings debrief for 2026-08-02.",
    );
    expect(prompt).toContain("first character of your reply must be '#'");
    expect(prompt).toContain("# What changed overnight");
    expect(prompt).toContain("AAA section data goes here");
    expect(prompt).toContain("BBB section data goes here");
    expect(prompt).toContain("AAA section data goes here\n\n---\n\nBBB section data goes here");
  });
});

describe("assembleDebriefMarkdown", () => {
  const sections: DebriefSection[] = [
    { symbol: "AAA", markdown: "### AAA section" },
    { symbol: "BBB", markdown: "### BBB section" },
  ];

  it("AI synthesis first, then sections, then a roster line; roster omitted when empty", () => {
    const roster: DebriefRosterEntry[] = [
      { symbol: "XXX", sentAt: "2026-08-01 20:00:00" },
      { symbol: "YYY", sentAt: "2026-08-02 06:00:00" },
    ];

    const result = assembleDebriefMarkdown(
      "# What changed overnight\n- bullet one",
      sections,
      roster,
      "2026-08-02",
    );

    const aiIdx = result.indexOf("# What changed overnight");
    const scoreboardsIdx = result.indexOf("## The scoreboards");
    const aaaIdx = result.indexOf("### AAA section");
    const bbbIdx = result.indexOf("### BBB section");
    const rosterIdx = result.indexOf("Recapped individually overnight: XXX · YYY");

    expect(aiIdx).toBe(0);
    expect(scoreboardsIdx).toBeGreaterThan(aiIdx);
    expect(aaaIdx).toBeGreaterThan(scoreboardsIdx);
    expect(bbbIdx).toBeGreaterThan(aaaIdx);
    expect(rosterIdx).toBeGreaterThan(bbbIdx);
  });

  it("omits the roster line entirely when roster is empty", () => {
    const result = assembleDebriefMarkdown(
      "# What changed overnight\n- bullet one",
      sections,
      [],
      "2026-08-02",
    );

    expect(result).not.toContain("Recapped individually overnight");
  });
});
