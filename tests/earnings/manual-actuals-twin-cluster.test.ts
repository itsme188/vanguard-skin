/**
 * QA finding today-week-ahead--accepted-actuals-vanish-after-superseded-twin-flip.
 *
 * A manual-actuals acceptance (POST /api/earnings/actuals → manual_actuals_at)
 * is a statement about the PRINT — symbol + event date + the accepted figure —
 * not about whichever twin row happened to be canonical at stamping time.
 *
 * Live shape (RBRK 2026-08-27): two earnings twins for the same print, the
 * stamp on the finnhub row, the nasdaq row canonical after reconcile flipped
 * it, both carrying the SAME actual_value. The rendered row's own
 * manual_actuals_at was NULL, so actualsAreImplausible put the accepted print
 * back behind the scrape guard and the week-ahead card withheld it entirely.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  applyClusterManualActuals,
  clusterManualActualsAt,
} from "@/lib/queries/manual-actuals-cluster";
import { getEventsByWeek, getEarningsForWeekDeduped } from "@/lib/queries/calendar";
import { buildCockpitPayload } from "@/lib/queries/earnings-cockpit";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { eventFigureDisplays } from "@/app/dashboard/today/WeekAheadView";
import { clearManualActuals } from "@/lib/earnings/actuals";
import type { CalendarEvent } from "@/lib/types";

// The editor GET route (app/api/earnings/actuals/route.ts) imports the DB
// singleton directly rather than taking `db` as a parameter — mirror the
// mock pattern from tests/api/earnings-actuals-route.test.ts so the route
// module under test reads/writes the SAME in-memory db as the rest of this
// file (assigned in beforeEach below).
const routeDb = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return routeDb.db;
  },
}));

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  routeDb.db = db;
});

// RBRK's live figures: consensus EPS 0.04, accepted actual EPS 0.20 — a 5x
// ratio, which isPlausibleEarnings rejects. That rejection is the whole point:
// only the acceptance stamp may let it through.
const CONSENSUS = "EPS 0.04 · Rev 404203519";
const ACCEPTED = "EPS 0.20 · Rev 427260000";
const STAMP = "2026-08-27 20:17:20";
const WEEK_OF = "2026-08-24";
const EVENT_DATE = "2026-08-27";

function seedTwin(opts: {
  symbol: string;
  source: string;
  eventDate?: string;
  superseded?: number;
  actual?: string | null;
  manualAt?: string | null;
  consensus?: string | null;
  weekOf?: string;
}): number {
  return db
    .prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol,
          consensus_value, actual_value, manual_actuals_at, superseded, source_key,
          week_of, enriched_at)
       VALUES (?, 'earnings', ?, 'AMC', '16:05', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.source,
      opts.eventDate ?? EVENT_DATE,
      `${opts.symbol} earnings`,
      opts.symbol,
      opts.consensus === undefined ? CONSENSUS : opts.consensus,
      opts.actual ?? null,
      opts.manualAt ?? null,
      opts.superseded ?? 0,
      `${opts.source}:${opts.symbol}:${opts.eventDate ?? EVENT_DATE}`,
      opts.weekOf ?? WEEK_OF,
      opts.actual ? STAMP : null,
    ).lastInsertRowid as number;
}

/** The live RBRK shape: canonical nasdaq twin unstamped, finnhub twin stamped. */
function seedRbrkShape(): { canonical: number; stamped: number } {
  const canonical = seedTwin({
    symbol: "RBRK",
    source: "nasdaq",
    superseded: 0,
    actual: ACCEPTED,
    manualAt: null,
  });
  const stamped = seedTwin({
    symbol: "RBRK",
    source: "finnhub",
    superseded: 1,
    actual: ACCEPTED,
    manualAt: STAMP,
  });
  return { canonical, stamped };
}

