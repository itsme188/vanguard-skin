import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getEmailStatesForEvents } from "@/lib/queries/earnings-emails";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { decorateCockpitIntel, cockpitRowsToIntelEvents } from "@/lib/queries/earnings-intel";
import { replaceReportHistory } from "@/lib/mutations/earnings-intel";
import { upsertCallNote } from "@/lib/mutations/earnings-call-notes";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import { todayET } from "@/lib/calendar/date-utils";

// Exposure needs Greeks/prices plumbing — not under test here.
vi.mock("@/lib/compute/exposure", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/compute/exposure")>();
  return {
    ...mod,
    getNetExposureForSymbolFamilies: vi.fn((_db: unknown, symbols: string[]) =>
      Object.fromEntries(symbols.map((s) => [s, s === "NVDA" ? 16000 : s === "JPM" ? 9000 : 0]))
    ),
  };
});

let db: Database.Database;
// Wednesday 2026-07-08, 10:00 ET (EDT).
const NOW = new Date("2026-07-08T14:00:00Z");

// accounts table is (id, name) only — no account_type column (see
// lib/db/migrations/001_initial_schema.sql). Matches the seed pattern used
// by tests/calendar/findEmailCandidates-skip.test.ts.
function seedAccountAndHolding(symbol: string) {
  const acct = db
    .prepare("INSERT INTO accounts (name) VALUES (?)")
    .run(`acct-${symbol}`).lastInsertRowid as number;
  const sec = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, source_key) VALUES (?, ?, 'Stock', ?)"
    )
    .run(symbol, symbol, `t:${symbol}`).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 100, '2026-07-01', ?)"
  ).run(acct, sec, `h:${symbol}`);
  return sec;
}

function seedEvent(opts: {
  symbol: string;
  eventDate: string;
  eventTime?: string | null;
  releaseTime?: string | null;
  source?: string;
  actual?: string | null;
}): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol, source_key, actual_value)
       VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.source ?? "finnhub",
      opts.eventDate,
      opts.eventTime ?? "AMC",
      opts.releaseTime ?? "16:20",
      `${opts.symbol} earnings`,
      opts.symbol,
      `${opts.source ?? "finnhub"}:${opts.symbol}:${opts.eventDate}:${opts.eventTime ?? "AMC"}`,
      opts.actual ?? null
    ).lastInsertRowid as number;
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("getEmailStatesForEvents", () => {
  it("maps the error tri-state, INCLUDING in_progress claims", () => {
    const sec = seedAccountAndHolding("NVDA");
    void sec;
    const ev = seedEvent({ symbol: "NVDA", eventDate: "2026-07-08" });
    db.prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error) VALUES (?, 'preview', 'x@y.z', datetime('now'), NULL)"
    ).run(ev);
    db.prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error) VALUES (?, 'recap', 'x@y.z', datetime('now'), 'in_progress')"
    ).run(ev);
    const states = getEmailStatesForEvents(db, [ev]);
    expect(states[ev]).toEqual({ preview: "sent", recap: "in-flight" });
  });
});

