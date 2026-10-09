/**
 * Snapshot v14: `earningsHeldSymbols`, and Mac / Worker parity on "held" for
 * earnings coverage (owner ruling 2026-10-09: the cloud's earnings coverage
 * includes a name held only through options or only short, as the Mac's does).
 *
 *   Mac:    getSymbolStatusDetailed -> coveredForEvents / the push gates
 *           (lib/queries/briefing-symbols.ts)
 *   Field:  getEarningsHeldSymbols (same file), which ASKS that reader and
 *           writes no second rule
 *   Worker: earningsHeldSet (workers/cron/src/earnings-held.ts), read by
 *           isCoveredInCloud, the today's-reporters chip and the print push
 *
 * Runs the real snapshot builder on a small migrated in-memory book and the
 * real Worker readers on its output. Three links, so drift anywhere fails:
 *   1. the field holds exactly the names the Mac's reader calls held;
 *   2. the Worker's held test on the snapshot agrees with the Mac's reader
 *      for every probe symbol, and its event coverage agrees with
 *      coveredForEvents for every event;
 *   3. `heldSymbols` is unchanged (long stock) and the field is a superset.
 *
 * Invented tickers and round numbers only: the repo is public. (GOOG / GOOGL
 * is the share-class family the issuer table defines.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildSnapshot } from "@/scripts/snapshot-state-to-r2";
import {
  coveredForEvents,
  getEarningsHeldSymbols,
  getHeldStockSymbols,
  getSymbolStatusDetailed,
} from "@/lib/queries/briefing-symbols";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { issuerSiblings as macIssuerSiblings } from "@/lib/securities/issuer-family";
import { earningsHeldSet } from "../../workers/cron/src/earnings-held";
import { effectiveCalendarEvents, isCoveredInCloud } from "../../workers/cron/src/armed-events";
import { issuerSiblings as workerIssuerSiblings } from "../../workers/cron/src/fallback-earnings";
import type { Snapshot as WorkerSnapshot } from "../../workers/cron/src/state";

const TODAY = "2026-06-11";

let db: Database.Database;
let account: number;
let otherAccount: number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T14:00:00Z`)); // 10:00 Eastern
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  account = Number(db.prepare(`INSERT INTO accounts (name) VALUES ('Desk')`).run().lastInsertRowid);
  otherAccount = Number(db.prepare(`INSERT INTO accounts (name) VALUES ('Second')`).run().lastInsertRowid);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function security(o: {
  symbol: string;
  type?: string;
  underlying?: string;
  expiration?: string;
  fundCategory?: string;
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities
           (symbol, name, security_type, underlying_symbol, expiration_date, multiplier,
            option_type, strike_price, fund_category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.symbol,
        o.symbol,
        o.type ?? "Stock",
        o.underlying ?? null,
        o.expiration ?? null,
        o.underlying ? 100 : null,
        o.underlying ? "CALL" : null,
        o.underlying ? 50 : null,
        o.fundCategory ?? null,
      ).lastInsertRowid,
  );
}

function holding(securityId: number, quantity: number, asOf = "2026-06-05", acct = account): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(acct, securityId, quantity, 1000, asOf, `test:${acct}:${securityId}:${asOf}`);
}

function option(underlying: string, expiration: string, quantity: number): number {
  const id = security({
    symbol: `${underlying}   OPT ${expiration}`,
    type: "Option",
    underlying,
    expiration,
  });
  holding(id, quantity);
  return id;
}

let nextEventId = 1;
function earningsEvent(symbol: string): number {
  const id = nextEventId++;
  db.prepare(
    `INSERT INTO calendar_events
       (id, source, event_type, event_date, event_time, release_time, title, symbol,
        source_key, week_of)
     VALUES (?, 'finnhub', 'earnings', ?, 'AMC', '16:00', ?, ?, ?, '2026-06-08')`,
  ).run(id, TODAY, `${symbol} earnings`, symbol, `finnhub:${symbol}:${TODAY}`);
  return id;
}

/**
 * The book:
 *   ZZL   long stock
 *   ZZO   option-only, live option (dashed expiry)
 *   ZZC   option-only, live option (legacy compact expiry)
 *   ZZP   option-only, a WRITTEN (short) live option
 *   ZZX   option-only, option EXPIRED (dashed)            -> not covered
 *   ZZY   option-only, option EXPIRED (legacy compact)    -> not covered
 *   ZZS   short-only stock
 *   ZZM   cash-equivalent fund, held
 *   GOOG  long stock; GOOGL is its share-class sibling
 *   ZZQ   sold: newest row is a zero-quantity tombstone   -> not covered
 *   ZZT   long in one account, sold in another           -> covered
 *   ZZW   on the watchlist only (not held)
 *   ZZN   known security, never held
 */