describe("clusterManualActualsAt — the acceptance belongs to the print", () => {
  it("finds a superseded twin's stamp for the canonical row", () => {
    seedRbrkShape();
    const row = { symbol: "RBRK", event_date: EVENT_DATE, actual_value: ACCEPTED };
    expect(clusterManualActualsAt(db, row)).toBe(STAMP);
  });

  it("returns null when no twin in the cluster was ever accepted", () => {
    seedTwin({ symbol: "RBRK", source: "nasdaq", actual: ACCEPTED });
    seedTwin({ symbol: "RBRK", source: "finnhub", superseded: 1, actual: ACCEPTED });
    const row = { symbol: "RBRK", event_date: EVENT_DATE, actual_value: ACCEPTED };
    expect(clusterManualActualsAt(db, row)).toBeNull();
  });

  it("never lends the stamp to a DIFFERENT figure — the user accepted one number", () => {
    seedTwin({ symbol: "RBRK", source: "finnhub", superseded: 1, actual: ACCEPTED, manualAt: STAMP });
    const vendorRow = {
      symbol: "RBRK",
      event_date: EVENT_DATE,
      actual_value: "EPS 0.55 · Rev 999000000",
    };
    expect(clusterManualActualsAt(db, vendorRow)).toBeNull();
  });

  it("never lends the stamp across event dates — an acceptance is about one print", () => {
    seedTwin({
      symbol: "RBRK",
      source: "finnhub",
      eventDate: "2026-05-28",
      actual: ACCEPTED,
      manualAt: STAMP,
    });
    const row = { symbol: "RBRK", event_date: EVENT_DATE, actual_value: ACCEPTED };
    expect(clusterManualActualsAt(db, row)).toBeNull();
  });

  it("clusters dual-class siblings (GOOG stamp heals a GOOGL row)", () => {
    seedTwin({ symbol: "GOOG", source: "finnhub", superseded: 1, actual: ACCEPTED, manualAt: STAMP });
    const row = { symbol: "GOOGL", event_date: EVENT_DATE, actual_value: ACCEPTED };
    expect(clusterManualActualsAt(db, row)).toBe(STAMP);
  });

  it("does not cluster unrelated symbols", () => {
    seedTwin({ symbol: "NVDA", source: "finnhub", actual: ACCEPTED, manualAt: STAMP });
    const row = { symbol: "RBRK", event_date: EVENT_DATE, actual_value: ACCEPTED };
    expect(clusterManualActualsAt(db, row)).toBeNull();
  });

  it("keeps a row's OWN stamp when it has one (and takes the latest of several)", () => {
    seedTwin({ symbol: "RBRK", source: "finnhub", superseded: 1, actual: ACCEPTED, manualAt: STAMP });
    seedTwin({
      symbol: "RBRK",
      source: "manual",
      superseded: 1,
      actual: ACCEPTED,
      manualAt: "2026-08-27 21:40:00",
    });
    const row = { symbol: "RBRK", event_date: EVENT_DATE, actual_value: ACCEPTED };
    expect(clusterManualActualsAt(db, row)).toBe("2026-08-27 21:40:00");
  });

  it("applyClusterManualActuals leaves an unstamped, unaccepted row's NULL intact", () => {
    const rows = [
      { symbol: "RBRK", event_date: EVENT_DATE, actual_value: ACCEPTED, manual_actuals_at: null },
    ];
    applyClusterManualActuals(db, rows);
    expect(rows[0].manual_actuals_at).toBeNull();
  });
});

