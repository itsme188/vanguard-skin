/**
 * Codex second opinion on the slot rule, fix 2 (2026-10-08): the vendor
 * consensus prepare step must not depend on the reconcile pass's carry.
 *
 * A Nasdaq row can keep a print and hide the Finnhub row. The Nasdaq sync's
 * upsert then replaces the kept row's raw_json, and the Finnhub keys the
 * reconcile pass had carried onto it are gone until the pass at the end of
 * that sync runs (or for good, if that pass throws). In that window the step
 * used to read a Nasdaq-shaped entry, conclude "estimate withdrawn" and DELETE
 * the event's engine-owned Finnhub bogey.
 *
 * The step now reads the hidden Finnhub row of the same print directly.
 * "Withdrawn" is concluded only when a Finnhub source for the print exists
 * and says so.
 *
 * Rows go through the real writer in the shapes lib/calendar/finnhub.ts and
 * lib/calendar/nasdaq.ts produce. Synthetic symbols, invented round figures.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileEarningsDates, findHiddenFinnhubDonor } from "@/lib/calendar/reconcile-earnings-dates";
import { insertCalendarEvent, upsertCalendarEvents } from "@/lib/mutations/calendar";
import { mondayOf } from "@/lib/calendar/date-utils";
import { consensusRowStep, FINNHUB_BOGEY_LABEL } from "@/lib/earnings/prepare-steps/consensus-row";

const TODAY = "2026-11-02"; // Monday
const PRINT = "2026-11-05";
const ctx = { now: () => Date.now(), signal: new AbortController().signal };

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function idOf(sourceKey: string): number {
  return (
    db.prepare("SELECT id FROM calendar_events WHERE source_key = ?").get(sourceKey) as { id: number }
  ).id;
}

interface FinnhubOpts {
  hour?: "bmo" | "amc";
  epsEstimate?: number | null;
  revenueEstimate?: number | null;
  echoed?: string;
}

/** A Finnhub earnings row as lib/calendar/finnhub.ts assembles it. */
function finnhub(symbol: string, date: string, o: FinnhubOpts = {}): number {
  const echoed = o.echoed ?? symbol;
  const eps = o.epsEstimate === undefined ? 1 : o.epsEstimate;
  const rev = o.revenueEstimate === undefined ? 2_000_000_000 : o.revenueEstimate;
  const entry: Record<string, unknown> = {
    date,
    epsActual: null,
    epsEstimate: eps,
    quarter: 3,
    revenueActual: null,
    revenueEstimate: rev,
    symbol: echoed,
    year: 2026,
  };
  if (o.hour !== undefined) entry.hour = o.hour;
  const consensus = [
    eps != null ? `EPS ${eps.toFixed(2)}` : null,
    rev != null ? `Rev ${rev.toLocaleString("en-US")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  upsertCalendarEvents(db, [
    {
      source: "finnhub",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      description: "Q3 2026 report.",
      symbol,
      consensus_estimate: consensus || null,
      raw_json: JSON.stringify({ entry, history: [], finnhub_symbol: echoed }),
      source_key: `finnhub:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`finnhub:${symbol}:${date}`);
}