describe("buildCockpitPayload", () => {
  it("includes today's held reporters, lanes by BMO/AMC, nextRelease from upcoming instants", () => {
    seedAccountAndHolding("NVDA");
    seedAccountAndHolding("JPM");
    seedEvent({ symbol: "NVDA", eventDate: "2026-07-08", eventTime: "AMC", releaseTime: "16:20" });
    seedEvent({ symbol: "JPM", eventDate: "2026-07-08", eventTime: "BMO", releaseTime: "07:00" });

    const payload = buildCockpitPayload(db, NOW);
    expect(payload.lanes.amc.map((r) => r.symbol)).toEqual(["NVDA"]);
    expect(payload.lanes.bmo.map((r) => r.symbol)).toEqual(["JPM"]);
    // 10:00 ET: JPM (07:00) already out, NVDA (16:20) is next.
    expect(payload.nextRelease?.symbol).toBe("NVDA");
    const nvda = payload.lanes.amc[0];
    expect(nvda.netExposure).toBe(16000);
    expect(nvda.isTopExposure).toBe(true);
    expect(nvda.stages.released.state).toBe("upcoming");
  });

  it("excludes non-held/non-watchlist reporters and counts nothing for them", () => {
    seedAccountAndHolding("NVDA");
    seedEvent({ symbol: "NVDA", eventDate: "2026-07-08" });
    seedEvent({ symbol: "ZZZZ", eventDate: "2026-07-08" }); // not held, not watchlist
    const payload = buildCockpitPayload(db, NOW);
    const symbols = [
      ...payload.lanes.bmo, ...payload.lanes.amc, ...payload.lanes.unknown, ...payload.carryover,
    ].map((r) => r.symbol);
    expect(symbols).toEqual(["NVDA"]);
  });

  // Ruling R10 (live print v2 slice A, Task 5): buildCockpitPayload keeps
  // getSymbolStatus for the display chip; an armed-only row (now selected
  // by Task 4's coveredForEvents rewiring) must carry its real "armed"
  // status, not a collapsed "held"/"watchlist" lie. getSymbolStatus's armed
  // horizon has no `today` override (real wall-clock, spec §4.1) — seed at
  // real today so this stays meaningful regardless of when the suite runs.
  it('an armed-only (unheld, unwatched) reporter carries symbolStatus: "armed"', () => {
    const today = todayET();
    const ev = seedEvent({ symbol: "ACME", eventDate: today, eventTime: "AMC", releaseTime: "16:20" });
    armWorksheet(db, ev);

    const payload = buildCockpitPayload(db);
    const row = [...payload.lanes.bmo, ...payload.lanes.amc, ...payload.lanes.unknown].find(
      (r) => r.symbol === "ACME",
    );
    expect(row?.symbolStatus).toBe("armed");
  });

  it("dedupes finnhub-over-manual for the same symbol+date", () => {
    seedAccountAndHolding("NVDA");
    seedEvent({ symbol: "NVDA", eventDate: "2026-07-08", source: "manual" });
    seedEvent({ symbol: "NVDA", eventDate: "2026-07-08", source: "finnhub" });
    const payload = buildCockpitPayload(db, NOW);
    expect(payload.lanes.amc).toHaveLength(1);
  });

  it("carryover: yesterday's row without a sent/skipped recap appears flagged; completed yesterday does not", () => {
    seedAccountAndHolding("NVDA");
    seedAccountAndHolding("JPM");
    const unfinished = seedEvent({ symbol: "NVDA", eventDate: "2026-07-07" });
    const finished = seedEvent({ symbol: "JPM", eventDate: "2026-07-07", actual: "EPS 4.70 · Rev 45000000000" });
    db.prepare(
      "INSERT INTO earnings_emails (event_id, phase, recipient, sent_at, error) VALUES (?, 'recap', 'x@y.z', datetime('now'), NULL)"
    ).run(finished);

    const payload = buildCockpitPayload(db, NOW);
    expect(payload.carryover.map((r) => r.eventId)).toEqual([unfinished]);
    expect(payload.carryover[0].carryover).toBe(true);
    // Carryover with no actual reads blocked (overnight > 2h).
    expect(payload.carryover[0].stages.actual).toBe("blocked");
  });

  it("hasCallNote reflects the presence set", () => {
    seedAccountAndHolding("NVDA");
    const ev = seedEvent({ symbol: "NVDA", eventDate: "2026-07-08" });
    upsertCallNote(db, { eventId: ev, symbol: "NVDA" });
    const payload = buildCockpitPayload(db, NOW);
    expect(payload.lanes.amc[0].hasCallNote).toBe(true);
  });

  // QA 2026-08-07: the hub blanks implausible Finnhub actuals; the cockpit
  // must not render the same rejected figure as a cons→actual print result.
  it("withholds an implausible actual from the figures line (stage carries the flag)", () => {
    seedAccountAndHolding("AMN");
    const ev = seedEvent({
      symbol: "AMN",
      eventDate: "2026-07-08",
      eventTime: "BMO",
      releaseTime: "08:00",
      actual: "EPS 0.77 · Rev 673240000",
    });
    db.prepare("UPDATE calendar_events SET consensus_estimate = ? WHERE id = ?").run(
      "EPS 0.19 · Rev 634637984",
      ev
    );

    const payload = buildCockpitPayload(db, NOW);
    const row = payload.lanes.bmo[0];
    expect(row.stages.actual).toBe("implausible");
    expect(row.actual).toBeNull(); // withheld, like the hub's blanked cells
    expect(row.consensus).toContain("$0.19");
  });

  it("keeps a plausible actual on the figures line", () => {
    seedAccountAndHolding("JPM");
    const ev = seedEvent({
      symbol: "JPM",
      eventDate: "2026-07-08",
      eventTime: "BMO",
      releaseTime: "08:00",
      actual: "EPS 0.21 · Rev 640000000",
    });
    db.prepare("UPDATE calendar_events SET consensus_estimate = ? WHERE id = ?").run(
      "EPS 0.19 · Rev 634637984",
      ev
    );

    const payload = buildCockpitPayload(db, NOW);
    const row = payload.lanes.bmo[0];
    expect(row.stages.actual).toBe("captured");
    expect(row.actual).toContain("$0.21");
  });

  // QA finding today-earningshub-actuals--manual-override-silently-suppressed-by-plausibility-guard:
  // a manually-saved actual (calendar_events.manual_actuals_at stamped by
  // saveManualActuals) must render even when it fails the plausibility guard
  // — the guard is for unattended scrape failures, not a deliberate entry.
  it("keeps a manually-stamped actual on the figures line even when it fails the ratio guard", () => {
    seedAccountAndHolding("AMN");
    const ev = seedEvent({
      symbol: "AMN",
      eventDate: "2026-07-08",
      eventTime: "BMO",
      releaseTime: "08:00",
      actual: "EPS -1.20",
    });
    db.prepare(
      "UPDATE calendar_events SET consensus_estimate = ?, manual_actuals_at = datetime('now') WHERE id = ?",
    ).run("EPS 1.74", ev);

    const payload = buildCockpitPayload(db, NOW);
    const row = payload.lanes.bmo[0];
    expect(row.stages.actual).toBe("captured");
    expect(row.actual).toContain("-$1.20");
  });

  it("returns empty lanes + null nextRelease on a quiet day", () => {
    const payload = buildCockpitPayload(db, NOW);
    expect(payload.lanes.bmo).toEqual([]);
    expect(payload.lanes.amc).toEqual([]);
    expect(payload.lanes.unknown).toEqual([]);
    expect(payload.carryover).toEqual([]);
    expect(payload.nextRelease).toBeNull();
  });
});