describe("week-ahead (getEventsByWeek) — the reported surface", () => {
  it("renders the accepted actual after the canonical twin flipped to the unstamped row", () => {
    const { canonical } = seedRbrkShape();
    const events = getEventsByWeek(db, WEEK_OF);
    const row = events.find((e) => e.id === canonical)!;
    expect(row).toBeDefined();
    expect(row.manual_actuals_at).toBe(STAMP);
    expect(eventFigureDisplays(row).actualDisplay).not.toBeNull();
  });

  it("still withholds an implausible actual when NO twin in the cluster was accepted", () => {
    seedTwin({ symbol: "RBRK", source: "nasdaq", actual: ACCEPTED });
    seedTwin({ symbol: "RBRK", source: "finnhub", superseded: 1, actual: ACCEPTED });
    const events = getEventsByWeek(db, WEEK_OF);
    const row = events[0];
    expect(row.manual_actuals_at).toBeNull();
    expect(eventFigureDisplays(row).actualDisplay).toBeNull();
  });

  it("regression: a stamp on the canonical row keeps working with an unstamped twin", () => {
    const canonical = seedTwin({
      symbol: "RBRK",
      source: "nasdaq",
      actual: ACCEPTED,
      manualAt: STAMP,
    });
    seedTwin({ symbol: "RBRK", source: "finnhub", superseded: 1, actual: ACCEPTED });
    const row = getEventsByWeek(db, WEEK_OF).find((e) => e.id === canonical)!;
    expect(row.manual_actuals_at).toBe(STAMP);
    expect(eventFigureDisplays(row).actualDisplay).not.toBeNull();
  });

  it("leaves non-earnings rows alone", () => {
    db.prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, title, source_key, week_of, actual_value)
       VALUES ('fred', 'cpi', ?, '08:30', 'CPI release', 'fred:1:cpi', ?, '3.2%')`,
    ).run(EVENT_DATE, WEEK_OF);
    const row = getEventsByWeek(db, WEEK_OF)[0];
    expect(row.manual_actuals_at ?? null).toBeNull();
    expect(eventFigureDisplays(row).actualDisplay).toBe("3.2%");
  });
});

describe("EarningsHub (getEarningsForWeekDeduped)", () => {
  it("carries the cluster stamp onto the surviving row", () => {
    seedRbrkShape();
    const events = getEarningsForWeekDeduped(db, WEEK_OF);
    expect(events).toHaveLength(1);
    expect(events[0].manual_actuals_at).toBe(STAMP);
  });

  it("leaves manual_actuals_at NULL when nothing in the cluster was accepted", () => {
    seedTwin({ symbol: "RBRK", source: "nasdaq", actual: ACCEPTED });
    const events = getEarningsForWeekDeduped(db, WEEK_OF);
    expect(events[0].manual_actuals_at).toBeNull();
  });
});

describe("earnings cockpit (buildCockpitPayload)", () => {
  function seedHeld(symbol: string): void {
    const acct = db
      .prepare("INSERT INTO accounts (name) VALUES (?)")
      .run(`acct-${symbol}`).lastInsertRowid as number;
    const sec = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, source_key) VALUES (?, ?, 'Stock', ?)",
      )
      .run(symbol, symbol, `t:${symbol}`).lastInsertRowid as number;
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 100, '2026-08-01', ?)",
    ).run(acct, sec, `h:${symbol}`);
  }

  it("stages the actual as captured, not implausible, when a twin carries the acceptance", () => {
    seedHeld("RBRK");
    seedRbrkShape();
    // 2026-08-27 21:00 ET — after the 16:05 AMC print.
    const payload = buildCockpitPayload(db, new Date("2026-08-28T01:00:00Z"));
    const row = payload.lanes.amc[0];
    expect(row.stages.actual).toBe("captured");
    expect(row.actual).not.toBeNull();
  });

  it("still stages implausible when no twin was accepted", () => {
    seedHeld("RBRK");
    seedTwin({ symbol: "RBRK", source: "nasdaq", actual: ACCEPTED });
    seedTwin({ symbol: "RBRK", source: "finnhub", superseded: 1, actual: ACCEPTED });
    const payload = buildCockpitPayload(db, new Date("2026-08-28T01:00:00Z"));
    const row = payload.lanes.amc[0];
    expect(row.stages.actual).toBe("implausible");
    expect(row.actual).toBeNull();
  });
});

describe("reconcileEarningsDates — write-time carry (defense in depth)", () => {
  it("carries the acceptance stamp onto the canonical that adopts the accepted figure", () => {
    // Finnhub row accepted by the desk; nasdaq row (same date) has no actual
    // yet, so carryEnrichment COALESCEs the accepted figure onto whichever
    // row wins — the stamp must ride along with the number it describes.
    seedTwin({
      symbol: "RBRK",
      source: "finnhub",
      actual: ACCEPTED,
      manualAt: STAMP,
      eventDate: "2026-08-27",
    });
    const nasdaq = seedTwin({
      symbol: "RBRK",
      source: "nasdaq",
      actual: null,
      eventDate: "2026-08-26",
    });
    // Both future-dated relative to `today` and disagreeing → nasdaq wins
    // (rung 4, conflict), which is exactly the canonical-flip shape.
    reconcileEarningsDates(db, { today: "2026-08-20" });
    const row = db
      .prepare("SELECT actual_value, manual_actuals_at FROM calendar_events WHERE id = ?")
      .get(nasdaq) as { actual_value: string | null; manual_actuals_at: string | null };
    expect(row.actual_value).toBe(ACCEPTED);
    expect(row.manual_actuals_at).toBe(STAMP);
  });

  it("never stamps a canonical that keeps its OWN, different vendor figure", () => {
    seedTwin({
      symbol: "RBRK",
      source: "finnhub",
      actual: ACCEPTED,
      manualAt: STAMP,
      eventDate: "2026-08-27",
    });
    const nasdaq = seedTwin({
      symbol: "RBRK",
      source: "nasdaq",
      actual: "EPS 0.55 · Rev 999000000",
      eventDate: "2026-08-26",
    });
    reconcileEarningsDates(db, { today: "2026-08-20" });
    const row = db
      .prepare("SELECT actual_value, manual_actuals_at FROM calendar_events WHERE id = ?")
      .get(nasdaq) as { actual_value: string | null; manual_actuals_at: string | null };
    expect(row.actual_value).toBe("EPS 0.55 · Rev 999000000");
    expect(row.manual_actuals_at).toBeNull();
  });
});

describe("type shape", () => {
  it("accepts a full CalendarEvent without widening", () => {
    seedRbrkShape();
    const events: CalendarEvent[] = getEventsByWeek(db, WEEK_OF);
    expect(applyClusterManualActuals(db, events)).toBe(events);
  });
});

/**
 * Finding A (task-4 brief): the twin-flip healing above is read-side and
 * covered the display surfaces, but the actuals editor GET
 * (app/api/earnings/actuals/route.ts) read `manual_actuals_at` raw off the
 * addressed row — in the stranded-stamp shape (canonical row healed from a
 * superseded twin) the editor showed un-accepted while every other surface
 * showed accepted. The GET handler now heals through `clusterManualActualsAt`.
 */
describe("GET /api/earnings/actuals — editor healing (Finding A)", () => {
  function getReq(eventId: number): Request {
    return new Request(`http://test/api/earnings/actuals?eventId=${eventId}`);
  }

  it("reports accepted with the healed figure for a canonical row with a stranded stamp", async () => {
    const { canonical } = seedRbrkShape();
    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.GET(getReq(canonical));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manual_actuals_at: string | null;
      actual_value_raw: string | null;
    };
    expect(body.manual_actuals_at).toBe(STAMP);
    expect(body.actual_value_raw).toBe(ACCEPTED);
  });

  it("reports un-accepted when nothing in the cluster was ever accepted", async () => {
    const canonical = seedTwin({ symbol: "RBRK", source: "nasdaq", actual: ACCEPTED });
    seedTwin({ symbol: "RBRK", source: "finnhub", superseded: 1, actual: ACCEPTED });
    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.GET(getReq(canonical));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manual_actuals_at: string | null };
    expect(body.manual_actuals_at).toBeNull();
  });
});