function seedBook(): void {
  nextEventId = 1;
  holding(security({ symbol: "ZZL" }), 100);
  option("ZZO", "2027-01-15", 2);
  option("ZZC", "20270115", 2);
  option("ZZP", "2026-06-11", -1); // expires TODAY: still live today
  option("ZZX", "2026-05-15", 2);
  option("ZZY", "20260515", 2);
  holding(security({ symbol: "ZZS" }), -50);
  holding(security({ symbol: "ZZM", type: "Mutual Fund", fundCategory: "Cash Equivalent" }), 500);
  holding(security({ symbol: "GOOG" }), 10);
  const sold = security({ symbol: "ZZQ" });
  holding(sold, 40, "2026-05-01");
  holding(sold, 0, "2026-06-05");
  const partly = security({ symbol: "ZZT" });
  holding(partly, 40, "2026-05-01");
  holding(partly, 0, "2026-06-05");
  holding(partly, 25, "2026-06-01", otherAccount);
  const watched = security({ symbol: "ZZW" });
  db.prepare(`INSERT INTO watchlist (security_id, is_active) VALUES (?, 1)`).run(watched);
  security({ symbol: "ZZN" });
}

const EXPECTED_HELD = ["GOOG", "GOOGL", "ZZC", "ZZL", "ZZM", "ZZO", "ZZP", "ZZS", "ZZT"];

/** Every name in the book, plus the sibling and two names in no table. */
const PROBES = [
  "ZZL", "ZZO", "ZZC", "ZZP", "ZZX", "ZZY", "ZZS", "ZZM", "GOOG", "GOOGL",
  "ZZQ", "ZZT", "ZZW", "ZZN", "ZZZ", "BRK B",
];

const snapshot = (): WorkerSnapshot => buildSnapshot(db) as unknown as WorkerSnapshot;

const workerHeld = (snap: WorkerSnapshot, symbol: string): boolean => {
  const set = earningsHeldSet(snap);
  return workerIssuerSiblings(symbol).some((s) => set.has(s.toUpperCase()));
};