describe("buildCockpitPayload — weekOf widening (slice F, M-F5)", () => {
  it("with no weekOf the payload is unchanged and rowsByEvent covers exactly today plus carryover", () => {
    seedAccountAndHolding("NVDA");
    seedAccountAndHolding("JPM");
    const today = seedEvent({ symbol: "NVDA", eventDate: "2026-07-08", eventTime: "AMC" });
    const thursday = seedEvent({ symbol: "JPM", eventDate: "2026-07-09", eventTime: "BMO" });
    const p = buildCockpitPayload(db, NOW);
    expect(p.lanes.amc.map((r) => r.eventId)).toEqual([today]);
    expect(Object.keys(p.rowsByEvent).map(Number)).toEqual([today]);
    expect(p.rowsByEvent[thursday]).toBeUndefined();
  });

  it("with weekOf, a Thursday event is in rowsByEvent for the week but NOT in today's lanes", () => {
    seedAccountAndHolding("NVDA");
    seedAccountAndHolding("JPM");
    const today = seedEvent({ symbol: "NVDA", eventDate: "2026-07-08", eventTime: "AMC" });
    const thursday = seedEvent({ symbol: "JPM", eventDate: "2026-07-09", eventTime: "BMO" });
    const p = buildCockpitPayload(db, NOW, { weekOf: "2026-07-06" });
    expect(p.lanes.bmo).toEqual([]);
    expect(p.lanes.amc.map((r) => r.eventId)).toEqual([today]);
    expect(
      Object.keys(p.rowsByEvent).map(Number).sort((a, b) => a - b)
    ).toEqual([today, thursday].sort((a, b) => a - b));
    expect(p.rowsByEvent[thursday].eventDate).toBe("2026-07-09");
  });

  it("keeps yesterday's unfinished carryover even when weekOf starts after it", () => {
    seedAccountAndHolding("NVDA");
    const yesterday = seedEvent({ symbol: "NVDA", eventDate: "2026-07-07", eventTime: "AMC" });
    const p = buildCockpitPayload(db, NOW, { weekOf: "2026-07-08" }); // a Wednesday-anchored window
    expect(p.carryover.map((r) => r.eventId)).toEqual([yesterday]);
    expect(p.rowsByEvent[yesterday]).toBeDefined();
  });

  it("nextRelease still looks only at today's rows, not the whole week", () => {
    seedAccountAndHolding("JPM");
    seedEvent({ symbol: "JPM", eventDate: "2026-07-09", eventTime: "BMO", releaseTime: "07:00" });
    const p = buildCockpitPayload(db, NOW, { weekOf: "2026-07-06" });
    expect(p.nextRelease).toBeNull();
  });
});