/** A Nasdaq earnings row as lib/calendar/nasdaq.ts assembles it. */
function nasdaq(symbol: string, date: string, hour: "bmo" | "amc" | null = "amc"): number {
  upsertCalendarEvents(db, [
    {
      source: "nasdaq",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      description: null,
      symbol,
      consensus_estimate: "EPS 1.05",
      raw_json: JSON.stringify({ entry: { hour, epsForecast: 1.05, epsActual: null }, nasdaq_symbol: symbol }),
      source_key: `nasdaq:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`nasdaq:${symbol}:${date}`);
}

const superseded = (id: number) =>
  (db.prepare("SELECT COALESCE(superseded, 0) AS s FROM calendar_events WHERE id = ?").get(id) as { s: number }).s;
const rawOf = (id: number) =>
  JSON.parse((db.prepare("SELECT raw_json FROM calendar_events WHERE id = ?").get(id) as { raw_json: string }).raw_json);

interface Bogey {
  eps_consensus: number | null;
  eps_consensus_vendor: number | null;
  revenue_consensus_usd: number | null;
}
const bogeyOf = (eventId: number) =>
  db
    .prepare(
      `SELECT eps_consensus, eps_consensus_vendor, revenue_consensus_usd
         FROM earnings_bogeys WHERE event_id = ? AND source = 'finnhub'`,
    )
    .get(eventId) as Bogey | undefined;

/** A Finnhub bogey that reached the event another way (the event merge moves one). */
function seedBogey(eventId: number): void {
  db.prepare(
    `INSERT INTO earnings_bogeys (event_id, source, source_label, eps_consensus, eps_consensus_vendor, revenue_consensus_usd)
     VALUES (?, 'finnhub', ?, NULL, 0.5, 900000000)`,
  ).run(eventId, FINNHUB_BOGEY_LABEL);
}

/** Nasdaq row kept (it states the slot), Finnhub row hidden, carry in place. */
function keptNasdaqPair(symbol = "ZZA", finnhubSymbol = symbol): { n: number; f: number } {
  const f = finnhub(finnhubSymbol, PRINT);
  const n = nasdaq(symbol, PRINT, "amc");
  reconcileEarningsDates(db, { today: TODAY });
  expect(superseded(f)).toBe(1);
  expect(superseded(n)).toBe(0);
  return { n, f };
}

describe("between a Nasdaq upsert and the reconcile pass", () => {
  it("the kept row is bare again, and the step keeps the Finnhub bogey", async () => {
    const { n } = keptNasdaqPair();
    expect(await consensusRowStep.run(db, n, ctx)).toEqual({ status: "done" });
    expect(bogeyOf(n)).toEqual({ eps_consensus: null, eps_consensus_vendor: 1, revenue_consensus_usd: 2_000_000_000 });

    nasdaq("ZZA", PRINT, "amc"); // the sync's upsert: raw_json replaced, no reconcile pass yet
    expect(rawOf(n).entry).not.toHaveProperty("symbol"); // precondition: the carry is gone
    expect(rawOf(n)).not.toHaveProperty("finnhub_carried");

    expect(await consensusRowStep.run(db, n, ctx)).toEqual({ status: "done" });
    expect(bogeyOf(n)).toEqual({ eps_consensus: null, eps_consensus_vendor: 1, revenue_consensus_usd: 2_000_000_000 });
  });

  it("a Finnhub revision in the same window reaches the bogey without waiting for the pass", async () => {
    const { n } = keptNasdaqPair();
    await consensusRowStep.run(db, n, ctx);

    nasdaq("ZZA", PRINT, "amc");
    finnhub("ZZA", PRINT, { epsEstimate: 1.2, revenueEstimate: 3_000_000_000 });

    expect(await consensusRowStep.run(db, n, ctx)).toEqual({ status: "done" });
    expect(bogeyOf(n)).toEqual({ eps_consensus: null, eps_consensus_vendor: 1.2, revenue_consensus_usd: 3_000_000_000 });
  });

  it("the fingerprint does not move when the carry is wiped, and moves when the Finnhub row is revised", () => {
    const { n } = keptNasdaqPair();
    // The fingerprint also reads consensus_estimate, which the Nasdaq upsert
    // resets; hold that one column still so only the wiped carry differs.
    const holdConsensus = () =>
      db.prepare("UPDATE calendar_events SET consensus_estimate = 'EPS 1.05' WHERE id = ?").run(n);
    holdConsensus();
    const carried = consensusRowStep.fingerprint(db, n);

    nasdaq("ZZA", PRINT, "amc");
    holdConsensus();
    expect(rawOf(n)).not.toHaveProperty("finnhub_carried"); // precondition
    expect(consensusRowStep.fingerprint(db, n)).toBe(carried);

    finnhub("ZZA", PRINT, { epsEstimate: 1.2 });
    expect(consensusRowStep.fingerprint(db, n)).not.toBe(carried);
  });

  it("a stale carried copy is not trusted over the Finnhub row itself", async () => {
    const { n } = keptNasdaqPair();
    // Finnhub revised; the kept row still holds the old carried keys (no pass yet).
    finnhub("ZZA", PRINT, { epsEstimate: 1.3, revenueEstimate: 2_500_000_000 });
    expect(rawOf(n).entry.epsEstimate).toBe(1); // precondition: the carried copy is stale

    await consensusRowStep.run(db, n, ctx);

    expect(bogeyOf(n)).toEqual({ eps_consensus: null, eps_consensus_vendor: 1.3, revenue_consensus_usd: 2_500_000_000 });
  });
});

describe("a withdrawal needs a Finnhub source that says so", () => {
  it("the hidden Finnhub row drops both estimates: the bogey is withdrawn", async () => {
    const { n } = keptNasdaqPair();
    await consensusRowStep.run(db, n, ctx);
    expect(bogeyOf(n)).toBeDefined();

    nasdaq("ZZA", PRINT, "amc");
    finnhub("ZZA", PRINT, { epsEstimate: null, revenueEstimate: null });

    expect(await consensusRowStep.run(db, n, ctx)).toEqual({
      status: "done",
      note: "vendor consensus withdrawn; finnhub row removed",
    });
    expect(bogeyOf(n)).toBeUndefined();
  });

  it("the hidden Finnhub row turns into a foreign-listing echo: the bogey is withdrawn, as on a Finnhub row", async () => {
    const { n } = keptNasdaqPair();
    await consensusRowStep.run(db, n, ctx);

    finnhub("ZZA", PRINT, { echoed: "9999.TW" });

    await consensusRowStep.run(db, n, ctx);
    expect(bogeyOf(n)).toBeUndefined();
  });

  it("a Nasdaq-only print leaves an existing Finnhub bogey alone", async () => {
    const n = nasdaq("ZZA", PRINT, "amc");
    reconcileEarningsDates(db, { today: TODAY });
    seedBogey(n);

    expect(await consensusRowStep.run(db, n, ctx)).toEqual({ status: "done", note: "no vendor data on this row" });
    expect(bogeyOf(n)).toEqual({ eps_consensus: null, eps_consensus_vendor: 0.5, revenue_consensus_usd: 900_000_000 });
  });

  it("a hand-entered print with no vendor row leaves an existing Finnhub bogey alone", async () => {
    const m = insertCalendarEvent(db, { symbol: "ZZB", event_date: PRINT, event_time: "AMC", week_of: mondayOf(PRINT) }).id;
    seedBogey(m);

    expect(await consensusRowStep.run(db, m, ctx)).toEqual({ status: "done", note: "no vendor data on this row" });
    expect(bogeyOf(m)).toEqual({ eps_consensus: null, eps_consensus_vendor: 0.5, revenue_consensus_usd: 900_000_000 });
  });

  it("a hand-entered row beside only a hidden Nasdaq row: still no Finnhub source, bogey left alone", async () => {
    nasdaq("ZZB", PRINT, "amc");
    const m = insertCalendarEvent(db, { symbol: "ZZB", event_date: PRINT, week_of: mondayOf(PRINT) }).id;
    reconcileEarningsDates(db, { today: TODAY });
    seedBogey(m);

    expect(await consensusRowStep.run(db, m, ctx)).toEqual({ status: "done", note: "no vendor data on this row" });
    expect(bogeyOf(m)).toBeDefined();
  });

  it("carried keys left on a kept row whose Finnhub row is gone are not a Finnhub source", async () => {
    const { n, f } = keptNasdaqPair();
    await consensusRowStep.run(db, n, ctx);
    db.prepare("DELETE FROM calendar_events WHERE id = ?").run(f);
    expect(rawOf(n).finnhub_carried).toBeDefined(); // precondition: the copy is still on the row

    expect(await consensusRowStep.run(db, n, ctx)).toEqual({ status: "done", note: "no vendor data on this row" });
    expect(bogeyOf(n)).toBeDefined();
  });
});

describe("which hidden Finnhub row is read", () => {
  it("a hand-entered kept row reads its hidden Finnhub twin (the carry and the step agree)", async () => {
    const f = finnhub("ZZB", PRINT, { hour: "bmo" });
    const m = insertCalendarEvent(db, { symbol: "ZZB", event_date: PRINT, event_time: "AMC", week_of: mondayOf(PRINT) }).id;
    reconcileEarningsDates(db, { today: TODAY });
    expect(superseded(f)).toBe(1);

    expect(await consensusRowStep.run(db, m, ctx)).toEqual({ status: "done" });
    expect(bogeyOf(m)).toEqual({ eps_consensus: null, eps_consensus_vendor: 1, revenue_consensus_usd: 2_000_000_000 });

    finnhub("ZZB", PRINT, { hour: "bmo", epsEstimate: null, revenueEstimate: null });
    await consensusRowStep.run(db, m, ctx);
    expect(bogeyOf(m)).toBeUndefined();
  });

  it("a share-class twin is found through the issuer family, never by symbol equality", async () => {
    const { n, f } = keptNasdaqPair("GOOG", "GOOGL");
    nasdaq("GOOG", PRINT, "amc"); // wipe the carry

    expect(findHiddenFinnhubDonor(db, { id: n, symbol: "GOOG", event_date: PRINT })?.id).toBe(f);
    expect(await consensusRowStep.run(db, n, ctx)).toEqual({ status: "done" });
    expect(bogeyOf(n)).toEqual({ eps_consensus: null, eps_consensus_vendor: 1, revenue_consensus_usd: 2_000_000_000 });
  });

  it("with two hidden Finnhub rows it is the one the carry picked: nearest date, then lowest id", () => {
    const far = finnhub("ZZA", "2026-11-03");
    const same = finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    reconcileEarningsDates(db, { today: TODAY });
    expect(superseded(far)).toBe(1);

    expect(findHiddenFinnhubDonor(db, { id: n, symbol: "ZZA", event_date: PRINT })?.id).toBe(same);
    expect(rawOf(n).finnhub_carried.from_event_id).toBe(same);
  });

  it("a Finnhub row that is still showing is not a hidden twin", () => {
    const f = finnhub("ZZA", PRINT, { hour: "amc" });
    const n = nasdaq("ZZA", PRINT, "amc");
    reconcileEarningsDates(db, { today: TODAY });
    expect(superseded(f)).toBe(0); // Finnhub kept, Nasdaq hidden

    expect(findHiddenFinnhubDonor(db, { id: n, symbol: "ZZA", event_date: PRINT })).toBeNull();
  });

  it("another company's hidden Finnhub row on the same date is never read", async () => {
    keptNasdaqPair("ZZA");
    const other = nasdaq("ZZC", PRINT, "amc");
    seedBogey(other);

    expect(await consensusRowStep.run(db, other, ctx)).toEqual({ status: "done", note: "no vendor data on this row" });
    expect(bogeyOf(other)?.eps_consensus_vendor).toBe(0.5);
  });
});

describe("a zero revenue estimate is Finnhub's placeholder", () => {
  it("is never promoted to the bogey (EPS still is)", async () => {
    const f = finnhub("ZZA", PRINT, { hour: "amc", revenueEstimate: 0 });

    expect(await consensusRowStep.run(db, f, ctx)).toEqual({ status: "done" });
    expect(bogeyOf(f)).toEqual({ eps_consensus: null, eps_consensus_vendor: 1, revenue_consensus_usd: null });
  });
});
