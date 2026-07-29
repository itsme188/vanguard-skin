/**
 * "Today's reporters" block (spec:
 * docs/superpowers/specs/2026-07-16-todays-reporters-digest-block-design.md).
 *
 * Deterministic morning-digest table of today-ET's earnings reporters:
 * slot + release time, symbol, position chip (held/wl/rt/—), compact
 * consensus, cached implied move. Failure-tolerant by design: no reporters
 * → block omitted (off-season auto-quiet), missing intel → "—", any
 * assembly error → warn once + null.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  renderTodaysReportersBlock,
  type ReporterRowView,
} from "@/lib/digest/todays-reporters-render";
import { composeTodaysReportersBlock } from "@/lib/digest/todays-reporters";

const TODAY = "2026-07-16";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ── Fixtures ─────────────────────────────────────────────────────────

function seedAccount(name = "Test Account"): number {
  return Number(db.prepare(`INSERT INTO accounts (name) VALUES (?)`).run(name).lastInsertRowid);
}

function seedSecurity(symbol: string, type = "Stock"): number {
  return Number(
    db
      .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)`)
      .run(symbol, symbol, type).lastInsertRowid,
  );
}

function seedHolding(accountId: number, securityId: number, quantity: number) {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, '2026-07-15', ?)`,
  ).run(accountId, securityId, quantity, `t:${accountId}:${securityId}`);
}

function seedEvent(opts: {
  symbol: string;
  date?: string;
  source?: string;
  releaseTime?: string | null;
  eventTime?: string | null;
  consensus?: string | null;
  superseded?: number;
}): number {
  const date = opts.date ?? TODAY;
  const source = opts.source ?? "finnhub";
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, event_time, release_time, title,
            symbol, consensus_estimate, source_key, week_of, superseded)
         VALUES (?, 'earnings', ?, ?, ?, ?, ?, ?, ?, '2026-07-13', ?)`,
      )
      .run(
        source,
        date,
        opts.eventTime ?? null,
        opts.releaseTime === undefined ? "08:00" : opts.releaseTime,
        `${opts.symbol} earnings`,
        opts.symbol,
        opts.consensus === undefined ? "EPS 1.00" : opts.consensus,
        `${source}:${opts.symbol}:${date}`,
        opts.superseded ?? 0,
      ).lastInsertRowid,
  );
}

function seedIntel(eventId: number, impliedMovePct: number) {
  db.prepare(
    `INSERT INTO earnings_intel (event_id, implied_move_pct, implied_method, computed_at)
     VALUES (?, ?, 'straddle', datetime('now'))`,
  ).run(eventId, impliedMovePct);
}

// ── renderTodaysReportersBlock (pure) ────────────────────────────────

describe("renderTodaysReportersBlock", () => {
  it("returns null for an empty day (off-season auto-quiet)", () => {
    expect(renderTodaysReportersBlock([])).toBeNull();
  });

  it("renders a markdown table with slot+time, symbol, chip, consensus, implied move", () => {
    const rows: ReporterRowView[] = [
      { slot: "BMO", time: "08:00", symbol: "TSM", chip: "held", cons: "$3.80", impl: "±4.0%" },
      { slot: "AMC", time: "16:15", symbol: "NFLX", chip: "", cons: "$0.80 · $12.84B", impl: null },
    ];
    const block = renderTodaysReportersBlock(rows)!;
    expect(block).toContain("## Today's reporters");
    expect(block).toContain("| BMO 08:00 | TSM | held | $3.80 | ±4.0% |");
    // Empty chip / missing impl render as em-dash, never blank cells.
    expect(block).toContain("| AMC 16:15 | NFLX | — | $0.80 · $12.84B | — |");
  });

  it("omits the time when unknown (slot-only cell)", () => {
    const rows: ReporterRowView[] = [
      { slot: "TBD", time: null, symbol: "XYZ", chip: "wl", cons: null, impl: null },
    ];
    const block = renderTodaysReportersBlock(rows)!;
    expect(block).toContain("| TBD | XYZ | wl | — | — |");
  });
});

// ── composeTodaysReportersBlock (Mac assembly) ───────────────────────

describe("composeTodaysReportersBlock", () => {
  it("returns null when nothing reports today", () => {
    seedEvent({ symbol: "AAPL", date: "2026-07-30" }); // future, not today
    expect(composeTodaysReportersBlock(db, { today: TODAY })).toBeNull();
  });

  it("lists today's reporters with held chip, compact consensus, and cached implied move", () => {
    const acct = seedAccount();
    const tsm = seedSecurity("TSM");
    seedHolding(acct, tsm, 100);
    const eventId = seedEvent({
      symbol: "TSM",
      releaseTime: "08:00",
      consensus: "EPS 3.80",
    });
    seedIntel(eventId, 4.02);

    const block = composeTodaysReportersBlock(db, { today: TODAY })!;
    expect(block).toContain("## Today's reporters");
    expect(block).toContain("| BMO 08:00 | TSM | held | $3.80 | ±4.0% |");
  });

  it("chips: held wins over watchlist; watchlist → wl; read-through → rt; else —", () => {
    const acct = seedAccount();
    const held = seedSecurity("HELD");
    seedHolding(acct, held, 50);
    const wl = seedSecurity("WATCH");
    db.prepare(`INSERT INTO watchlist (security_id, is_active) VALUES (?, 1)`).run(wl);
    // read-through pair: RTREP reports, we hold TGT
    const tgt = seedSecurity("TGT");
    seedHolding(acct, tgt, 10);
    db.prepare(
      `INSERT INTO read_through_pairs (reporter_symbol, target_symbol, weight, hypothesis)
       VALUES ('RTREP', 'TGT', 1.0, 'test')`,
    ).run();

    seedEvent({ symbol: "HELD", releaseTime: "08:00" });
    seedEvent({ symbol: "WATCH", releaseTime: "08:05" });
    seedEvent({ symbol: "RTREP", releaseTime: "08:10" });
    seedEvent({ symbol: "NOPOS", releaseTime: "08:15" });

    const block = composeTodaysReportersBlock(db, { today: TODAY })!;
    expect(block).toMatch(/\| HELD \| held \|/);
    expect(block).toMatch(/\| WATCH \| wl \|/);
    expect(block).toMatch(/\| RTREP \| rt \|/);
    expect(block).toMatch(/\| NOPOS \| — \|/);
  });

  it("inherits the Hub's dedup: one row per print even with finnhub+nasdaq sources", () => {
    seedEvent({ symbol: "DUP", source: "finnhub", consensus: "EPS 2.00" });
    seedEvent({ symbol: "DUP", source: "nasdaq", consensus: "EPS 1.90" });

    const block = composeTodaysReportersBlock(db, { today: TODAY })!;
    const occurrences = block.split("DUP").length - 1;
    expect(occurrences).toBe(1);
    expect(block).toContain("$2.00"); // finnhub-preferred row wins
  });

  it("sorts BMO before AMC before TBD, then by release time", () => {
    seedEvent({ symbol: "LATE", releaseTime: "16:15" });
    seedEvent({ symbol: "EARLY", releaseTime: "08:00" });
    seedEvent({ symbol: "NOTIME", releaseTime: null });
    seedEvent({ symbol: "MID", releaseTime: "08:30" });

    const block = composeTodaysReportersBlock(db, { today: TODAY })!;
    const order = ["EARLY", "MID", "LATE", "NOTIME"].map((s) => block.indexOf(`| ${s} |`));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("derives AMC from event_time when release_time is absent", () => {
    seedEvent({ symbol: "AMCONLY", releaseTime: null, eventTime: "amc" });
    const block = composeTodaysReportersBlock(db, { today: TODAY })!;
    expect(block).toContain("| AMC | AMCONLY |");
  });

  it("ticker 'BMO' (Bank of Montreal) with an After-Market title classifies AMC, not BMO", () => {
    // Titles carry the ticker; slot matching must use phrases only —
    // "BMO earnings (After Market Close)" contains the string "BMO".
    seedEvent({ symbol: "BMO", releaseTime: null, eventTime: null });
    // seedEvent titles are "<symbol> earnings"; craft the collision directly:
    db.prepare(`UPDATE calendar_events SET title = 'BMO earnings (After Market Close)' WHERE symbol = 'BMO'`).run();
    const block = composeTodaysReportersBlock(db, { today: TODAY })!;
    expect(block).toContain("| AMC | BMO |");
  });

  it("renders — for consensus when the row has none (never a raw Finnhub blob)", () => {
    seedEvent({ symbol: "NOCONS", consensus: null });
    const block = composeTodaysReportersBlock(db, { today: TODAY })!;
    expect(block).toMatch(/\| NOCONS \| — \| — \| — \|/);
  });

  it("never throws: a broken table logs a warning and returns null", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.prepare("DROP TABLE calendar_events").run();
    expect(composeTodaysReportersBlock(db, { today: TODAY })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("consensus precedence (effectiveConsensus parity)", () => {
  // 7/28 overnight-land review follow-up: the block read bare
  // consensus_estimate, so an enrichment-corrected consensus_value (the same
  // precedence renderHeadlineTable and the Today tab already apply) never
  // reached the morning email — a superseded street number shipped instead.
  it("prefers consensus_value over consensus_estimate in the rendered block", () => {
    const eventId = seedEvent({ symbol: "KRC", consensus: "EPS 0.41" });
    db.prepare(
      `UPDATE calendar_events SET consensus_value = 'EPS 0.54' WHERE id = ?`,
    ).run(eventId);

    const block = composeTodaysReportersBlock(db, { today: TODAY });
    expect(block).toContain("$0.54");
    expect(block).not.toContain("$0.41");
  });

  it("falls back to consensus_estimate when consensus_value is absent", () => {
    seedEvent({ symbol: "KRC", consensus: "EPS 0.41" });
    const block = composeTodaysReportersBlock(db, { today: TODAY });
    expect(block).toContain("$0.41");
  });
});
