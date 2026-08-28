import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getEmailStatesForEvents } from "@/lib/queries/earnings-emails";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { upsertCallNote } from "@/lib/mutations/earnings-call-notes";

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
