import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { insertCalendarEvent, upsertCalendarEvents } from "@/lib/mutations/calendar";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import { resolveReleaseTime } from "@/lib/calendar/release-times";
import { readVendorConsensus } from "@/lib/earnings/prepare-steps/consensus-row";
import { mondayOf } from "@/lib/calendar/date-utils";

// Since the 2026-10-08 slot ruling a Nasdaq row can keep a print and hide the
// Finnhub row. The Finnhub row is the only one that carries the vendor's
// estimate pair + fiscal quarter in raw_json (read by the vendor-consensus
// prepare step), the "last four quarters" description (read by the weekly
// briefing) and a revenue estimate in consensus_estimate (read by the
// earnings emails). The reconcile pass now carries those onto the kept row —
// only what the kept row lacks, and never its slot evidence.
//
// Vendor rows go through the real writer in the shapes lib/calendar/finnhub.ts
// and lib/calendar/nasdaq.ts produce. Synthetic symbols, invented round figures.

const TODAY = "2026-11-02"; // Monday
const PRINT = "2026-11-05";

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
  hour?: "bmo" | "amc" | "dmh" | "";
  epsEstimate?: number | null;
  revenueEstimate?: number | null;
  quarter?: number;
  epsActual?: number | null;
  echoed?: string;
  /** Overrides the description the writer would assemble (null = none). */
  description?: string | null;
}

