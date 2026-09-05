/**
 * Whole-branch review M1 (= R-F27) — the `consensus_row` prepare step wrote
 * the vendor (Finnhub) bogey through `upsertBogey` directly, so a live
 * print's sheet did not pick up the vendor revenue number until the next
 * document parse re-derived it. The fix swaps the write to
 * `saveBogeyWithRecompile`, which re-derives the event's live print sheet in
 * the SAME transaction as the bogey write.
 *
 * D1 (unchanged by this fix): the vendor EPS goes to `eps_consensus_vendor`,
 * never `eps_consensus`, so it never feeds `eps_adj_q`'s expected value —
 * only `revenue_consensus_usd` reaches a compiled contract (`revenue_q`).
 * These tests assert the sheet gains the `revenue_q` line's expected value
 * right after the step runs, with no parse involved at all.
 *
 * Every identifier here is synthetic (XMPL3, fixed symbols): the repo is
 * public.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { consensusRowStep } from "@/lib/earnings/prepare-steps/consensus-row";

const RAW = JSON.stringify({
  entry: { symbol: "XMPL3", date: "2026-09-10", hour: "", quarter: 3, year: 2026, epsEstimate: 0.55, epsActual: null, revenueEstimate: 1_250_000_000, revenueActual: null },
  history: [],
  finnhub_symbol: "XMPL3",
});

const ctx = { now: () => Date.now(), signal: new AbortController().signal };

let db: Database.Database;
let seq = 0;

/** `calendar_events.source_key` is UNIQUE NOT NULL (migration 013) — the
 *  counter keeps it unique across the seeds inside a single test. */
function seedEvent(): number {
  seq += 1;
  return Number(
    db.prepare(
      `INSERT INTO calendar_events (source, event_type, event_date, event_time, title, source_key, symbol, raw_json)
       VALUES ('finnhub','earnings','2026-09-10','AMC','XMPL3 Q3', ?, 'XMPL3', ?)`,
    ).run(`finnhub:XMPL3:earnings:2026-09-10:${seq}`, RAW).lastInsertRowid,
  );
}

function seedPrint(eventId: number, state: string): number {
  return Number(
    db.prepare(
      `INSERT INTO print_watch_prints (event_id, symbol, event_date, state) VALUES (?, 'XMPL3', '2026-09-10', ?)`,
    ).run(eventId, state).lastInsertRowid,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("consensus_row step recompiles the live print's sheet (M1)", () => {
  it("a live print's revenue_q line gains the vendor consensus right after the write, before any parse", async () => {
    const eventId = seedEvent();
    const printId = seedPrint(eventId, "window_open");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM print_watch_lines`).get()).toEqual({ n: 0 });

    const result = await consensusRowStep.run(db, eventId, ctx);
    expect(result).toEqual({ status: "done" });

    const bogeyRow = db
      .prepare(`SELECT eps_consensus, eps_consensus_vendor, revenue_consensus_usd FROM earnings_bogeys WHERE event_id = ? AND source = 'finnhub'`)
      .get(eventId) as { eps_consensus: number | null; eps_consensus_vendor: number; revenue_consensus_usd: number };
    expect(bogeyRow.eps_consensus).toBeNull();               // D1: never the adjusted-EPS bogey
    expect(bogeyRow.eps_consensus_vendor).toBe(0.55);
    expect(bogeyRow.revenue_consensus_usd).toBe(1_250_000_000);

    // The revenue_q line — with the vendor number attached — is on the
    // sheet NOW, with zero documents parsed and zero watcher ticks.
    const line = db
      .prepare(`SELECT state, expected_json FROM print_watch_lines WHERE print_id = ? AND metric_id = 'revenue_q'`)
      .get(printId) as { state: string; expected_json: string } | undefined;
    expect(line).toBeDefined();
    expect(line!.state).toBe("pending");
    expect(JSON.parse(line!.expected_json)).toMatchObject({ value: 1_250_000_000 });
  });

  it("with NO live print for the event, the write still succeeds and nothing throws", async () => {
    const eventId = seedEvent();
    // Deliberately no seedPrint call: the ordinary case (most events never arm).

    const result = await consensusRowStep.run(db, eventId, ctx);
    expect(result).toEqual({ status: "done" });

    const bogeyRow = db
      .prepare(`SELECT revenue_consensus_usd FROM earnings_bogeys WHERE event_id = ? AND source = 'finnhub'`)
      .get(eventId) as { revenue_consensus_usd: number };
    expect(bogeyRow.revenue_consensus_usd).toBe(1_250_000_000);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM print_watch_lines`).get()).toEqual({ n: 0 });
  });
});