describe("the week's intel walk covers rowsByEvent (slice F, Codex round 1 #10 / F-S3)", () => {
  it("decorates a Thursday row and offers it for re-ensure while it is unreleased", () => {
    seedAccountAndHolding("NVDA");
    seedAccountAndHolding("JPM");
    seedEvent({ symbol: "NVDA", eventDate: "2026-07-08", eventTime: "AMC" });
    const thursday = seedEvent({ symbol: "JPM", eventDate: "2026-07-09", eventTime: "BMO" });
    // Gives decorateCockpitIntel something non-null to attach even with no
    // cached intel/bogey row (history alone is enough — see its own guard).
    replaceReportHistory(db, "JPM", [
      {
        reportedDate: "2026-04-14",
        fiscalDateEnding: "2026-03-31",
        epsActual: 4.2,
        epsEstimate: 4.0,
        surprisePct: 5.0,
        reportTime: "pre-market",
        postPrintMovePct: 1.2,
      },
    ]);
    const payload = buildCockpitPayload(db, NOW, { weekOf: "2026-07-06" });

    // It is in NEITHER a lane nor carryover — that is the whole point.
    expect(
      payload.lanes.bmo
        .concat(payload.lanes.amc, payload.lanes.unknown, payload.carryover)
        .some((r) => r.eventId === thursday)
    ).toBe(false);

    expect(cockpitRowsToIntelEvents(payload).map((e) => e.id)).toContain(thursday);
    decorateCockpitIntel(db, payload);
    expect(payload.rowsByEvent[thursday].intel).not.toBeNull();
  });

  it("never lists a row twice when it is BOTH in a lane and in rowsByEvent", () => {
    seedAccountAndHolding("NVDA");
    const today = seedEvent({ symbol: "NVDA", eventDate: "2026-07-08", eventTime: "AMC" });
    const payload = buildCockpitPayload(db, NOW, { weekOf: "2026-07-06" });
    const ids = cockpitRowsToIntelEvents(payload).map((e) => e.id);
    expect(ids.filter((id) => id === today)).toHaveLength(1);
  });
});