/** A Finnhub earnings row as lib/calendar/finnhub.ts assembles it. */
function finnhub(symbol: string, date: string, o: FinnhubOpts = {}): number {
  const echoed = o.echoed ?? symbol;
  const eps = o.epsEstimate === undefined ? 1 : o.epsEstimate;
  const rev = o.revenueEstimate === undefined ? 2_000_000_000 : o.revenueEstimate;
  const quarter = o.quarter ?? 3;
  const entry: Record<string, unknown> = {
    date,
    epsActual: o.epsActual ?? null,
    epsEstimate: eps,
    quarter,
    revenueActual: null,
    revenueEstimate: rev,
    symbol: echoed,
    year: 2026,
  };
  if (o.hour !== undefined) entry.hour = o.hour;
  // The real writer prints a zero estimate as the literal placeholder "Rev 0".
  const consensus = [eps != null ? `EPS ${eps.toFixed(2)}` : null, rev != null ? (rev === 0 ? "Rev 0" : `Rev ${rev / 1e9}B`) : null]
    .filter(Boolean)
    .join(" · ");
  upsertCalendarEvents(db, [
    {
      source: "finnhub",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      description:
        o.description !== undefined
          ? o.description
          : `Q${quarter} 2026 report.\n\nLast 4 quarters (EPS):\n  - Q${quarter - 1} 2026: actual 1.10 vs est 1.00 (surprise 10.0%)`,
      symbol,
      consensus_estimate: consensus || null,
      raw_json: JSON.stringify({
        entry,
        history: [{ quarter: quarter - 1, year: 2026, actual: 1.1, estimate: 1, surprisePercent: 10 }],
        finnhub_symbol: echoed,
      }),
      source_key: `finnhub:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`finnhub:${symbol}:${date}`);
}

/** A Nasdaq earnings row as lib/calendar/nasdaq.ts assembles it. */
function nasdaq(symbol: string, date: string, hour: "bmo" | "amc" | null, epsForecast: number | null = 1.05): number {
  upsertCalendarEvents(db, [
    {
      source: "nasdaq",
      event_type: "earnings",
      event_date: date,
      event_time: null,
      title: `${symbol} earnings`,
      description: null,
      symbol,
      consensus_estimate: epsForecast != null ? `EPS ${epsForecast.toFixed(2)}` : null,
      raw_json: JSON.stringify({ entry: { hour, epsForecast, epsActual: null }, nasdaq_symbol: symbol }),
      source_key: `nasdaq:${symbol}:${date}`,
      week_of: mondayOf(date),
    },
  ]);
  return idOf(`nasdaq:${symbol}:${date}`);
}

interface Row {
  source: string;
  symbol: string;
  event_type: string;
  event_time: string | null;
  release_time: string | null;
  raw_json: string | null;
  description: string | null;
  consensus_estimate: string | null;
  superseded: number;
}
const rowOf = (id: number) =>
  db
    .prepare(
      `SELECT source, symbol, event_type, event_time, release_time, raw_json, description,
              consensus_estimate, COALESCE(superseded, 0) AS superseded
         FROM calendar_events WHERE id = ?`,
    )
    .get(id) as Row;
const jsonOf = (id: number) => JSON.parse(rowOf(id).raw_json ?? "null");
const slotOf = (id: number) => deriveEarningsSlot(rowOf(id));
const outboxRows = () => (db.prepare("SELECT COUNT(*) AS n FROM cloud_outbox").get() as { n: number }).n;

describe("Nasdaq row kept, Finnhub row hidden", () => {
  it("carries the Finnhub estimate pair, fiscal quarter and history; the kept row's slot is untouched", () => {
    const f = finnhub("ZZA", PRINT, { hour: "dmh" });
    const n = nasdaq("ZZA", PRINT, "bmo");
    const slotBefore = slotOf(n);
    const releaseBefore = resolveReleaseTime(rowOf(n));
    expect(slotBefore).toBe("bmo");

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(f).superseded).toBe(1);
    expect(rowOf(n).superseded).toBe(0);
    const j = jsonOf(n);
    // The kept row's own keys, exactly as Nasdaq wrote them.
    expect(j.entry.hour).toBe("bmo");
    expect(j.entry.epsForecast).toBe(1.05);
    expect(j.entry.epsActual).toBeNull();
    expect(j.nasdaq_symbol).toBe("ZZA");
    // What it lacked.
    expect(j.entry).toMatchObject({ symbol: "ZZA", epsEstimate: 1, revenueEstimate: 2_000_000_000, quarter: 3, year: 2026 });
    expect(j.finnhub_symbol).toBe("ZZA");
    expect(j.history).toHaveLength(1);
    expect(j.finnhub_carried.from_event_id).toBe(f);
    // Never carried: the loser's hour, its date, or any actual.
    expect(j.entry).not.toHaveProperty("date");
    expect(j.entry).not.toHaveProperty("revenueActual");
    expect(j.finnhub_carried.keys).not.toContain("entry.hour");

    expect(slotOf(n)).toBe(slotBefore);
    expect(resolveReleaseTime(rowOf(n))).toBe(releaseBefore);
    // The reader in lib/earnings/prepare-steps/consensus-row.ts now finds the pair.
    expect(readVendorConsensus(rowOf(n).raw_json, "ZZA")).toEqual({ eps: 1, revenue: 2_000_000_000 });
  });

  it("a Finnhub row with no hour key or an empty hour never shadows the kept row's slot", () => {
    finnhub("ZZA", PRINT); // no hour key at all
    const n1 = nasdaq("ZZA", PRINT, "amc");
    finnhub("ZZB", PRINT, { hour: "" });
    const n2 = nasdaq("ZZB", PRINT, "bmo");

    reconcileEarningsDates(db, { today: TODAY });

    expect(jsonOf(n1).entry.hour).toBe("amc");
    expect(slotOf(n1)).toBe("amc");
    expect(jsonOf(n2).entry.hour).toBe("bmo");
    expect(slotOf(n2)).toBe("bmo");
  });

  it("carries the description and appends only the revenue estimate to the kept row's consensus", () => {
    const f = finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(n).description).toBe(rowOf(f).description);
    expect(rowOf(n).description).toContain("Last 4 quarters");
    // Nasdaq's own EPS forecast stays; Finnhub's revenue estimate is added.
    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05 · Rev 2B");
  });

  it("a second pass writes nothing", () => {
    finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    reconcileEarningsDates(db, { today: TODAY });
    const after1 = rowOf(n);
    const outbox1 = outboxRows();

    const second = reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(n)).toEqual(after1);
    expect(second.superseded).toEqual([]);
    expect(outboxRows()).toBe(outbox1);
  });

  it("the next Nasdaq sync resets the row; the reconcile pass that follows the sync carries again", () => {
    finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    reconcileEarningsDates(db, { today: TODAY });

    nasdaq("ZZA", PRINT, "amc"); // same source_key: the upsert replaces raw_json
    expect(jsonOf(n).entry).not.toHaveProperty("epsEstimate");
    expect(rowOf(n).description).toBeNull();
    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05");

    reconcileEarningsDates(db, { today: TODAY });

    expect(jsonOf(n).entry).toMatchObject({ hour: "amc", epsEstimate: 1, revenueEstimate: 2_000_000_000 });
    expect(rowOf(n).description).toContain("Last 4 quarters");
    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05 · Rev 2B");
    expect(slotOf(n)).toBe("amc");
  });

  it("a revised Finnhub estimate refreshes the carried copy on the next pass", () => {
    finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    reconcileEarningsDates(db, { today: TODAY });

    finnhub("ZZA", PRINT, { epsEstimate: 1.2, revenueEstimate: null });
    reconcileEarningsDates(db, { today: TODAY });

    const j = jsonOf(n);
    expect(j.entry.epsEstimate).toBe(1.2);
    expect(j.entry.revenueEstimate).toBeNull();
    expect(j.entry.hour).toBe("amc");
    expect(readVendorConsensus(rowOf(n).raw_json, "ZZA")).toEqual({ eps: 1.2, revenue: null });
  });

  it("never overwrites a key the kept row already has (defensive: a shape Nasdaq does not write today)", () => {
    finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    db.prepare("UPDATE calendar_events SET raw_json = ?, description = 'own text' WHERE id = ?").run(
      JSON.stringify({ entry: { hour: "amc", epsForecast: 1.05, epsActual: null, year: 2027 }, nasdaq_symbol: "ZZA" }),
      n,
    );

    reconcileEarningsDates(db, { today: TODAY });
    reconcileEarningsDates(db, { today: TODAY });

    const j = jsonOf(n);
    expect(j.entry.year).toBe(2027);
    expect(j.finnhub_carried.keys).not.toContain("entry.year");
    expect(j.entry.quarter).toBe(3);
    expect(rowOf(n).description).toBe("own text");
  });

  it("with two hidden Finnhub rows the one on the kept row's date is the donor", () => {
    const far = finnhub("ZZA", "2026-11-03", { quarter: 2 });
    const same = finnhub("ZZA", PRINT, { quarter: 3 });
    const n = nasdaq("ZZA", PRINT, "amc");

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(far).superseded).toBe(1);
    expect(rowOf(same).superseded).toBe(1);
    expect(jsonOf(n).entry.quarter).toBe(3);
    expect(jsonOf(n).finnhub_carried.from_event_id).toBe(same);
    expect(rowOf(n).description).toContain("Q3 2026 report.");
    const settled = rowOf(n);
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(n)).toEqual(settled);
  });

  it("a foreign-listing echo reads on the kept row exactly as it reads on the Finnhub row", () => {
    const f = finnhub("ZZA", PRINT, { echoed: "9999.TW" });
    const n = nasdaq("ZZA", PRINT, "amc");

    reconcileEarningsDates(db, { today: TODAY });

    expect(readVendorConsensus(rowOf(n).raw_json, "ZZA")).toBe(readVendorConsensus(rowOf(f).raw_json, "ZZA"));
    expect(readVendorConsensus(rowOf(n).raw_json, "ZZA")).toBeNull();
  });
});

describe("hand-entered row kept, Finnhub row hidden", () => {
  it("carries the vendor data; the typed slot, consensus and description stay the person's", () => {
    const f = finnhub("ZZB", PRINT, { hour: "bmo" });
    const m = insertCalendarEvent(db, {
      symbol: "ZZB",
      event_date: PRINT,
      event_time: "AMC",
      consensus_estimate: "EPS 0.90",
      description: "my note",
      week_of: mondayOf(PRINT),
    }).id;
    const releaseBefore = rowOf(m).release_time;

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(f).superseded).toBe(1);
    const j = jsonOf(m);
    expect(j.entry).toMatchObject({ symbol: "ZZB", epsEstimate: 1, quarter: 3, year: 2026 });
    expect(j.entry).not.toHaveProperty("hour"); // the Finnhub "bmo" must not reach a row typed as AMC
    expect(slotOf(m)).toBe("amc");
    expect(rowOf(m).release_time).toBe(releaseBefore);
    expect(resolveReleaseTime(rowOf(m))).toBe(resolveReleaseTime({ ...rowOf(m), raw_json: null }));
    expect(rowOf(m).consensus_estimate).toBe("EPS 0.90"); // typed text is never edited
    expect(rowOf(m).description).toBe("my note");
  });

  it("fills an empty description and consensus; a second pass writes nothing", () => {
    const f = finnhub("ZZB", PRINT);
    const m = insertCalendarEvent(db, { symbol: "ZZB", event_date: PRINT, week_of: mondayOf(PRINT) }).id;

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(m).description).toBe(rowOf(f).description);
    expect(rowOf(m).consensus_estimate).toBe("EPS 1.00 · Rev 2B");
    const settled = rowOf(m);
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(m)).toEqual(settled);
  });
});

describe("nothing is carried when it should not be", () => {
  it("Finnhub row kept, Nasdaq row hidden: the Finnhub row is untouched", () => {
    const f = finnhub("ZZA", PRINT, { hour: "amc" });
    nasdaq("ZZA", PRINT, "amc");
    const before = rowOf(f);

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(f)).toEqual(before);
  });

  it("hand-entered row kept, only a Nasdaq row hidden: no vendor entry appears", () => {
    nasdaq("ZZB", PRINT, "amc");
    const m = insertCalendarEvent(db, { symbol: "ZZB", event_date: PRINT, week_of: mondayOf(PRINT) }).id;

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(m).raw_json).toBeNull();
    expect(readVendorConsensus(rowOf(m).raw_json, "ZZB")).toBeUndefined();
  });

  it("a kept row whose raw_json is not valid JSON is left alone", () => {
    finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    // Precondition for the fixture: make the pass keep the Nasdaq row first.
    reconcileEarningsDates(db, { today: TODAY });
    db.prepare("UPDATE calendar_events SET raw_json = 'not json' WHERE id = ?").run(n);

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(n).raw_json).toBe("not json");
  });
});

// Codex second opinion, fix 1 (2026-10-08): what the carry wrote into the
// kept row's `consensus_estimate` (the revenue part) and `description` used to
// be write-once, so a later Finnhub revision or withdrawal never reached the
// earnings email scoreboard. The marker now records both, and each pass
// refreshes or removes exactly what it carried.
describe("the carried revenue part follows the Finnhub row", () => {
  it("Finnhub revises its revenue estimate: the kept row shows the new figure", () => {
    finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05 · Rev 2B");
    expect(jsonOf(n).finnhub_carried.consensus_revenue).toBe("Rev 2B");

    finnhub("ZZA", PRINT, { revenueEstimate: 3_000_000_000 });
    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05 · Rev 3B");
    expect(jsonOf(n).finnhub_carried.consensus_revenue).toBe("Rev 3B");
    const settled = rowOf(n);
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(n)).toEqual(settled);
  });

  it("Finnhub withdraws its revenue estimate: the carried part is removed, Nasdaq's EPS stays", () => {
    finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    reconcileEarningsDates(db, { today: TODAY });

    finnhub("ZZA", PRINT, { revenueEstimate: null });
    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05");
    expect(jsonOf(n).finnhub_carried).not.toHaveProperty("consensus_revenue");
    const settled = rowOf(n);
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(n)).toEqual(settled);
  });

  it("a revenue figure the kept row has of its own is never edited (defensive: Nasdaq does not write one today)", () => {
    finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    db.prepare("UPDATE calendar_events SET consensus_estimate = 'EPS 1.05 · Rev 5B' WHERE id = ?").run(n);

    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05 · Rev 5B");
    expect(jsonOf(n).finnhub_carried).not.toHaveProperty("consensus_revenue");

    finnhub("ZZA", PRINT, { revenueEstimate: 3_000_000_000 });
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05 · Rev 5B");

    finnhub("ZZA", PRINT, { revenueEstimate: null });
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05 · Rev 5B");
  });

  it("a hand-entered row's typed consensus is never edited, whatever the Finnhub row does", () => {
    finnhub("ZZB", PRINT);
    const m = insertCalendarEvent(db, {
      symbol: "ZZB",
      event_date: PRINT,
      event_time: "AMC",
      consensus_estimate: "EPS 0.90 · Rev 2B",
      week_of: mondayOf(PRINT),
    }).id;
    reconcileEarningsDates(db, { today: TODAY });

    finnhub("ZZB", PRINT, { revenueEstimate: null });
    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(m).consensus_estimate).toBe("EPS 0.90 · Rev 2B");
  });

  it("a zero revenue estimate is Finnhub's placeholder and is never carried", () => {
    const f = finnhub("ZZA", PRINT, { revenueEstimate: 0 });
    const n = nasdaq("ZZA", PRINT, "amc");
    expect(rowOf(f).consensus_estimate).toBe("EPS 1.00 · Rev 0"); // precondition: the writer's shape

    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05");
    const j = jsonOf(n);
    expect(j.entry).not.toHaveProperty("revenueEstimate");
    expect(j.finnhub_carried.keys).not.toContain("entry.revenueEstimate");
    expect(j.entry.epsEstimate).toBe(1);
    expect(readVendorConsensus(rowOf(n).raw_json, "ZZA")).toEqual({ eps: 1, revenue: null });
  });

  it("a real estimate that turns into the zero placeholder is removed again", () => {
    finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    reconcileEarningsDates(db, { today: TODAY });

    finnhub("ZZA", PRINT, { revenueEstimate: 0 });
    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05");
    expect(jsonOf(n).entry).not.toHaveProperty("revenueEstimate");
  });

  it("a Nasdaq sync that states no forecast keeps the old text and wipes the marker; the carried part is still followed", () => {
    finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    reconcileEarningsDates(db, { today: TODAY });

    // The upsert replaces raw_json (marker gone) but COALESCEs consensus_estimate.
    nasdaq("ZZA", PRINT, "amc", null);
    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05 · Rev 2B");
    expect(jsonOf(n)).not.toHaveProperty("finnhub_carried");
    reconcileEarningsDates(db, { today: TODAY });
    expect(jsonOf(n).finnhub_carried.consensus_revenue).toBe("Rev 2B");

    finnhub("ZZA", PRINT, { revenueEstimate: 3_000_000_000 });
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(n).consensus_estimate).toBe("EPS 1.05 · Rev 3B");
  });
});

describe("the carried description follows the Finnhub row", () => {
  it("Finnhub changes its text: the kept row's carried description is refreshed", () => {
    const f = finnhub("ZZA", PRINT);
    const n = nasdaq("ZZA", PRINT, "amc");
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(n).description).toContain("Q3 2026 report.");

    finnhub("ZZA", PRINT, { quarter: 4 });
    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(n).description).toBe(rowOf(f).description);
    expect(rowOf(n).description).toContain("Q4 2026 report.");
    const settled = rowOf(n);
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(n)).toEqual(settled);
  });

  it("Finnhub drops its text: the carried description is removed", () => {
    finnhub("ZZB", PRINT);
    const m = insertCalendarEvent(db, { symbol: "ZZB", event_date: PRINT, week_of: mondayOf(PRINT) }).id;
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(m).description).toContain("Last 4 quarters");

    finnhub("ZZB", PRINT, { description: null });
    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(m).description).toBeNull();
    expect(jsonOf(m).finnhub_carried).not.toHaveProperty("description");
  });

  it("text a person typed over the carried description is never replaced", () => {
    finnhub("ZZB", PRINT);
    const m = insertCalendarEvent(db, { symbol: "ZZB", event_date: PRINT, week_of: mondayOf(PRINT) }).id;
    reconcileEarningsDates(db, { today: TODAY });
    db.prepare("UPDATE calendar_events SET description = 'my own note' WHERE id = ?").run(m);

    finnhub("ZZB", PRINT, { quarter: 4 });
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(m).description).toBe("my own note");

    finnhub("ZZB", PRINT, { description: null });
    reconcileEarningsDates(db, { today: TODAY });
    expect(rowOf(m).description).toBe("my own note");
  });

  it("a description the kept row had before any carry is never replaced", () => {
    finnhub("ZZB", PRINT);
    const m = insertCalendarEvent(db, {
      symbol: "ZZB",
      event_date: PRINT,
      description: "my note",
      week_of: mondayOf(PRINT),
    }).id;
    reconcileEarningsDates(db, { today: TODAY });

    finnhub("ZZB", PRINT, { quarter: 4 });
    reconcileEarningsDates(db, { today: TODAY });

    expect(rowOf(m).description).toBe("my note");
    expect(jsonOf(m).finnhub_carried).not.toHaveProperty("description");
  });
});