describe("snapshot earningsHeldSymbols", () => {
  it("is version 14", () => {
    expect(snapshot().schemaVersion).toBe(14);
  });

  it("lists the long, option-only (live), short-only, cash-like and sibling names; never an expired-option or sold name", () => {
    seedBook();
    const field = snapshot().earningsHeldSymbols;
    expect(field).toEqual(EXPECTED_HELD);
    for (const out of ["ZZX", "ZZY", "ZZQ", "ZZW", "ZZN"]) expect(field, out).not.toContain(out);
  });

  it("link 1: the field is exactly the set the Mac's coverage reader calls held", () => {
    seedBook();
    const detailed = getSymbolStatusDetailed(db, PROBES);
    const macHeld = PROBES.filter((p) => detailed[p.toUpperCase()].reasons.held).sort();
    expect(macHeld).toEqual(EXPECTED_HELD);
    expect(snapshot().earningsHeldSymbols).toEqual(macHeld);
    expect(getEarningsHeldSymbols(db)).toEqual(macHeld);
  });

  it("link 2a: the Worker's held test on the snapshot agrees with the Mac's reader, probe by probe", () => {
    seedBook();
    const snap = snapshot();
    const detailed = getSymbolStatusDetailed(db, PROBES);
    for (const p of PROBES) {
      expect(workerHeld(snap, p), p).toBe(detailed[p.toUpperCase()].reasons.held);
    }
  });

  it("link 2b: cloud event coverage equals coveredForEvents, event by event", () => {
    seedBook();
    const events = PROBES.map((symbol) => ({ symbol, eventId: earningsEvent(symbol) }));
    const mac = coveredForEvents(db, events);

    const snap = snapshot();
    const eff = effectiveCalendarEvents(snap, null);
    const cloud = new Set(
      events
        .filter((e) => isCoveredInCloud(snap, eff, { id: e.eventId, symbol: e.symbol }))
        .map((e) => e.eventId),
    );
    expect([...cloud].sort((a, b) => a - b)).toEqual([...mac].sort((a, b) => a - b));

    const coveredSymbols = events.filter((e) => mac.has(e.eventId)).map((e) => e.symbol).sort();
    // The held names, plus the watchlist name.
    expect(coveredSymbols).toEqual([...EXPECTED_HELD, "ZZW"].sort());
  });

  it("the gap this closes: without the field the cloud covers long stock only", () => {
    seedBook();
    const { earningsHeldSymbols: _dropped, ...older } = snapshot();
    const old = older as WorkerSnapshot;
    const before = PROBES.filter((p) => workerHeld(old, p)).sort();
    expect(before).toEqual(["GOOG", "GOOGL", "ZZL", "ZZT"]);
    for (const gained of ["ZZO", "ZZC", "ZZP", "ZZS"]) {
      expect(before, gained).not.toContain(gained);
      expect(workerHeld(snapshot(), gained), gained).toBe(true);
    }
  });

  it("link 3: heldSymbols keeps its meaning (long stock) and the field is a superset of it", () => {
    seedBook();
    const snap = snapshot();
    expect(snap.heldSymbols).toEqual(getHeldStockSymbols(db));
    expect(snap.heldSymbols).toEqual(["GOOG", "ZZL", "ZZT"]);
    const field = new Set(snap.earningsHeldSymbols);
    for (const s of snap.heldSymbols) expect(field.has(s.toUpperCase()), s).toBe(true);
  });

  it("an option expiring today is live today and expired tomorrow", () => {
    seedBook();
    expect(getEarningsHeldSymbols(db, { today: TODAY })).toContain("ZZP");
    expect(getEarningsHeldSymbols(db, { today: "2026-06-12" })).not.toContain("ZZP");
  });

  it("the cash-like fund is in because the Mac's reader is type-blind for a direct holding (pinned, not chosen here)", () => {
    seedBook();
    expect(isCashEquivalentSecurity({ security_type: "Mutual Fund", fund_category: "Cash Equivalent" })).toBe(true);
    expect(getSymbolStatusDetailed(db, ["ZZM"]).ZZM.reasons.held).toBe(true);
    expect(snapshot().earningsHeldSymbols).toContain("ZZM");
    expect(snapshot().heldSymbols).not.toContain("ZZM");
  });

  it("symbols only: no option contract symbol, no quantity, no direction, no option terms", () => {
    seedBook();
    const field = snapshot().earningsHeldSymbols ?? [];
    for (const s of field) {
      expect(typeof s).toBe("string");
      expect(s, s).toMatch(/^[A-Z]+$/);
    }
    const text = JSON.stringify(field);
    expect(text).not.toMatch(/OPT|2027|2026|CALL|PUT|short|long|-50|500/i);
  });

  it("is an empty list, not a missing field, for an empty book", () => {
    expect(snapshot().earningsHeldSymbols).toEqual([]);
    // An empty list is "no held names"; the Worker does not fall back.
    expect(earningsHeldSet(snapshot()).size).toBe(0);
  });

  it("asks about more symbols than one query's worth without losing any", () => {
    for (let i = 0; i < 950; i++) {
      const a = String.fromCharCode(65 + (i % 26));
      const b = String.fromCharCode(65 + (Math.floor(i / 26) % 26));
      const c = String.fromCharCode(65 + Math.floor(i / 676));
      holding(security({ symbol: `Q${a}${b}${c}Q` }), i % 2 === 0 ? 10 : -10);
    }
    expect(getEarningsHeldSymbols(db)).toHaveLength(950);
  });
});

describe("one rule, not two (source pins)", () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf-8");

  it("the snapshot builder takes the field from getEarningsHeldSymbols and still takes heldSymbols from getHeldStockSymbols", () => {
    const src = read("scripts/snapshot-state-to-r2.ts");
    expect(src).toContain("return getEarningsHeldSymbols(db, { today: todayET() });");
    expect(src).toContain("heldSymbols: getHeldStockSymbols(db)");
    expect(src).toContain("schemaVersion: 14");
  });

  it("getEarningsHeldSymbols decides through getSymbolStatusDetailed: no expiry compare, no latest-row MAX, no quantity test of its own", () => {
    const src = read("lib/queries/briefing-symbols.ts");
    const start = src.indexOf("export function getEarningsHeldSymbols(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\nexport function ", start + 10);
    const body = src.slice(start, end);
    expect(body).toContain("getSymbolStatusDetailed(");
    expect(body).toContain("reasons.held");
    expect(body).not.toMatch(/MAX\s*\(/i);
    expect(body).not.toMatch(/expiration/i);
    expect(body).not.toMatch(/quantity/i);
  });

  it("the two share-class tables agree for the probes (the field is family-closed on the Mac, the Worker expands again)", () => {
    for (const p of PROBES) {
      expect([...workerIssuerSiblings(p)].map((s) => s.toUpperCase()).sort(), p).toEqual(
        [...macIssuerSiblings(p)].map((s) => s.toUpperCase()).sort(),
      );
    }
  });
});