/**
 * Finding A (task-4 brief, continued): `clearManualActuals` 409'd unless the
 * ADDRESSED row's own stamp was set, so a stranded acceptance (stamp lives
 * on a superseded twin, addressed row is the healed canonical) was
 * permanently un-clearable from the UI. Clear now resolves the cluster
 * first and, once it finds a stamp anywhere in the cluster, nulls it
 * wherever it lives — never leaving a stamp stranded on a sibling twin.
 */
describe("clearManualActuals — cluster-wide clear (Finding A)", () => {
  it("clears the stamp cluster-wide when addressed via the healed canonical row; subsequent GET reports un-accepted", async () => {
    const { canonical, stamped } = seedRbrkShape();

    const result = clearManualActuals(db, { eventId: canonical });
    expect(result.ok).toBe(true);

    const stampedRow = db
      .prepare(
        `SELECT actual_value, enriched_at, manual_actuals_at, actual_missing_alerted_at
           FROM calendar_events WHERE id = ?`,
      )
      .get(stamped) as {
      actual_value: string | null;
      enriched_at: string | null;
      manual_actuals_at: string | null;
      actual_missing_alerted_at: string | null;
    };
    expect(stampedRow.manual_actuals_at).toBeNull();
    expect(stampedRow.actual_value).toBeNull();
    expect(stampedRow.enriched_at).toBeNull();
    expect(stampedRow.actual_missing_alerted_at).toBeNull();

    // The canonical row itself carried its own (vendor-sourced) actual_value
    // with no stamp — clearing must not touch data the user never entered.
    const canonicalRow = db
      .prepare(`SELECT actual_value, manual_actuals_at FROM calendar_events WHERE id = ?`)
      .get(canonical) as { actual_value: string | null; manual_actuals_at: string | null };
    expect(canonicalRow.actual_value).toBe(ACCEPTED);
    expect(canonicalRow.manual_actuals_at).toBeNull();

    // No stamp survives anywhere in the cluster — a subsequent GET on the
    // canonical row (still healed through the cluster helper) now reports
    // un-accepted, matching the "genuinely un-stamped" state.
    const mod = await import("@/app/api/earnings/actuals/route");
    const res = await mod.GET(
      new Request(`http://test/api/earnings/actuals?eventId=${canonical}`),
    );
    const body = (await res.json()) as { manual_actuals_at: string | null };
    expect(body.manual_actuals_at).toBeNull();
  });

  it("still 409s clearing a truly-unstamped cluster (no stamp anywhere)", () => {
    const canonical = seedTwin({ symbol: "RBRK", source: "nasdaq", actual: ACCEPTED });
    seedTwin({ symbol: "RBRK", source: "finnhub", superseded: 1, actual: ACCEPTED });

    const result = clearManualActuals(db, { eventId: canonical });
    expect(result.ok).toBe(false);
    if (!result.ok && result.status === 409) {
      expect(result.code).toBe("not_manual");
    } else {
      throw new Error(`expected a 409 not_manual refusal, got ${JSON.stringify(result)}`);
    }

    const row = db
      .prepare(`SELECT actual_value FROM calendar_events WHERE id = ?`)
      .get(canonical) as { actual_value: string | null };
    expect(row.actual_value).toBe(ACCEPTED);
  });

  it("still clears normally when addressed directly via the row that carries its own stamp", () => {
    const eventId = seedTwin({
      symbol: "RBRK",
      source: "nasdaq",
      actual: ACCEPTED,
      manualAt: STAMP,
    });

    const result = clearManualActuals(db, { eventId });
    expect(result.ok).toBe(true);

    const row = db
      .prepare(
        `SELECT actual_value, enriched_at, manual_actuals_at, actual_missing_alerted_at
           FROM calendar_events WHERE id = ?`,
      )
      .get(eventId) as {
      actual_value: string | null;
      enriched_at: string | null;
      manual_actuals_at: string | null;
      actual_missing_alerted_at: string | null;
    };
    expect(row.actual_value).toBeNull();
    expect(row.enriched_at).toBeNull();
    expect(row.manual_actuals_at).toBeNull();
    expect(row.actual_missing_alerted_at).toBeNull();
  });
});
